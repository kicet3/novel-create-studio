/**
 * 설계 추가: 컨셉 대화 자동 승인 모드. The server answers the partner's prompts with its recommendation on the user's
 * behalf (turn commit) and queues the next turn until the brief is ready for the manual [승인 요청] or a stop condition.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "@ncs/db/orm";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { conceptHarness, installConceptStubs, type ConceptHarness, type Scripted } from "./support.js";
import { decideAutoStep, autoApproveState } from "../../src/modules/concept/domain/auto-approve.js";
import { emptyWorkingBrief } from "../../src/modules/concept/domain/brief.js";
import { DEFAULT_SAFETY_LISTS } from "../../src/modules/concept/domain/checks.js";
import { planFieldEdit, planTurn, type TurnMessage } from "../../src/modules/concept/domain/turn.js";
import { renderTurnPrompt } from "../../src/modules/concept/application/prompts.js";
import { ConflictError } from "../../src/platform/index.js";

let t: TestCore;
let script: Scripted[];
beforeAll(async () => {
  t = await createTestCore();
  script = installConceptStubs(t).script;
});
afterAll(() => t.close());

const svc = () => t.modules.concept.service;

async function liveTurns(novelId: string): Promise<number> {
  const r = (await t.testDb.db.execute(
    sql`SELECT count(*)::int AS n FROM tasks WHERE novel_id = ${novelId} AND kind IN ('concept_turn', 'import_concept') AND status NOT IN ('done', 'failed', 'cancelled')`,
  )) as any;
  return r.rows[0].n as number;
}

/** run turns until nothing is in flight; asserts there is never more than one live turn per session */
async function drive(h: ConceptHarness, max = 60): Promise<number> {
  let runs = 0;
  for (let i = 0; i < max; i++) {
    expect(await liveTurns(h.scope.novelId)).toBeLessThanOrEqual(1);
    const n = await h.run();
    if (!n) break;
    runs += n;
  }
  return runs;
}

const autoState = async (h: ConceptHarness) => (await svc().getSessionView(h.scope))!.autoApprove;
const autoMessages = async (h: ConceptHarness) => (await h.messages()).filter((m) => m.autoApproved);

async function auditAfter(novelId: string, prefix: string): Promise<any[]> {
  const page = await t.modules.audit.service.list({ novelId }, { actionPrefix: prefix, limit: 200 });
  return page.items;
}

/** conversation session past the opening (seed answered) */
async function seeded(): Promise<ConceptHarness> {
  const novel = await t.modules.novel.service.createNovel({}, t.owner);
  const h = await conceptHarness(t, novel.id, script);
  await h.say("몰락한 검사 가문의 막내가 회귀해 가문을 되살린다");
  await h.run();
  return h;
}

describe("auto-approve decision (pure)", () => {
  const b = emptyWorkingBrief();
  const st = autoApproveState(null);
  it("picks the recommended option, asks for a recommendation when none is marked, waits on open questions", () => {
    const rec = decideAutoStep({
      prompt: { id: "p", askedFieldPaths: ["opposition"], options: [
        { idx: 1, label: "A", value: "a", source: "agent", field_path: "opposition" },
        { idx: 2, label: "B", value: "b", source: "agent", field_path: "opposition", is_recommended: true },
        { idx: 901, label: "추천해 줘", value: "@recommend", source: "control" },
      ] },
      brief: b,
      state: st,
    });
    expect(rec).toMatchObject({ kind: "pick", option: { value: "b" }, body: "자동 승인: B" });
    const seeds = { id: "p", askedFieldPaths: ["category.genre_label"], options: [
      { idx: 1, label: "현판", value: "현판", source: "seed" as const },
      { idx: 901, label: "추천해 줘", value: "@recommend", source: "control" as const },
    ] };
    expect(decideAutoStep({ prompt: seeds, brief: b, state: st })).toMatchObject({ kind: "pick", what: "recommend" });
    expect(decideAutoStep({ prompt: seeds, brief: b, state: { ...st, recommended_for: "category.genre_label" } })).toMatchObject({ kind: "pick", option: { value: "현판" } });
    expect(decideAutoStep({ prompt: { id: "p", askedFieldPaths: ["seed_notes"], options: [{ idx: 1, label: "아직 없음", value: "@none", source: "control" }] }, brief: b, state: st })).toMatchObject({
      kind: "wait",
      reason: "open_question",
    });
    expect(decideAutoStep({ prompt: { id: "p", askedFieldPaths: null, options: [{ idx: 915, label: "승인 요청", value: "@submit", source: "control" }] }, brief: b, state: st })).toMatchObject({ kind: "complete" });
    expect(decideAutoStep({ prompt: { id: "p", askedFieldPaths: null, options: [{ idx: 910, label: "요약 확인으로 이동", value: "@to_confirming", source: "control" }] }, brief: b, state: st })).toMatchObject({
      kind: "pick",
      what: "stage",
    });
  });
});

