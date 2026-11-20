/**
 * 설계 추가 0018: 화별 수정 대화 (module revision) + 한 화씩 진행 (sequential approval) on the in-process core with the
 * scripted Claude mock. Episode 1 of a scripted novel reaches awaiting_approval (support/pipeline-script.ts); the chat
 * turns are scripted per test (`reply_text` + `diagnosis_kind` schema keys).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "@ncs/db/orm";
import { approvals, episodeAuthorNotes, revisionChatProposals } from "@ncs/db/schema";
import { handleLeakIssue } from "../../src/modules/agents/index.js";
import type { ClaudeRequest } from "../support/scripted-claude.js";
import { scriptPipeline } from "../support/pipeline-script.js";
import { bindChat, CHAT, createTgEnv, flushOutbox, type TgEnv } from "../messaging/setup.js";
import { pipelineHelpers } from "./harness.js";

let env: TgEnv;
let h: ReturnType<typeof pipelineHelpers>;
let scope: { novelId: string };
let novelId: string;
const CHAT_SCHEMA = { schemaHas: ["reply_text", "diagnosis_kind"] };

beforeAll(async () => {
  env = await createTgEnv();
  scriptPipeline(env.t.claude);
  h = pipelineHelpers(env.t);
  const r = await h.novelWithEpisodeAwaiting();
  scope = r.scope;
  novelId = r.novel.id;
}, 120_000);
afterAll(() => env.t.close());

const t = () => env.t;
const api = (method: string, path: string, body?: unknown) => t().http(method, `/api/novels/${novelId}/episodes/1/revision-chat${path}`, body);
const chatRequests = () => t().claude.requests.filter((r) => "reply_text" in ((r.schema?.properties ?? {}) as object));
const reply = (json: unknown | ((r: ClaudeRequest) => unknown), times = 1) => t().claude.reply({ when: CHAT_SCHEMA, times, json });
const turn = async () => {
  await t().modules.orchestration.service.runOnce();
  return (await api("GET", "")).body;
};
const current = async () => {
  const ep = await h.ms().getEpisodeByNo(scope, 1);
  return { ep, v: await h.ms().getVersion(scope, ep.currentVersionId!) };
};
/** sentences that occur exactly once in the text */
const uniqueSentences = (text: string) => [...new Set(text.split(/(?<=[.!?。])\s+/u).map((s) => s.trim()))].filter((s) => s.length > 15 && text.indexOf(s) === text.lastIndexOf(s));

describe("한 화씩 진행 (sequential approval)", () => {
  it("episode 2 is not started while episode 1 waits for approval; home shows the waiting line", async () => {
    await h.drain(scope);
    const ep2 = await h.ms().getEpisodeByNo(scope, 2);
    expect(ep2.status).toBe("planned");
    expect(await t().modules.orchestration.service.listTasks(scope, { kinds: ["outline_episode"], episodeId: ep2.id, includeCancelled: true })).toHaveLength(0);
    const sched = await h.ms().schedule(scope);
    expect(sched.notes).toContain("sequential_wait:1");
    const home = await t().http("GET", `/api/novels/${novelId}/home`);
    expect(home.body.sequential).toEqual({ enabled: true, waitingEpisodeNo: 1, nextEpisodeNo: 2 });
    expect(home.body.novel.sequentialEpisodes).toBe(true);
  });

  it("awaiting_approval raises the inbox approval with read / chat links and notifies the messenger", async () => {
    const [ap] = await t().testDb.db.select().from(approvals).where(and(eq(approvals.novelId, novelId), eq(approvals.approvalType, "episode"), eq(approvals.status, "pending")));
    expect(ap).toBeTruthy();
    const q = await t().modules.hitl.service.getQuestionView(scope, ap!.questionId);
    expect(q.title).toBe("1화 승인 요청");
    expect(q.body).toContain("1화를 읽고 승인해 주세요. 승인하면 2화를 씁니다.");
    expect(q.body).toContain(`/novels/${novelId}/read/1`);
    expect(q.body).toContain(`/novels/${novelId}/episodes/1?mode=chat`);
    // a messenger channel bound now still gets the open approval on the next dispatcher pass
    await bindChat(env, novelId, CHAT + 4242);
    await t().modules.hitl.service.runDispatcherOnce();
    await flushOutbox(env);
    const sent = env.fake.calls.filter((c) => c.method === "sendMessage" && String(c.params.text ?? "").includes("읽고 승인해 주세요"));
    expect(sent.length).toBeGreaterThan(0);
  });
});

