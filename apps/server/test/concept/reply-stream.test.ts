/**
 * 설계 추가: 컨셉 답변 스트리밍 + 답변 중 전송 막기.
 * Real llm gateway → real Claude adapter → scripted Messages API streaming the ConceptTurnProposal JSON in chunks;
 * the SSE route relays reply_text deltas, `done {messageId}` after the commit; the web POST answers 409 while a
 * turn is in flight; stop-turn cancels it.
 */
import { request as httpRequest } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { conceptInternals } from "../../src/modules/concept/module.js";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { conceptHarness, installConceptStubs } from "./support.js";

let t: TestCore;
beforeAll(async () => {
  t = await createTestCore();
  installConceptStubs(t);
  conceptInternals(t.modules.concept.service).ports.modelCalls = () => t.modules.llm.service.modelCalls;
});
afterAll(() => t.close());

interface Sse {
  events: Array<{ event: string; data: any }>;
  headers: Headers;
  status: number;
  closed: Promise<void>;
  waitFor(pred: (evs: Sse["events"]) => boolean, ms?: number): Promise<void>;
  abort(): void;
}

async function openSse(path: string): Promise<Sse> {
  const ac = new AbortController();
  const res = await fetch(`${t.base}${path}`, { signal: ac.signal, headers: { accept: "text/event-stream" } });
  const events: Sse["events"] = [];
  const waiters: Array<() => void> = [];
  const closed = (async () => {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (ev) events.push({ event: ev, data: data ? JSON.parse(data) : null });
          waiters.splice(0).forEach((w) => w());
        }
      }
    } catch {
      /* aborted */
    }
    waiters.splice(0).forEach((w) => w());
  })();
  let ended = false;
  void closed.then(() => (ended = true));
  return {
    events,
    headers: res.headers,
    status: res.status,
    closed,
    abort: () => ac.abort(),
    async waitFor(pred, ms = 10_000) {
      const until = Date.now() + ms;
      while (!pred(events)) {
        if (ended) throw new Error(`stream ended before condition: ${JSON.stringify(events)}`);
        if (Date.now() > until) throw new Error(`timeout: ${JSON.stringify(events)}`);
        await new Promise<void>((ok) => {
          waiters.push(ok);
          setTimeout(ok, 50);
        });
      }
    },
  };
}

const deltas = (evs: Sse["events"]) => evs.filter((e) => e.event === "delta").map((e) => e.data.text as string);
/** text a client shows: deltas after the last reset */
const shown = (evs: Sse["events"]) => {
  let s = "";
  for (const e of evs) s = e.event === "reset" ? "" : e.event === "delta" ? s + e.data.text : s;
  return s;
};

/** the model asks the slot the code selected (3.5) → its reply_text is the message body */
const GENRE_Q = { slot_key: "category.genre_label", ask_text: "장르는요?", options: [] };
const REPLY = '좋아요! "회귀한 짐꾼" 이야기네요.\n주인공이 처음 잃은 것은 무엇인가요? 😀';