describe("auto-approve loop (server-side, PGlite)", () => {
  it("waits for the seed, then keeps answering with the partner's recommendation (distinct provenance, audited)", async () => {
    const novel = await t.modules.novel.service.createNovel({}, t.owner);
    const h = await conceptHarness(t, novel.id, script);
    const s0 = await h.session();
    await svc().setAutoApprove(h.scope, s0.id, { enabled: true }, t.owner);
    // the opening question has nothing to recommend → wait for the user
    expect(await autoState(h)).toMatchObject({ enabled: true, status: "waiting_user", waitingReason: "open_question" });
    expect(await liveTurns(novel.id)).toBe(0);
    expect((await h.messages()).some((m) => m.body.startsWith("자동 승인 대기"))).toBe(true);

    // the user's own answer → turn → the commit auto-steps
    await h.say("몰락한 검사 가문의 막내가 회귀해 가문을 되살린다");
    await h.run();
    let autos = await autoMessages(h);
    expect(autos).toHaveLength(1);
    expect(autos[0]).toMatchObject({ authorKind: "user", kind: "option_pick", body: "자동 승인: 추천해 줘", authorUserId: t.ownerId });
    expect(await autoState(h)).toMatchObject({ enabled: true, status: "running", steps: 1 });
    expect(await liveTurns(novel.id)).toBe(1); // queued by the commit, no browser involved

    await h.run(); // candidates (recommended first) → auto pick
    await h.run(); // the pick is applied
    const b = await h.brief();
    expect(b.content.category.genre_label).toBe("현판");
    expect(b.field_provenance["category.genre_label"]).toMatchObject({ origin: "agent_auto_accepted", slot_state: "confirmed" });
    autos = await autoMessages(h);
    expect(autos.map((m) => m.body)).toContain("자동 승인: 현판");
    // the seed the user wrote stays user_stated
    expect(b.field_provenance.seed_notes.origin).toBe("user_stated");

    const changed = await auditAfter(novel.id, "concept_session.auto_approve_changed");
    expect(changed[0]!.after).toMatchObject({ enabled: true });
    const accepted = await auditAfter(novel.id, "concept_brief.auto_accepted");
    expect(accepted.length).toBeGreaterThan(0);
    expect(accepted.some((e) => (e.after as any).fields.some((f: any) => f.path === "category.genre_label"))).toBe(true);
    expect((accepted[0]!.after as any).delegated_by).toBe(t.ownerId);
  });

  it("runs to the end of the brief and stops before the manual concept confirmation ([승인 요청] stays with the user)", async () => {
    const h = await seeded();
    const s = await h.session();
    await svc().setAutoApprove(h.scope, s.id, { enabled: true, maxSteps: 60 }, t.owner);
    await drive(h, 80);
    const v = (await svc().getSessionView(h.scope))!;
    expect(v.autoApprove).toMatchObject({ enabled: false, status: "off", stopReason: "completed" });
    expect(v.session.status).toBe("active"); // no approval requested automatically
    expect(v.session.pendingApprovalId).toBeNull();
    expect(v.canSubmit).toBe(true);
    expect(v.progress.missing).toEqual([]);
    const ms = await h.messages();
    expect(ms[ms.length - 1]!.body).toContain("[승인 요청]");
    expect(ms.some((m) => m.autoApproved && /승인 요청/.test(m.body))).toBe(false);
  });

  it("stops at the step cap", async () => {
    const h = await seeded();
    await svc().setAutoApprove(h.scope, (await h.session()).id, { enabled: true, maxSteps: 2 }, t.owner);
    await drive(h);
    expect(await autoMessages(h)).toHaveLength(2);
    expect(await autoState(h)).toMatchObject({ enabled: false, stopReason: "step_cap", steps: 2 });
    expect(await liveTurns(h.scope.novelId)).toBe(0);
  });

  it("stops on a model error, at the turn cap and at the budget limit", async () => {
    // error (last attempt) → failure notice, loop off
    const e = await seeded();
    await svc().setAutoApprove(e.scope, (await e.session()).id, { enabled: true }, t.owner);
    script.push(Object.assign(new Error("model down"), { retryable: false }));
    await e.run();
    expect(await autoState(e)).toMatchObject({ enabled: false, stopReason: "error" });
    expect(await liveTurns(e.scope.novelId)).toBe(0);
    script.length = 0;

    // turn cap
    const c = await seeded();
    const cs = await c.session();
    await t.testDb.exec(`UPDATE concept_sessions SET turn_limit = agent_turn_count WHERE id = '${cs.id}'`);
    await svc().setAutoApprove(c.scope, cs.id, { enabled: true }, t.owner);
    expect(await autoState(c)).toMatchObject({ enabled: false, stopReason: "turn_cap" });
    expect(await autoMessages(c)).toHaveLength(0);

    // budget
    const g = await seeded();
    const gs = await g.session();
    await svc().setAutoApprove(g.scope, gs.id, { enabled: true }, t.owner);
    await t.testDb.exec(`UPDATE concept_sessions SET budget_limit_micros = spent_micros + 1 WHERE id = '${gs.id}'`);
    await g.run();
    const gv = (await svc().getSessionView(g.scope))!;
    expect(gv.session).toMatchObject({ status: "paused", pauseReason: "budget_limit" });
    expect(gv.autoApprove).toMatchObject({ enabled: false, stopReason: "budget" });
  });

  it("toggle off and [멈추기] end the run; nothing is picked afterwards", async () => {
    const h = await seeded();
    const sid = (await h.session()).id;
    await svc().setAutoApprove(h.scope, sid, { enabled: true }, t.owner);
    expect(await autoMessages(h)).toHaveLength(1); // answered the latest prompt right away
    expect(await liveTurns(h.scope.novelId)).toBe(1);
    const before = await h.brief();
    await svc().setAutoApprove(h.scope, sid, { enabled: false }, t.owner);
    // review #3: switching off cancels the turn queued for the last pick (no paid turn after "off", no 409 window)
    expect(await liveTurns(h.scope.novelId)).toBe(0);
    expect((await h.session()).inFlightTaskId).toBeNull();
    expect(await drive(h)).toBe(0);
    expect(await autoMessages(h)).toHaveLength(1);
    expect(await autoState(h)).toMatchObject({ enabled: false, stopReason: "toggled_off" });
    // the dropped pick is processed, never applied
    const after = await h.brief();
    expect(after.content).toEqual(before.content);
    expect(after.meta.processed_seq).toBe((await autoMessages(h))[0]!.seq);
    expect((await h.messages()).some((m) => m.body.includes("마지막 자동 선택은 반영하지 않았습니다"))).toBe(true);

    // a new run answers the still-open prompt again (the dropped pick did not answer it)
    await svc().setAutoApprove(h.scope, sid, { enabled: true }, t.owner);
    expect(await autoMessages(h)).toHaveLength(2);
    expect(await liveTurns(h.scope.novelId)).toBe(1);
    await svc().stopTurn(h.scope, sid, t.owner);
    expect(await liveTurns(h.scope.novelId)).toBe(0);
    expect(await autoState(h)).toMatchObject({ enabled: false, stopReason: "user_stopped" });
    expect((await h.messages()).some((m) => m.body.startsWith("답변을 멈추고 자동 승인을 껐습니다"))).toBe(true);
    const stopped = await auditAfter(h.scope.novelId, "concept_session.auto_approve_changed");
    expect(stopped.some((x) => (x.after as any).stop_reason === "user_stopped" && x.actorType === "user")).toBe(true);
  });

  it("a user message while auto runs is queued (no 409); the user's input wins and auto continues after", async () => {
    const h = await seeded();
    const sid = (await h.session()).id;
    await svc().setAutoApprove(h.scope, sid, { enabled: true }, t.owner);
    expect(await liveTurns(h.scope.novelId)).toBe(1);
    const res = await t.http("POST", `/api/novels/${h.scope.novelId}/concept/sessions/${sid}/messages`, { body: "주인공은 열여섯 살 막내 검사입니다" });
    expect(res.status).toBe(201);
    expect(res.body.taskId).toBe((await h.session()).inFlightTaskId);
    expect(await liveTurns(h.scope.novelId)).toBe(1); // still one turn: the queued one reads both messages
    const autosBefore = (await autoMessages(h)).length;
    await h.run();
    const s = await h.session();
    const b = parseBrief(s);
    const ms = await h.messages();
    const userMsg = ms.find((m) => m.body === "주인공은 열여섯 살 막내 검사입니다")!;
    expect(b.meta.processed_seq).toBeGreaterThanOrEqual(userMsg.seq);
    // auto continues after the user's input
    expect((await autoMessages(h)).length).toBe(autosBefore + 1);
    expect(await autoState(h)).toMatchObject({ enabled: true });

    // with auto OFF, sending during a turn is still refused (send lock semantics unchanged)
    await svc().setAutoApprove(h.scope, sid, { enabled: false }, t.owner);
    expect(await liveTurns(h.scope.novelId)).toBe(0); // the turn queued for the last auto pick is cancelled
    const first = await t.http("POST", `/api/novels/${h.scope.novelId}/concept/sessions/${sid}/messages`, { body: "검은 늑대 기사단이 적입니다" });
    expect(first.status).toBe(201);
    expect(await liveTurns(h.scope.novelId)).toBe(1);
    const locked = await t.http("POST", `/api/novels/${h.scope.novelId}/concept/sessions/${sid}/messages`, { body: "하나 더" });
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe("concept_turn_in_flight");
  });

  it("is idempotent: enabling twice starts one run, a retried turn answers each prompt once", async () => {
    const h = await seeded();
    const sid = (await h.session()).id;
    await svc().setAutoApprove(h.scope, sid, { enabled: true }, t.owner);
    await svc().setAutoApprove(h.scope, sid, { enabled: true }, t.owner); // second tab
    expect(await autoMessages(h)).toHaveLength(1);
    expect(await liveTurns(h.scope.novelId)).toBe(1);
    // the next turn's model call fails once (retryable) — the engine runs the task again (like after a restart)
    script.push(new Error("transient"));
    await h.run();
    expect(await liveTurns(h.scope.novelId)).toBe(1);
    expect(await autoMessages(h)).toHaveLength(1);
    await h.run();
    const autos = await autoMessages(h);
    expect(autos).toHaveLength(2);
    // every auto message answers a different prompt
    const ms = await h.messages();
    const promptOf = (seq: number) => [...ms].reverse().find((m) => m.seq < seq && (m.authorKind === "agent" || m.authorKind === "system") && m.options)!.id;
    expect(new Set(autos.map((m) => promptOf(m.seq))).size).toBe(2);
    expect(await autoState(h)).toMatchObject({ enabled: true, steps: 2 });
    // the state survives in the DB (working_brief.meta) — a new view read sees the same run
    const raw = (await t.testDb.db.execute(sql`SELECT working_brief FROM concept_sessions WHERE id = ${sid}`)) as any;
    expect(raw.rows[0].working_brief.meta.auto_approve).toMatchObject({ enabled: true, run_no: 1, steps: 2 });
    await svc().setAutoApprove(h.scope, sid, { enabled: false }, t.owner);
    await drive(h);
  });

  it("change proposals: auto-accepts on agent-set fields; waits on user-written fields unless the user allowed it", async () => {
    const REQUIRED: Array<[string, unknown]> = [
      ["category.genre_label", "SF"],
      ["age_rating", "age_12"],
      ["protagonist.starting_condition", "화성 기지의 정비공"],
      ["protagonist.desire", "지구로 돌아가기"],
      ["opposition", "기지를 봉쇄한 회사"],
      ["core_hook", "정비공만 기지의 AI와 대화할 수 있다"],
    ];
    const setup = async () => {
      const novel = await t.modules.novel.service.createNovel({ entryMode: "direct_input" }, t.owner);
      const h = await conceptHarness(t, novel.id, script);
      const s = await h.session();
      for (const [p, v] of REQUIRED) await svc().editWorkingBrief(h.scope, s.id, p, v, t.owner);
      await svc().switchEntryMode(h.scope, s.id, "conversation", t.owner);
      await h.run();
      script.push({ reply_text: "대립을 바꿔 보면 어떨까요?", change_proposals: [{ field_path: "opposition", new_value: "외계 생명체", reason: "장기 갈등" }] });
      await h.say("대립이 좀 약한 것 같아요");
      await h.run();
      const pending = (await h.brief()).change_proposals.filter((p: any) => p.status === "pending");
      expect(pending).toHaveLength(1);
      return { h, sid: s.id, proposalId: pending[0].id as string };
    };

    // default: the user wrote `opposition` → wait for the user's decision, nothing changes
    const a = await setup();
    await svc().setAutoApprove(a.h.scope, a.sid, { enabled: true }, t.owner);
    expect(await autoState(a.h)).toMatchObject({ enabled: true, status: "waiting_user", waitingReason: "user_field_proposal" });
    expect((await a.h.brief()).content.opposition).toBe("기지를 봉쇄한 회사");
    expect(await autoMessages(a.h)).toHaveLength(0);
    // the user decides → turn → auto continues
    await svc().decideChangeProposal(a.h.scope, a.sid, a.proposalId, "rejected", t.owner);
    await a.h.run();
    expect(await autoState(a.h)).toMatchObject({ enabled: true, status: "running" });
    expect((await autoMessages(a.h)).length).toBe(1);
    await svc().setAutoApprove(a.h.scope, a.sid, { enabled: false }, t.owner);
    await drive(a.h);

    // opted in: auto-accept with its own provenance + audit (via auto_approve, not the user's button)
    const b = await setup();
    await svc().setAutoApprove(b.h.scope, b.sid, { enabled: true, acceptUserFieldProposals: true }, t.owner);
    const autos = await autoMessages(b.h);
    expect(autos).toHaveLength(1);
    expect(autos[0]!.body).toContain("변경 제안 수락");
    await b.h.run();
    const br = await b.h.brief();
    expect(br.content.opposition).toBe("외계 생명체");
    expect(br.field_provenance.opposition).toMatchObject({ origin: "agent_auto_accepted", slot_state: "confirmed" });
    expect(br.change_proposals.find((p: any) => p.id === b.proposalId)).toMatchObject({ status: "accepted", resolution: "auto_accepted" });
    const decided = await auditAfter(b.h.scope.novelId, "concept_brief.change_proposal_decided");
    const row = decided.find((x) => (x.after as any).proposal_id === b.proposalId)!;
    expect(row.after).toMatchObject({ decision: "accepted", resolution: "auto_accepted", via: "auto_approve" });
    expect(row.actorType).toBe("agent");
    await svc().setAutoApprove(b.h.scope, b.sid, { enabled: false }, t.owner);
    await drive(b.h);
  });

  it("never overwrites a user-written field with an auto pick (becomes a change proposal instead)", async () => {
    const h = await seeded();
    const sid = (await h.session()).id;
    await svc().editWorkingBrief(h.scope, sid, "protagonist.desire", "가문의 명예 회복", t.owner);
    // the partner asks the desire slot again with its own recommendation
    await t.platform.uow.run(async (tx) => {
      await tx.db.execute(sql`UPDATE concept_sessions SET working_brief = jsonb_set(working_brief, '{field_provenance,protagonist.desire,slot_state}', '"proposed"') WHERE id = ${sid}`);
    });
    script.push({
      reply_text: "주인공의 욕망을 골라 주세요.",
      questions: [{ slot_key: "protagonist.desire", ask_text: "욕망은?", options: [{ label: "복수", value: "배신자에게 복수", is_recommended: true }] }],
    });
    await h.say("다음으로 가요");
    await h.run();
    const prompt = await h.lastAgent();
    await t.platform.uow.run(async (tx) => {
      await tx.db.execute(sql`UPDATE concept_messages SET asked_field_paths = ARRAY['protagonist.desire'], options = ${JSON.stringify([{ idx: 1, label: "복수", value: "배신자에게 복수", source: "agent", field_path: "protagonist.desire", is_recommended: true }])}::jsonb WHERE id = ${prompt.id}`);
    });
    await svc().setAutoApprove(h.scope, sid, { enabled: true }, t.owner);
    expect((await autoMessages(h)).map((m) => m.body)).toContain("자동 승인: 복수");
    await h.run();
    const b = await h.brief();
    expect(b.content.protagonist.desire).toBe("가문의 명예 회복");
    expect(b.field_provenance["protagonist.desire"].origin).toBe("user_edited");
    expect(b.change_proposals).toContainEqual(expect.objectContaining({ field_path: "protagonist.desire", new_value: "배신자에게 복수", status: "pending" }));
    await svc().setAutoApprove(h.scope, sid, { enabled: false }, t.owner);
    await drive(h);
  });

  it("HTTP: toggle route returns the view and is audited; disabled for form-only sessions", async () => {
    const h = await seeded();
    const sid = (await h.session()).id;
    const on = await t.http("POST", `/api/novels/${h.scope.novelId}/concept/sessions/${sid}/auto-approve`, { enabled: true, maxSteps: 3 });
    expect(on.status).toBe(200);
    expect(on.body.autoApprove).toMatchObject({ enabled: true, maxSteps: 3, canEnable: true });
    const off = await t.http("POST", `/api/novels/${h.scope.novelId}/concept/sessions/${sid}/auto-approve`, { enabled: false });
    expect(off.body.autoApprove).toMatchObject({ enabled: false, stopReason: "toggled_off" });
    await drive(h);

    const novel = await t.modules.novel.service.createNovel({ entryMode: "direct_input" }, t.owner);
    const f = await conceptHarness(t, novel.id, script);
    const fs = await f.session();
    const bad = await t.http("POST", `/api/novels/${novel.id}/concept/sessions/${fs.id}/auto-approve`, { enabled: true });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("concept_auto_approve_unavailable");
  });
});