describe("한 화씩 진행: rework", () => {
  it("rejection / rework of episode 1 keeps episode 2 waiting until it is approved", async () => {
    const ep1 = await h.ms().getEpisodeByNo(scope, 1);
    await h.decide(scope, "episode", ep1.id, "rejected", { note: "마지막 장면을 더 긴장감 있게", reworkFrom: "polish" });
    expect((await h.ms().getEpisodeByNo(scope, 1)).status).toBe("revising");
    const sched = await h.ms().schedule(scope);
    expect(sched.createdTasks.filter((x) => x.kind === "outline_episode")).toHaveLength(0);
    await h.drain(scope, async () => (await h.ms().getEpisodeByNo(scope, 1)).status === "awaiting_approval", 100);
    const ep2 = await h.ms().getEpisodeByNo(scope, 2);
    expect(ep2.status).toBe("planned");
    expect(await t().modules.orchestration.service.listTasks(scope, { kinds: ["outline_episode"], episodeId: ep2.id, includeCancelled: true })).toHaveLength(0);
  });
});

describe("화별 수정 대화", () => {
  it("why-question: the turn sees outline and sources; multi-turn history; 409 while a turn is in flight", async () => {
    const { v } = await current();
    const quote = uniqueSentences(v.content)[0]!;
    const start = v.content.indexOf(quote);
    const first = await api("POST", "/messages", { body: "왜 이렇게 썼어?", anchor: { versionId: v.id, quote, start, end: start + quote.length } });
    expect(first.status).toBe(201);
    // one turn at a time
    const busy = await api("POST", "/messages", { body: "하나 더" });
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe("revision_turn_in_flight");
    reply((r: ClaudeRequest) => {
      expect(r.prompt).toContain("아웃라인 요약"); // outline / plan of the episode
      expect(r.prompt).toContain("새벽 여관 방에서 한결이 눈을 뜬다"); // outline scene
      expect(r.prompt).toContain("생성 기록");
      expect(r.prompt).toContain(quote);
      return { reply_text: "아웃라인 1번 씬(새벽 여관 방에서 눈을 뜬다)을 따라 썼습니다.", diagnosis_kind: "explanation_only", sources: [{ kind: "outline", ref_id: null, quote: "새벽 여관 방에서 한결이 눈을 뜬다." }], question: { text: "그대로 둘까요?", options: ["그대로 둔다", "고친다"] }, proposals: [] };
    });
    let view = await turn();
    expect(view.turn).toBeNull();
    expect(view.messages.map((m: { authorKind: string }) => m.authorKind)).toEqual(["user", "agent"]);
    expect(view.messages[0].anchor.quote).toBe(quote);
    expect(view.messages[1].sources[0].kind).toBe("outline");
    expect(view.messages[1].diagnosisKind).toBe("explanation_only");
    expect(view.messages[1].question.options).toEqual(["그대로 둔다", "고친다"]);

    // second turn: no source → the stored reply says so
    expect((await api("POST", "/messages", { body: "그럼 손등 흉터 색은 어디서 나온 거야?" })).status).toBe(201);
    reply((r: ClaudeRequest) => {
      const roles = r.messages.map((m) => m.role);
      expect(roles.slice(-3)).toEqual(["user", "assistant", "user"]);
      expect(r.messages.at(-3)!.content).toContain("왜 이렇게 썼어?");
      expect(r.messages.at(-2)!.content).toContain("아웃라인 1번 씬");
      expect(r.messages.at(-1)!.content).toContain("흉터 색");
      return { reply_text: "흉터 색은 설정이나 아웃라인에 없습니다.", diagnosis_kind: "explanation_only", sources: [{ kind: "none", ref_id: null, quote: null }], question: null, proposals: [] };
    });
    view = await turn();
    expect(view.messages).toHaveLength(4);
    expect(view.messages[3].body).toContain("근거 없이 쓴 부분");
    expect(chatRequests()).toHaveLength(2);
    // the run is on the task board (budget accounted per run like every agent task)
    const tasks = await t().modules.orchestration.service.listTasks(scope, { kinds: ["revision_chat_turn"] });
    expect(tasks.every((x) => x.status === "done" && x.agentRole === "line_editor")).toBe(true);
  });

  it("patch validation: a missing quote and a too-large patch are dropped after the repair rounds", async () => {
    const { v } = await current();
    const big = v.content.slice(0, Math.ceil(v.content.length * 0.3));
    expect((await api("POST", "/messages", { body: "첫 장면을 고쳐 줘" })).status).toBe(201);
    reply(
      {
        reply_text: "이렇게 고쳐 보았습니다.",
        diagnosis_kind: "style",
        sources: [],
        question: null,
        proposals: [
          { kind: "text_patch", patches: [{ quote: "원고에 없는 문장입니다.", replacement: "새 문장", reason: "x" }], fact_id: null, new_value: null, reason: "" },
          { kind: "text_patch", patches: [{ quote: big, replacement: "짧게", reason: "전체를 줄임" }], fact_id: null, new_value: null, reason: "" },
        ],
      },
      3,
    );
    const view = await turn();
    expect(view.messages.at(-1).body).toBe("이렇게 고쳐 보았습니다.");
    expect(view.proposals.filter((p: { kind: string }) => p.kind === "text_patch")).toHaveLength(0);
    const repairs = chatRequests().slice(-2);
    expect(repairs[0]!.messages.at(-1)!.content).toContain("원고에 그대로 나오지 않습니다");
    expect(repairs[0]!.messages.at(-1)!.content).toContain("25%");
  });

  it("설계 추가 0026: a handle symbol in the reply or a replacement is sent back; only a symbol the author typed may stay in the reply body", async () => {
    const { v } = await current();
    const quote = uniqueSentences(v.content)[0]!;
    expect((await api("POST", "/messages", { body: "본문의 E9가 누구인지 알려 주고 고쳐 줘" })).status).toBe(201);
    const before = chatRequests().length;
    let n = 0;
    reply((r: ClaudeRequest) => {
      expect(r.system).toContain("E와 숫자로 된 기호는 이름이 아닙니다");
      return {
        reply_text: n++ === 0 ? "E9와 E7은 같은 인물입니다." : "E9는 한결을 가리킵니다.",
        diagnosis_kind: "style",
        sources: [{ kind: "plan", ref_id: null, quote: "E7이 눈을 뜬다" }],
        question: null,
        proposals: [{ kind: "text_patch", patches: [{ quote, replacement: "E7은 눈을 떴다.", reason: "이름 정리" }], fact_id: null, new_value: null, reason: "" }],
      };
    }, 3);
    const view = await turn();
    const calls = chatRequests().slice(before);
    expect(calls).toHaveLength(3);
    const critique = calls[1]!.messages.at(-1)!.content;
    expect(critique).toContain("답변 reply_text");
    expect(critique).toContain(handleLeakIssue(["E7"])); // E9 (typed by the author) is not reported
    expect(critique).toContain("proposals[0].patches[0] replacement");
    expect(calls[2]!.messages.at(-1)!.content).not.toContain("답변 reply_text");
    const msg = view.messages.at(-1);
    expect(msg.body).toBe("E9는 한결을 가리킵니다.");
    expect(msg.sources).toEqual([{ kind: "plan", refId: null, quote: null }]); // the quote with a symbol is not stored
    expect(view.proposals.filter((p: { kind: string; status: string }) => p.kind === "text_patch" && p.status === "pending")).toHaveLength(0);
  });

  it("partial accept creates a human-accepted revision version and re-runs extraction; a stale proposal is never applied", async () => {
    const { v, ep } = await current();
    const [s1, s2, s3] = uniqueSentences(v.content);
    expect((await api("POST", "/messages", { body: "두 문장을 고쳐 줘" })).status).toBe(201);
    reply({
      reply_text: "두 곳을 고쳤습니다.",
      diagnosis_kind: "style",
      sources: [],
      question: null,
      proposals: [
        { kind: "text_patch", patches: [{ quote: s1, replacement: `${s1} (고침)`, reason: "리듬" }, { quote: s2, replacement: `${s2} (고침2)`, reason: "리듬" }], fact_id: null, new_value: null, reason: "" },
        { kind: "text_patch", patches: [{ quote: s3, replacement: `${s3} (고침3)`, reason: "다른 제안" }], fact_id: null, new_value: null, reason: "" },
      ],
    });
    let view = await turn();
    const [p1, p2] = view.proposals.filter((p: { kind: string; status: string }) => p.kind === "text_patch" && p.status === "pending");
    expect(p1.payload.patches).toHaveLength(2);
    expect(view.canPatch).toBe(true);
    expect(view.patchWarning).toContain("승인 요청이 닫히고");

    const acc = await api("POST", `/proposals/${p1.id}/decision`, { decision: "accepted", patchIdx: [0] });
    expect(acc.status, JSON.stringify(acc.body)).toBe(200);
    const done = acc.body.proposals.find((p: { id: string }) => p.id === p1.id);
    expect(done.status).toBe("accepted");
    const nv = await h.ms().getVersion(scope, done.resultVersionId);
    expect(nv.kind).toBe("revision");
    expect(nv.isHumanEdit).toBe(true);
    expect(nv.content).toContain(`${s1} (고침)`);
    expect(nv.content).not.toContain("(고침2)"); // partial accept
    expect((nv.attributionSpans as Array<{ actorType: string }>).some((x) => x.actorType === "user")).toBe(true);
    expect((nv.writerAnnotations as { revision_chat: { proposalIds: string[] } }).revision_chat.proposalIds).toEqual([p1.id]);
    const after = await h.ms().getEpisode(scope, ep.id);
    expect(after.status).toBe("checking");
    expect(after.currentVersionId).toBe(nv.id);
    const split = await t().modules.orchestration.service.listTasks(scope, { kinds: ["split_scenes"], episodeId: ep.id });
    expect(split.some((x) => (x.input as { manuscript_version_id?: string }).manuscript_version_id === nv.id)).toBe(true);
    await t().modules.orchestration.service.runOnce();
    const extract = await t().modules.orchestration.service.listTasks(scope, { kinds: ["extract_facts"], episodeId: ep.id, includeCancelled: true });
    expect(extract.some((x) => (x.input as { manuscript_version_id?: string }).manuscript_version_id === nv.id)).toBe(true);
    const actions = (await t().modules.audit.service.list(scope, { actionPrefix: "revision_chat." })).items.map((e) => e.action);
    expect(actions).toContain("revision_chat.proposal_accepted");

    // p2's quote still fits the new text → stays pending; the author edits that sentence away → accepting it goes stale
    view = (await api("GET", "")).body;
    expect(view.proposals.find((p: { id: string }) => p.id === p2.id).status).toBe("pending");
    const cur = await current();
    await h.ms().saveHumanEdit(scope, 1, { content: cur.v.content.replace(s3!, "작가가 직접 바꾼 문장."), baseVersionId: cur.v.id }, t().owner);
    const stale = await api("POST", `/proposals/${p2.id}/decision`, { decision: "accepted" });
    expect(stale.status).toBe(200);
    expect(stale.body.proposals.find((p: { id: string }) => p.id === p2.id).status).toBe("stale");
    expect((await current()).v.content).not.toContain("(고침3)");
  });

  it("setting change on an approved fact goes to a canon_change approval; approving swaps the fact", async () => {
    expect((await api("POST", "/messages", { body: "주인공 나이를 바꾸자. 바로 제안해 줘." })).status).toBe(201);
    let factId = "";
    reply((r: ClaudeRequest) => {
      factId = /\[F:(fct_[0-9A-HJKMNP-TV-Z]{26})\] \(승인\) 한결 — 나이/.exec(r.prompt)![1]!;
      // the history carries earlier questions, proposals and how the author decided them
      const hist = r.messages.map((m) => m.content).join("\n");
      expect(hist).toContain("질문: 그대로 둘까요?");
      expect(hist).toMatch(/\[제안: 본문 수정 ".+" → ".+\(고침\)" — 적용됨\]/);
      expect(hist).toMatch(/\(고침2\)" — 적용 안 함\]/);
      expect(hist).toMatch(/\(고침3\)" — 원고가 바뀜\]/);
      return {
        reply_text: "나이 설정을 바꾸는 제안입니다.",
        diagnosis_kind: "setting_questionable",
        sources: [{ kind: "fact", ref_id: factId, quote: null }],
        question: null,
        proposals: [
          { kind: "setting_change", patches: [], fact_id: factId, new_value: "29세", reason: "작가 요청" },
          { kind: "setting_change", patches: [], fact_id: factId, new_value: "31세", reason: "다른 안" },
        ],
      };
    });
    let view = await turn();
    const [sp, sp2] = view.proposals.filter((p: { kind: string; status: string }) => p.kind === "setting_change" && p.status === "pending");
    expect(sp.payload.needsApproval).toBe(true);
    expect(view.proposals.some((p: { kind: string }) => p.kind === "impact_note")).toBe(true);
    // the 31세 request first; the 29세 request on the same fact supersedes it (its proposal goes stale)
    const acc2 = await api("POST", `/proposals/${sp2.id}/decision`, { decision: "accepted" });
    expect(acc2.status, JSON.stringify(acc2.body)).toBe(200);
    const acc = await api("POST", `/proposals/${sp.id}/decision`, { decision: "accepted" });
    expect(acc.status, JSON.stringify(acc.body)).toBe(200);
    expect(acc.body.proposals.find((p: { id: string }) => p.id === sp2.id).status).toBe("stale");
    const pending = acc.body.proposals.find((p: { id: string }) => p.id === sp.id);
    expect(pending.status).toBe("awaiting_approval");
    const ap = await t().modules.hitl.service.getApproval(scope, pending.approvalId);
    expect(ap.approvalType).toBe("canon_change");
    expect(ap.status).toBe("pending");
    const [old] = await t().modules.ontology.service.getFactsByIds(scope, [factId]);
    expect(old!.canonStatus).toBe("approved"); // unchanged until the author approves
    const dec = await t().http("POST", `/api/novels/${novelId}/approvals/${ap.id}/decision`, { decision: "approved" });
    expect(dec.status, JSON.stringify(dec.body)).toBe(200);
    const [oldAfter] = await t().modules.ontology.service.getFactsByIds(scope, [factId]);
    expect(oldAfter!.canonStatus).toBe("retracted");
    const [row] = await t().testDb.db.select().from(revisionChatProposals).where(eq(revisionChatProposals.id, sp.id));
    expect(row!.status).toBe("applied");
    const newFactId = (row!.payload as { newFactId: string }).newFactId;
    const [nf] = await t().modules.ontology.service.getFactsByIds(scope, [newFactId]);
    expect(nf!.canonStatus).toBe("approved");
    expect(nf!.text).toContain("29세");
    view = (await api("GET", "")).body;
    expect(view.session.outcome).toBe("setting_changed");

    // a change requested on the new fact, which is then withdrawn elsewhere before the approval: approving writes nothing
    expect((await api("POST", "/messages", { body: "나이를 33세로 다시 바꾸자. 바로 제안해 줘." })).status).toBe(201);
    reply({ reply_text: "33세로 바꾸는 제안입니다.", diagnosis_kind: "setting_questionable", sources: [{ kind: "fact", ref_id: newFactId, quote: null }], question: null, proposals: [{ kind: "setting_change", patches: [], fact_id: newFactId, new_value: "33세", reason: "작가 요청" }] });
    view = await turn();
    const sp3 = view.proposals.find((p: { kind: string; status: string; payload: { newValue?: string } }) => p.kind === "setting_change" && p.status === "pending" && p.payload.newValue === "33세");
    const acc3 = await api("POST", `/proposals/${sp3.id}/decision`, { decision: "accepted" });
    expect(acc3.status, JSON.stringify(acc3.body)).toBe(200);
    const ap3 = acc3.body.proposals.find((p: { id: string }) => p.id === sp3.id).approvalId;
    await t().platform.uow.run((tx) => t().modules.ontology.service.withdrawFacts(tx, scope, [newFactId], t().owner, "설정 화면에서 철회"));
    const dec3 = await t().http("POST", `/api/novels/${novelId}/approvals/${ap3}/decision`, { decision: "approved" });
    expect(dec3.status, JSON.stringify(dec3.body)).toBe(200);
    const [row3] = await t().testDb.db.select().from(revisionChatProposals).where(eq(revisionChatProposals.id, sp3.id));
    expect(row3!.status).toBe("stale");
    expect((row3!.payload as { newFactId?: string }).newFactId).toBeUndefined();
    const canon = await t().modules.ontology.service.getCanonAt(scope, [nf!.subjectEntityId], 1000, nf!.timelineId);
    expect(canon.some((f) => f.text.includes("33세"))).toBe(false);
  });

  it("close with an author note; the note is in the next episode's writer context after episode 1 is approved", async () => {
    // the chat changed the setting: no "의도대로 둠" note without the author's own words
    const plain = await api("POST", "/close", { saveNote: true });
    expect(plain.status, JSON.stringify(plain.body)).toBe(200);
    expect(await t().testDb.db.select().from(episodeAuthorNotes).where(eq(episodeAuthorNotes.novelId, novelId))).toHaveLength(0);
    const r = await api("POST", "/close", { saveNote: true, note: "흉터가 빛나는 장면은 의도대로 둔다" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.session.status).toBe("closed");
    const notes = await t().testDb.db.select().from(episodeAuthorNotes).where(eq(episodeAuthorNotes.novelId, novelId));
    expect(notes[0]!.body).toBe("작가 확인: 의도대로 둠 — 흉터가 빛나는 장면은 의도대로 둔다");
    // episode 1 back to awaiting_approval (after the patch re-checks), approve → episode 2 starts and sees the note
    await h.drain(scope, async () => (await h.ms().getEpisodeByNo(scope, 1)).status === "awaiting_approval", 100);
    expect((await h.ms().getEpisodeByNo(scope, 2)).status).toBe("planned");
    const before = t().claude.requests.length;
    await h.decide(scope, "episode", (await h.ms().getEpisodeByNo(scope, 1)).id, "approved");
    await h.drain(scope, async () => ["checking", "polishing", "awaiting_approval"].includes((await h.ms().getEpisodeByNo(scope, 2)).status), 100);
    const draft = t().claude.requests.slice(before).find((x) => x.system.includes("아웃라인의 씬을 순서대로 본문으로 씁니다"));
    expect(draft).toBeTruthy();
    expect(`${draft!.system}\n${draft!.prompt}`).toContain("흉터가 빛나는 장면은 의도대로 둔다");
  });

  it("published episodes: chat allowed, patches refused (retcon); chat before text is refused", async () => {
    const ep3 = await api("GET", "").then(() => t().http("GET", `/api/novels/${novelId}/episodes/3/revision-chat`));
    expect(ep3.body.canChat).toBe(false);
    expect((await t().http("POST", `/api/novels/${novelId}/episodes/3/revision-chat/messages`, { body: "?" })).status).toBe(409);
    await t().http("POST", `/api/novels/${novelId}/episodes/1/publish`, {});
    const v = (await api("GET", "")).body;
    expect(v.episode.status).toBe("published");
    expect(v.canChat).toBe(true);
    expect(v.canPatch).toBe(false);
  });
});

describe("한 화씩 진행: frontier only", () => {
  it("an older approved episode re-opened for an edit does not hold the next episode", async () => {
    const r = await h.novelWithEpisodeAwaiting({ title: "앞 화 수정" });
    const s = r.scope;
    await h.decide(s, "episode", (await h.ms().getEpisodeByNo(s, 1)).id, "approved");
    await h.drain(s, async () => (await h.ms().getEpisodeByNo(s, 2)).status === "checking", 150);
    // episode 2 as the approved frontier (its own approval flow is covered above); its leftover pipeline tasks are dropped
    const ep2 = await h.ms().getEpisodeByNo(s, 2);
    await t().testDb.exec(`UPDATE tasks SET status = 'cancelled' WHERE novel_id = '${s.novelId}' AND episode_id = '${ep2.id}' AND status IN ('pending','ready','blocked')`);
    await t().testDb.exec(`UPDATE episodes SET status = 'approved', approved_at = now(), approved_version_id = current_version_id, approved_by_actor_type = 'user', approved_by_actor_id = '${t().owner.id}' WHERE id = '${ep2.id}'`);
    // the author edits episode 1 (approved → checking, E16) while episode 2 is the approved frontier
    const ep1 = await h.ms().getEpisodeByNo(s, 1);
    const v1 = await h.ms().getVersion(s, ep1.currentVersionId!);
    await h.ms().saveHumanEdit(s, 1, { content: `${v1.content}\n\n작가가 덧붙인 문장.`, baseVersionId: v1.id }, t().owner);
    expect((await h.ms().getEpisodeByNo(s, 1)).status).toBe("checking");
    const ep3 = await h.ms().getEpisodeByNo(s, 3);
    let outlines = await t().modules.orchestration.service.listTasks(s, { kinds: ["outline_episode"], episodeId: ep3.id, includeCancelled: true });
    if (!outlines.length) {
      const sched = await h.ms().schedule(s);
      expect(sched.notes.some((x) => x.startsWith("sequential_wait:"))).toBe(false);
      outlines = await t().modules.orchestration.service.listTasks(s, { kinds: ["outline_episode"], episodeId: ep3.id, includeCancelled: true });
    }
    expect(outlines.length).toBeGreaterThan(0);
  }, 180_000);
});

describe("한 화씩 진행 off", () => {
  it("old behaviour: episode 2 starts while episode 1 waits (reserve target)", async () => {
    const r = await h.novelWithEpisodeAwaiting({ title: "병렬", sequential: false });
    await h.ms().schedule(r.scope);
    const ep2 = await h.ms().getEpisodeByNo(r.scope, 2);
    const outlines = await t().modules.orchestration.service.listTasks(r.scope, { kinds: ["outline_episode"], episodeId: ep2.id, includeCancelled: true });
    expect(outlines.length + (ep2.status === "planned" ? 0 : 1)).toBeGreaterThan(0);
    const home = await t().http("GET", `/api/novels/${r.novel.id}/home`);
    expect(home.body.sequential).toBeNull();
  }, 120_000);
});