describe("concept reply streaming (SSE) + send lock", () => {
  it("streams reply_text progressively, late joiners catch up, done carries the persisted message; 409 while in flight", async () => {
    const novel = await t.modules.novel.service.createNovel({}, t.owner);
    const h = await conceptHarness(t, novel.id, []);
    const s = await h.session();
    const base = `/api/novels/${novel.id}/concept/sessions/${s.id}`;
    const hub = conceptInternals(t.modules.concept.service).streams;

    // nothing in flight → the stream ends at once
    const idle = await openSse(`${base}/stream`);
    await idle.closed;
    expect(idle.status).toBe(200);
    expect(idle.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(idle.headers.get("cache-control")).toContain("no-cache");
    expect(idle.headers.get("x-accel-buffering")).toBe("no");
    expect(idle.events.map((e) => e.event)).toEqual(["reset", "done"]);
    expect(idle.events[1]!.data).toEqual({ messageId: null });

    // questions are a later key: reply_text first, as the prompt asks
    t.claude.reply({ when: { schemaHas: ["reply_text", "slot_updates"] }, json: { reply_text: REPLY, questions: [GENRE_Q], user_intent: "answer" }, chunkSize: 6, chunkDelayMs: 25 });
    const post = await t.http("POST", `${base}/messages`, { body: "회귀한 짐꾼 이야기" });
    expect(post.status).toBe(201);
    expect(post.body.taskId).toBeTruthy();

    // a second send (other tab / double click) is refused while the turn is in flight
    const dup = await t.http("POST", `${base}/messages`, { body: "하나 더" });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("concept_turn_in_flight");

    const a = await openSse(`${base}/stream`);
    const leaver = await openSse(`${base}/stream`);
    const running = h.run();
    await a.waitFor((evs) => deltas(evs).length >= 3);
    leaver.abort(); // client disconnect mid-stream
    const late = await openSse(`${base}/stream`);
    await late.waitFor((evs) => evs.some((e) => e.event === "delta"));
    // the late joiner's first delta is the accumulated text so far
    expect(late.events[0]!.event).toBe("reset");
    expect(late.events[1]!.data.text.length).toBeGreaterThan(deltas(a.events)[0]!.length);
    expect(REPLY.startsWith(late.events[1]!.data.text)).toBe(true);

    await running;
    await Promise.all([a.closed, late.closed]);
    expect(t.claude.unmatched).toHaveLength(0);
    const agent = await h.lastAgent();
    for (const sse of [a, late]) {
      expect(shown(sse.events)).toBe(REPLY);
      expect(sse.events[sse.events.length - 1]).toEqual({ event: "done", data: { messageId: agent.id } });
    }
    expect(deltas(a.events).length).toBeGreaterThan(5);
    expect(agent.body.startsWith(REPLY)).toBe(true); // persisted = validated final output (+ code-added lines)
    expect(hub.listeners(s.id)).toBe(0);
    expect((await h.session()).inFlightTaskId).toBeNull();

    // after the turn the next message is accepted again
    t.claude.reply({ when: { schemaHas: ["reply_text"] }, json: { reply_text: "다음 질문입니다." } });
    expect((await t.http("POST", `${base}/messages`, { body: "주인공은 짐꾼" })).status).toBe(201);
    await h.run();
  });

  it("stop-turn cancels the in-flight turn: no reply is committed, the stream ends, sending works again", async () => {
    const novel = await t.modules.novel.service.createNovel({}, t.owner);
    const h = await conceptHarness(t, novel.id, []);
    const s = await h.session();
    const base = `/api/novels/${novel.id}/concept/sessions/${s.id}`;
    t.claude.reply({ when: { schemaHas: ["reply_text"] }, json: { reply_text: "멈출 답변입니다. 길게 이어집니다." }, chunkSize: 3, chunkDelayMs: 40 });
    const post = await t.http("POST", `${base}/messages`, { body: "멈춰 볼게요" });
    const sse = await openSse(`${base}/stream`);
    const running = h.run();
    await sse.waitFor((evs) => deltas(evs).length >= 1);
    const stopped = await t.http("POST", `${base}/stop-turn`, {});
    expect(stopped.status).toBe(200);
    expect(stopped.body.inFlightTaskId).toBeNull();
    await sse.closed;
    expect(sse.events[sse.events.length - 1]).toEqual({ event: "done", data: { messageId: null } });
    await running;
    const task = await t.modules.orchestration.service.getTask(h.scope, post.body.taskId);
    expect(task.status).toBe("cancelled");
    const msgs = await h.messages();
    expect(msgs.filter((m) => m.authorKind === "agent")).toHaveLength(0);
    expect(msgs[msgs.length - 1]!.body).toContain("답변을 멈췄습니다");
    // idempotent, and the next message is accepted (it carries the unanswered one into the next turn)
    expect((await t.http("POST", `${base}/stop-turn`, {})).status).toBe(200);
    t.claude.reply({ when: { prompt: "멈춰 볼게요" }, json: { reply_text: "이어서 답합니다.", questions: [GENRE_Q] } });
    expect((await t.http("POST", `${base}/messages`, { body: "다시 해 주세요" })).status).toBe(201);
    await h.run();
    expect((await h.lastAgent()).body).toContain("이어서 답합니다.");
  });

  it("a turn cancelled outside stop-turn (task board) ends the stream, clears inFlightTaskId and counts its cost", async () => {
    const novel = await t.modules.novel.service.createNovel({}, t.owner);
    const h = await conceptHarness(t, novel.id, []);
    const s = await h.session();
    const base = `/api/novels/${novel.id}/concept/sessions/${s.id}`;
    t.claude.reply({ when: { schemaHas: ["reply_text"] }, json: { reply_text: "작업 보드에서 취소될 답변입니다. 길게 이어집니다." }, chunkSize: 3, chunkDelayMs: 30 });
    const post = await t.http("POST", `${base}/messages`, { body: "취소해 볼게요" });
    const sse = await openSse(`${base}/stream`);
    const running = h.run();
    await sse.waitFor((evs) => deltas(evs).length >= 1);
    // the board's cancel only sets cancel_requested: the run stops at its next safe point, without the commit
    await t.platform.uow.run((tx) => t.modules.orchestration.service.cancelTask(tx, h.scope, post.body.taskId, t.owner));
    await running;
    await sse.closed;
    expect(sse.events[sse.events.length - 1]).toEqual({ event: "done", data: { messageId: null } });
    expect((await t.modules.orchestration.service.getTask(h.scope, post.body.taskId)).status).toBe("cancelled");
    const after = await h.session();
    expect(after.inFlightTaskId).toBeNull(); // the web unlocks (it locks on inFlightTaskId)
    const [ledger] = await t.testDb.query<{ total: string | null }>(`SELECT sum(amount_micros)::text AS total FROM cost_events WHERE novel_id='${novel.id}'`);
    expect(Number(ledger?.total ?? 0)).toBeGreaterThan(0);
    expect(after.spentMicros).toBe(Number(ledger?.total ?? 0)); // the session budget sees the spent call
    expect((await h.messages()).filter((m) => m.authorKind === "agent")).toHaveLength(0);
    // a late joiner after the cancel gets the end at once
    const late = await openSse(`${base}/stream`);
    await late.closed;
    expect(late.events.map((e) => e.event)).toEqual(["reset", "done"]);
  });

  it("the stream route is behind the host guard and 404s for an unknown session", async () => {
    const novel = await t.modules.novel.service.createNovel({}, t.owner);
    const url = new URL(`${t.base}/api/novels/${novel.id}/concept/sessions/cns_00000000000000000000000000/stream`);
    expect((await fetch(url)).status).toBe(404);
    const status = await new Promise<number>((ok, fail) => {
      const req = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, headers: { host: "evil.example" } }, (res) => {
        res.resume();
        ok(res.statusCode ?? 0);
      });
      req.on("error", fail);
      req.end();
    });
    expect(status).toBe(403);
  });
});