describe("auto-approve review fixes (regressions)", () => {
  const webChannelOf = (h: ConceptHarness) => h.session().then((s) => ((s.workingBrief as any).meta.web_channel_id as string) ?? s.activeChannelId);

  it("#1 a paste while an auto turn is in flight is refused (409), never a second concurrent task", async () => {
    const h = await seeded();
    const sid = (await h.session()).id;
    await svc().setAutoApprove(h.scope, sid, { enabled: true }, t.owner);
    expect(await liveTurns(h.scope.novelId)).toBe(1);
    const inFlight = (await h.session()).inFlightTaskId;
    const res = await t.http("POST", `/api/novels/${h.scope.novelId}/concept/sessions/${sid}/messages`, { body: "붙여 넣은 기획서 본문", kind: "import_text" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("concept_turn_in_flight");
    expect(await liveTurns(h.scope.novelId)).toBe(1);
    expect((await h.session()).inFlightTaskId).toBe(inFlight);
    expect((await h.messages()).some((m) => m.kind === "import_text")).toBe(false);
    await svc().setAutoApprove(h.scope, sid, { enabled: false }, t.owner);
  });

  it("#2 [멈추기] racing a commit also cancels the turn that commit queued for its auto pick", async () => {
    const h = await seeded();
    const sid = (await h.session()).id;
    await svc().setAutoApprove(h.scope, sid, { enabled: true }, t.owner);
    const t1 = (await h.session()).inFlightTaskId!;
    await h.run(); // T1 commits and auto-steps: T2 queued for the new pick
    const t2 = (await h.session()).inFlightTaskId!;
    expect(t2).not.toBe(t1);
    expect(await liveTurns(h.scope.novelId)).toBe(1);
    // rewind to "stop-turn read T1 while T1 was still committing": T1 looks running, the session still points at it
    await t.testDb.exec(`UPDATE tasks SET status = 'running' WHERE id = '${t1}'`);
    await t.testDb.exec(`UPDATE concept_sessions SET in_flight_task_id = '${t1}' WHERE id = '${sid}'`);
    const orch = t.modules.orchestration.service as any;
    const real = orch.cancelTask;
    orch.cancelTask = async (tx: any, scope: any, taskId: string, actor: any) => {
      if (taskId !== t1) return real.call(orch, tx, scope, taskId, actor);
      // T1's commit wins the race: done, and the session now points at T2
      await tx.db.execute(sql`UPDATE tasks SET status = 'done' WHERE id = ${t1}`);
      await tx.db.execute(sql`UPDATE concept_sessions SET in_flight_task_id = ${t2} WHERE id = ${sid}`);
      throw new ConflictError("invalid_transition", "이미 끝난 작업은 취소할 수 없습니다.");
    };
    try {
      await svc().stopTurn(h.scope, sid, t.owner);
    } finally {
      orch.cancelTask = real;
    }
    expect(await liveTurns(h.scope.novelId)).toBe(0);
    const s = await h.session();
    expect(s.inFlightTaskId).toBeNull();
    expect(await autoState(h)).toMatchObject({ enabled: false, stopReason: "user_stopped" });
    // the pick T2 would have answered is dropped (processed, not applied)
    const autos = await autoMessages(h);
    expect(parseBrief(s).meta.processed_seq).toBe(autos[autos.length - 1]!.seq);
    expect(await drive(h)).toBe(0);
  });

  it("#3 switching off keeps a user message queued behind the cancelled auto turn", async () => {
    const h = await seeded();
    const sid = (await h.session()).id;
    await svc().setAutoApprove(h.scope, sid, { enabled: true }, t.owner);
    const t1 = (await h.session()).inFlightTaskId!;
    // the user's message queued behind the auto turn → the auto turn is no longer "auto only": it is kept
    const res = await t.http("POST", `/api/novels/${h.scope.novelId}/concept/sessions/${sid}/messages`, { body: "주인공은 쌍검을 씁니다" });
    expect(res.status).toBe(201);
    await svc().setAutoApprove(h.scope, sid, { enabled: false }, t.owner);
    expect((await h.session()).inFlightTaskId).toBe(t1);
    expect(await liveTurns(h.scope.novelId)).toBe(1);
    await drive(h);
    const ms = await h.messages();
    const u = ms.find((m) => m.body === "주인공은 쌍검을 씁니다")!;
    expect(parseBrief(await h.session()).meta.processed_seq).toBeGreaterThanOrEqual(u.seq);
  });

  it("#4 an auto [맞습니다] confirmation gets the auto provenance (never a user confirmation) and is audited", async () => {
    const b = emptyWorkingBrief({ web_channel_id: "chn_web" });
    Object.assign(b, planFieldEdit({ brief: b, stage: "diverging", entryMode: "conversation", messageId: "cnm_x", path: "opposition", value: "검은 늑대 기사단", lists: DEFAULT_SAFETY_LISTS, flipLimit: 3, newId: () => "cpr_1" }).brief);
    b.field_provenance.opposition = { ...b.field_provenance.opposition!, origin: "agent_proposed_modified", slot_state: "proposed" };
    const prompt: TurnMessage = { id: "cnm_p", seq: 1, authorKind: "agent", kind: "question", body: "", channelId: "chn_web", pickedIdx: null, askedFieldPaths: ["opposition"], options: [{ idx: 920, label: "맞습니다", value: "@confirm_field:opposition", source: "control" }] };
    const pick = (auto: boolean): TurnMessage => ({ id: "cnm_a", seq: 2, authorKind: "user", kind: "option_pick", body: auto ? "자동 승인: '대립' 이해한 내용 확인" : "맞습니다", channelId: "chn_web", pickedIdx: 920, options: null, askedFieldPaths: null, autoApproved: auto });
    const limits = { flipLimit: 3, softWarning: 180, agentTurnCount: 0, turnLimit: 200, messenger: false, replyMaxChars: 1200 };
    const run = (auto: boolean) => planTurn({ brief: b, stage: "diverging", entryMode: "conversation", messages: [pick(auto)], prompt, proposal: null, runId: "run_1", lists: DEFAULT_SAFETY_LISTS, limits, newId: () => "cpr_2" });
    const autoPlan = run(true);
    expect(autoPlan.brief.field_provenance.opposition).toMatchObject({ origin: "agent_auto_accepted", slot_state: "confirmed" });
    expect(autoPlan.diffs.get("cnm_a")).toEqual([expect.objectContaining({ field_path: "opposition", origin: "agent_auto_accepted", slot_state: "confirmed" })]);
    // the user's own [맞습니다] keeps the existing behaviour
    expect(run(false).brief.field_provenance.opposition).toMatchObject({ origin: "agent_proposed_modified", slot_state: "confirmed" });
  });

  it("#4 an auto [추천해 줘] delegation is in the auto-accept audit trail", async () => {
    const novel = await t.modules.novel.service.createNovel({}, t.owner);
    const h = await conceptHarness(t, novel.id, script);
    await svc().setAutoApprove(h.scope, (await h.session()).id, { enabled: true, maxSteps: 4 }, t.owner);
    await h.say("몰락한 검사 가문의 막내가 회귀해 가문을 되살린다");
    await drive(h);
    const autos = await autoMessages(h);
    expect(autos.some((m) => m.body === "자동 승인: 추천해 줘")).toBe(true);
    const trail = await auditAfter(novel.id, "concept_brief.auto_accepted");
    const ids = new Set(trail.flatMap((e) => (e.after as any).message_ids as string[]));
    // every auto message that changed a slot is in the trail
    const changing = autos.filter((m) => (m as any).slotUpdates?.length);
    expect(changing.length).toBeGreaterThan(0);
    for (const m of changing) expect(ids.has(m.id)).toBe(true);
    // review #8: the turn the loop queues for each pick is created by the system (not as if the user created it)
    const r = (await t.testDb.db.execute(sql`SELECT created_by_actor_type AS a FROM tasks WHERE novel_id = ${novel.id} AND input->>'cycle_key' IN (SELECT id FROM concept_messages WHERE auto_approved)`)) as any;
    expect(r.rows.length).toBeGreaterThan(0);
    expect(new Set(r.rows.map((x: any) => x.a))).toEqual(new Set(["system"]));
  });

  it("#5 switching on at the turn cap with an unanswered message stops at once (never 'running' with nothing in flight)", async () => {
    const h = await seeded();
    const s = await h.session();
    await t.testDb.exec(`UPDATE concept_sessions SET turn_limit = agent_turn_count WHERE id = '${s.id}'`);
    await h.say("주인공은 열다섯 살입니다"); // no turn (cap) → unprocessed
    expect(await liveTurns(h.scope.novelId)).toBe(0);
    await svc().setAutoApprove(h.scope, s.id, { enabled: true }, t.owner);
    expect(await autoState(h)).toMatchObject({ enabled: false, status: "off", stopReason: "turn_cap" });
    expect(await liveTurns(h.scope.novelId)).toBe(0);
  });

  it("#6 switching on never re-answers a prompt the user already answered", async () => {
    const h = await seeded();
    const sid = (await h.session()).id;
    await h.say("대립은 황실 근위대로 할게요");
    await h.run();
    // the newest partner reply has no options; the prompt before it (answered by the user) does
    const last = await h.lastAgent();
    await t.testDb.exec(`UPDATE concept_messages SET options = NULL, asked_field_paths = NULL WHERE id = '${last.id}'`);
    const before = await h.brief();
    await svc().setAutoApprove(h.scope, sid, { enabled: true }, t.owner);
    expect(await autoMessages(h)).toHaveLength(0);
    expect(await autoState(h)).toMatchObject({ enabled: true, status: "waiting_user", waitingReason: "open_question" });
    expect((await h.brief()).content).toEqual(before.content);
    await svc().setAutoApprove(h.scope, sid, { enabled: false }, t.owner);
  });

  it("#7 the 'auto-approve on' prompt section follows the toggle, not the message history", async () => {
    const h = await seeded();
    const sid = (await h.session()).id;
    await h.say("주인공은 열여섯 살입니다"); // a turn for the user's message is in flight
    await svc().setAutoApprove(h.scope, sid, { enabled: true, maxSteps: 1 }, t.owner);
    let system = "";
    script.push((input) => {
      system = input.system;
      return { reply_text: "좋아요." };
    });
    await h.run();
    expect(system).toContain("## 자동 승인 모드"); // first turn after switching on, no auto message yet
    script.length = 0;

    const msg = (auto: boolean): TurnMessage => ({ id: "cnm_1", seq: 1, authorKind: "user", kind: "option_pick", body: "자동 승인: 현판", channelId: "c", pickedIdx: 1, options: null, askedFieldPaths: null, autoApproved: auto });
    const base = { brief: emptyWorkingBrief(), stage: "diverging", next: { kind: "summary", text: "" } as any, recent: [msg(true)], newMessages: [], ageCeiling: "age_15", maxReplyChars: 800 };
    const off = renderTurnPrompt({ ...base, autoApprove: false }).system;
    expect(off).not.toContain("사용자가 자동 승인을 켰습니다");
    expect(off).toContain("자동 승인은 지금 꺼져 있습니다");
    expect(renderTurnPrompt({ ...base, autoApprove: true }).system).toContain("사용자가 자동 승인을 켰습니다");
    await svc().setAutoApprove(h.scope, sid, { enabled: false }, t.owner);
  });
});

function parseBrief(s: { workingBrief: unknown }): any {
  return s.workingBrief as any;
}
