/**
 * 설계 추가 0014 — regressions from the full_auto review: unchecked concept, legacy question sensitivity, dependent
 * questions, transient auto-decision errors, kill switch during a tick, re-enabling without the opt-ins, budget warning
 * resume, wait notices, arc_approval → full_auto hand-over and AR6 when a batch leaves a waiting episode out.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "@ncs/db/orm";
import { approvals, questions } from "@ncs/db/schema";
import * as dto from "@ncs/shared";
import { FakeClock } from "@ncs/test-kit";
import type { QuestionDraft } from "../../src/modules/hitl/index.js";
import { HIGH_SENSITIVITY_BASES, HIGH_SENSITIVITY_TOPICS } from "../../src/modules/hitl/domain/grading.js";
import { actors, NotImplementedError, type NovelScope } from "../../src/platform/index.js";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { scriptPipeline } from "../support/pipeline-script.js";
import { scriptWorld } from "../support/world.js";
import { approveStructure, bibleApproved, decideApproval, drain, planningNovel } from "../structure/harness.js";
import { approvedConceptNovel, auditActions, BRIEF_CONTENT, enableFullAuto, scriptCastFill, type Scope } from "./harness.js";

const SYS = actors.system("orchestrator");

async function bibleAwaiting(t: TestCore, scope: NovelScope) {
  return t.platform.uow.run(async (tx) => {
    const n = await t.modules.novel.service.getNovel(scope, tx);
    const bible = await t.modules.novel.service.createBibleVersion(tx, scope, { logline: "로그라인", synopsis: "시놉시스", content: {}, contentMd: "# 기획서", conceptBriefId: n.approvedConceptBriefId! }, SYS);
    const req = await t.modules.hitl.service.requestApproval(tx, scope, {
      approvalType: "series_bible",
      target: { type: "series_bible", id: bible.id },
      question: { title: "기획서 승인 요청", body: "기획서", links: [{ type: "series_bible", id: bible.id }] },
      requestedBy: SYS,
    });
    await t.modules.novel.service.transitionBible(tx, scope, bible.id, "awaiting_approval", SYS, { approvalId: req.approvalId });
    return req;
  });
}

describe("0014 migration backfill", () => {
  it("the SQL list of high-sensitivity topics / bases matches the server rule", () => {
    const sql = readFileSync(fileURLToPath(new URL("../../../../packages/db/src/migrations/0014_autopilot.sql", import.meta.url)), "utf8");
    const update = sql.slice(sql.indexOf("UPDATE questions SET sensitivity = 'high'"));
    const list = (col: string) => {
      const m = new RegExp(`${col} IN \\(([^)]*)\\)`).exec(update);
      return new Set([...(m?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((x) => x[1]));
    };
    expect(list("topic")).toEqual(new Set(HIGH_SENSITIVITY_TOPICS));
    expect(list("blocking_basis")).toEqual(new Set(HIGH_SENSITIVITY_BASES));
  });
});

describe("review fixes (questions, approvals, switches)", () => {
  let t: TestCore;
  let clock: FakeClock;
  beforeAll(async () => {
    clock = new FakeClock("2026-11-05T03:00:00.000Z");
    t = await createTestCore({ clock });
  });
  afterAll(() => t.close());

  const draft = (scope: NovelScope, over: Partial<QuestionDraft> = {}): QuestionDraft => ({
    topic: "creative_choice",
    questionType: "single_choice",
    title: "조연 이름을 고르세요",
    body: "12화에 나올 조연의 이름입니다.",
    options: [
      { label: "윤서", value: { kind: "choice", key: "a" } },
      { label: "하린", value: { kind: "choice", key: "b" }, isRecommended: true },
    ],
    links: [{ type: "novel", id: scope.novelId }],
    ...over,
  });
  const ask = (scope: NovelScope, d: QuestionDraft) => t.platform.uow.run((tx) => t.modules.hitl.service.createQuestion(tx, scope, d, { createdBy: t.owner }));
  const qrow = async (id: string) => (await t.testDb.db.select().from(questions).where(eq(questions.id, id)))[0]!;
  const fullAutoNovel = async (settings: Record<string, unknown> = {}) => {
    const n = await t.modules.novel.service.createNovel({ title: "리뷰 회귀" }, t.owner);
    const scope = { novelId: n.id };
    await enableFullAuto(t, scope, settings);
    return scope;
  };

  it("a question created before 0014 (sensitivity defaulted to normal) on an always-human topic is never auto-answered", async () => {
    const scope = await fullAutoNovel();
    const q = await ask(scope, draft(scope, { topic: "direction", title: "방향을 고르세요" }));
    await t.testDb.db.update(questions).set({ sensitivity: "normal" }).where(eq(questions.id, q.questionId)); // legacy row
    clock.advance(24 * 3600_000);
    expect((await t.modules.autopilot.service.tick(scope)).answered).toEqual([]);
    expect((await qrow(q.questionId)).resolutionSource).not.toBe("auto_answer");
    expect(await t.modules.hitl.service.autoAnswerQuestion(scope, q.questionId, { actor: actors.system("autopilot") })).toMatchObject({ decided: false, code: "high_sensitivity" });
  });

  it("a question that depends on an open question waits for it", async () => {
    const scope = await fullAutoNovel();
    const first = await ask(scope, draft(scope, { title: "먼저 정할 것", sensitivity: "high" }));
    const second = await ask(scope, draft(scope, { title: "그다음 정할 것", dependsOnQuestionId: first.questionId }));
    clock.advance(24 * 3600_000);
    const r = await t.modules.autopilot.service.tick(scope);
    expect(r.answered).not.toContain(second.questionId);
    expect(await t.modules.hitl.service.autoAnswerQuestion(scope, second.questionId, { actor: actors.system("autopilot") })).toMatchObject({ decided: false, code: "depends_on_open" });
  });

  it("re-enabling full_auto without the opt-ins works and turns the stored opt-ins off", async () => {
    const scope = await fullAutoNovel({ autoApproveStructure: true, autoConfirmConcept: true });
    expect((await t.http("PUT", `/api/novels/${scope.novelId}/autonomy`, { autonomyLevel: "episode_approval" })).status).toBe(200);
    const again = await t.http("PUT", `/api/novels/${scope.novelId}/autonomy`, { autonomyLevel: "full_auto", publishPolicy: "manual", acknowledgedFullAutoWarning: true, acknowledgedAutoItems: true });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    const s = dto.parseAutopilotSettings((await t.modules.novel.service.getNovel(scope)).autopilotSettings);
    expect(s).toMatchObject({ autoApproveStructure: false, autoConfirmConcept: false });
    // opting in again still needs its own acknowledgement
    expect((await t.http("PUT", `/api/novels/${scope.novelId}/autonomy`, { autonomyLevel: "episode_approval" })).status).toBe(200);
    const optIn = await t.http("PUT", `/api/novels/${scope.novelId}/autonomy`, {
      autonomyLevel: "full_auto",
      acknowledgedFullAutoWarning: true,
      acknowledgedAutoItems: true,
      autopilot: { autoApproveStructure: true },
    });
    expect(optIn.status).toBe(422);
  });

  it("a transient auto-decision error is retried, not held; repeated failures go to the author", async () => {
    const { scope } = await planningNovel(t, { title: "일시 오류" });
    await enableFullAuto(t, scope, {});
    const req = await bibleAwaiting(t, scope);
    const spy = vi.spyOn(t.modules.hitl.service, "autoDecideApproval").mockResolvedValue({ decided: false, code: "transient", reason: "canceling statement due to lock timeout" });
    try {
      await t.modules.autopilot.service.tick(scope);
      await t.modules.autopilot.service.tick(scope);
      let a = await t.modules.hitl.service.getApproval(scope, req.approvalId);
      expect((a.payload as { autopilot?: { heldReason?: string } } | null)?.autopilot?.heldReason).toBeUndefined();
      await t.modules.autopilot.service.tick(scope);
      a = await t.modules.hitl.service.getApproval(scope, req.approvalId);
      expect((a.payload as { autopilot?: { heldReason?: string } }).autopilot?.heldReason).toContain("3번 연속 실패");
    } finally {
      spy.mockRestore();
    }
    expect((await auditActions(t, scope, "autopilot.gate_hit")).filter((e) => (e.details as { key?: string }).key === `approval:${req.approvalId}`)).toHaveLength(1);
  });

  it("a gate notice is sent once even when the tick fails afterwards", async () => {
    const { scope } = await planningNovel(t, { title: "알림 한 번" });
    await enableFullAuto(t, scope, { autoApproveBible: false });
    await bibleAwaiting(t, scope);
    const spy = vi.spyOn(t.modules.hitl.service, "listQuestions").mockRejectedValue(new Error("boom"));
    try {
      await expect(t.modules.autopilot.service.tick(scope)).rejects.toThrow("boom");
      await expect(t.modules.autopilot.service.tick(scope)).rejects.toThrow("boom");
    } finally {
      spy.mockRestore();
    }
    await t.modules.autopilot.service.tick(scope);
    expect((await auditActions(t, scope, "autopilot.gate_hit")).length).toBe(1);
  });

  it("resuming after a monthly budget warning does not halt again on the same warning", async () => {
    const { scope } = await planningNovel(t, { title: "예산 경고 재개" });
    await enableFullAuto(t, scope, {});
    await t.modules.budget.service.updatePolicy(scope, "all", { hardLimitMicros: 1_000_000, softWarnRatio: 0.5 }, t.owner);
    const [p] = await t.testDb.query<{ id: string; version_no: number }>("SELECT id, version_no FROM provider_profiles ORDER BY created_at LIMIT 1");
    await t.platform.uow.run((tx) =>
      t.modules.budget.service.recordDirectCost(tx, scope, { idempotencyKey: "img:warn-resume", category: "image", provider: "openai", modelId: "gpt-image-1", providerProfileId: p!.id, providerProfileVersion: p!.version_no, basis: "measured", amountMicros: 600_000, reservedMicros: 600_000 }),
    );
    expect((await t.modules.autopilot.service.tick(scope)).skipped).toBe("halted");
    expect((await t.http("POST", `/api/novels/${scope.novelId}/autopilot/resume`)).status).toBe(200);
    const r = await t.modules.autopilot.service.tick(scope);
    expect(r.skipped).toBeNull();
    expect((await t.modules.novel.service.getNovel(scope)).autopilotHaltedAt).toBeNull();
  });

  it("a wait that lasts over an hour shows in the banner and is notified once (not held)", async () => {
    const { scope } = await planningNovel(t, { title: "오래 기다림" });
    await enableFullAuto(t, scope, {});
    // a bible approval whose bible is no longer the latest version → wait (decided / cancelled by the owner, not held)
    const req = await bibleAwaiting(t, scope);
    await t.platform.uow.run(async (tx) => {
      const n = await t.modules.novel.service.getNovel(scope, tx);
      await t.modules.novel.service.createBibleVersion(tx, scope, { logline: "새 로그라인", synopsis: "새 시놉시스", content: {}, contentMd: "# 기획서 2", conceptBriefId: n.approvedConceptBriefId! }, SYS);
    });
    await t.modules.autopilot.service.tick(scope);
    expect((await auditActions(t, scope, "autopilot.gate_hit")).filter((e) => (e.details as { key?: string }).key === `wait:${req.approvalId}`)).toHaveLength(0);
    clock.advance(61 * 60_000);
    await t.modules.autopilot.service.tick(scope);
    await t.modules.autopilot.service.tick(scope);
    expect((await auditActions(t, scope, "autopilot.gate_hit")).filter((e) => (e.details as { key?: string }).key === `wait:${req.approvalId}`)).toHaveLength(1);
    const v = dto.autopilotViewSchema.parse((await t.http("GET", `/api/novels/${scope.novelId}/autopilot`)).body);
    expect(v.waitingHuman.some((w) => w.approvalId === req.approvalId && w.title.includes("자동 승인 대기"))).toBe(true);
    const a = await t.modules.hitl.service.getApproval(scope, req.approvalId);
    expect((a.payload as { autopilot?: { heldReason?: string } } | null)?.autopilot?.heldReason).toBeUndefined();
  });
});

describe("kill switch during a tick", () => {
  let t: TestCore;
  let scope: Scope;
  beforeAll(async () => {
    t = await createTestCore();
    scriptWorld(t.claude);
    ({ scope } = await approvedConceptNovel(t, "멈춤 경합"));
    await enableFullAuto(t, scope, {});
  });
  afterAll(() => t.close());

  it("a halt that lands while the tick reads its facts stops every front step of that tick", async () => {
    const orig = t.modules.cast.service.getCast.bind(t.modules.cast.service);
    let halted = false;
    const spy = vi.spyOn(t.modules.cast.service, "getCast").mockImplementation(async (s) => {
      if (!halted) {
        halted = true;
        await t.modules.autopilot.service.halt(scope, { alsoPauseTasks: false }, t.owner);
      }
      return orig(s);
    });
    try {
      const r = await t.modules.autopilot.service.tick(scope);
      expect(r.steps).toEqual([]);
    } finally {
      spy.mockRestore();
    }
    expect(await auditActions(t, scope, "autopilot.step")).toHaveLength(0);
    // control: after resuming the same tick runs its steps
    await t.modules.autopilot.service.resume(scope, t.owner);
    expect((await t.modules.autopilot.service.tick(scope)).steps.length).toBeGreaterThan(0);
  });
});

describe("unchecked concept is not auto-confirmed", () => {
  let t: TestCore;
  beforeAll(async () => {
    t = await createTestCore();
    // the similarity / safety check has no model (placeholder port → `proposal: null`): the check did not run
    const calls = t.modules.llm.service.modelCalls;
    const orig = calls.call.bind(calls);
    vi.spyOn(calls, "call").mockImplementation(((req: { purpose: string }) => {
      if (req.purpose === "check_concept_brief") throw new NotImplementedError("llm");
      return orig(req as never);
    }) as never);
    scriptWorld(t.claude);
  });
  afterAll(() => t.close());

  it("goes to the author (concept_unchecked) instead of being approved", async () => {
    const created = await t.http("POST", "/api/novels", { title: "점검 실패", entryMode: "direct_input" });
    const scope = { novelId: created.body.id as string };
    const base = `/api/novels/${scope.novelId}`;
    const view = await t.http("GET", `${base}/concept/session`);
    const sessionId = (view.body.session?.id ?? view.body.id) as string;
    const REQUIRED: Array<[string, unknown]> = [
      ["category.genre_label", "현판"],
      ["age_rating", "age_15"],
      ["protagonist.starting_condition", "회귀 전 S급 헌터에게 배신당해 죽은 F급 짐꾼"],
      ["protagonist.desire", "배신자에게 복수"],
      ["opposition", "S급 길드장과 그의 길드"],
      ["core_hook", "짐꾼만 볼 수 있는 던전의 균열"],
      ["world_rules[item_key=power_rank]", "F~S급"],
      ["ending_direction", "복수를 끝내고 새 길드를 세운다"],
      ["logline", "회귀한 짐꾼이 배신자에게 복수한다"],
    ];
    for (const [path, value] of REQUIRED) expect((await t.http("PATCH", `${base}/concept/sessions/${sessionId}/brief`, { path, value })).status).toBe(200);
    await enableFullAuto(t, scope, { autoConfirmConcept: true });
    const brief = async () => (await t.testDb.db.select().from(approvals).where(and(eq(approvals.novelId, scope.novelId), eq(approvals.approvalType, "concept_brief"))))[0];
    await drain(t, scope, async () => !!(await brief()), 30);
    await t.modules.autopilot.service.tick(scope);
    const row = (await brief())!;
    expect(row).toMatchObject({ status: "pending", autoDecided: false });
    expect((row.payload as { autopilot?: { heldReason?: string } }).autopilot?.heldReason).toContain("점검");
    expect((await t.modules.novel.service.getNovel(scope)).status).toBe("concept");
  });
});

describe("arc_approval → full_auto hand-over", () => {
  let t: TestCore;
  let scope: Scope;
  beforeAll(async () => {
    t = await createTestCore();
    t.claude.reply({ times: Infinity, when: { schemaHas: ["new_setups"] }, json: { new_setups: [], existing_setup_beats: [], rationale: "새 떡밥 없음" } });
    scriptPipeline(t.claude);
    ({ scope } = await planningNovel(t, { title: "수준 전환" })); // reserve target 2, plots of 3 episodes
    expect((await t.http("PUT", `/api/novels/${scope.novelId}/autonomy`, { autonomyLevel: "arc_approval" })).status).toBe(200);
    await bibleApproved(t, scope);
    await approveStructure(t, scope);
    await drain(t, scope, async () => (await t.modules.novel.service.listArcs(scope)).some((a) => a.status === "plan_awaiting_approval"));
    expect((await decideApproval(t, scope, "arc_plan", "approved")).status).toBeLessThan(300);
  }, 60_000);
  afterAll(() => t.close());

  const pending = (types: dto.ApprovalType[]) => t.modules.hitl.service.listApprovals(scope, { statuses: ["pending"], types });
  const eps = async () => (await t.modules.manuscript.service.listEpisodes(scope)).sort((a, b) => a.episodeNo - b.episodeNo).slice(0, 3);

  it("episodes waiting for a plot batch get their own requests (the batch is cancelled) and the autopilot approves them", async () => {
    await drain(t, scope, async () => (await pending(["arc"])).length > 0, 150);
    const batch = (await pending(["arc"]))[0]!;
    expect((await eps()).map((e) => e.status)).toEqual(["awaiting_approval", "awaiting_approval", "planned"]);
    await enableFullAuto(t, scope, {});
    const sched = await t.modules.manuscript.service.schedule(scope);
    expect(sched.notes).toContain("episode_approvals_requested:2");
    expect((await t.modules.hitl.service.getApproval(scope, batch.id)).status).toBe("cancelled");
    expect((await pending(["episode"])).length).toBe(2);
    const r = await t.modules.autopilot.service.tick(scope);
    expect(r.decided.filter((d) => d.startsWith("episode:"))).toHaveLength(2);
    expect((await eps()).slice(0, 2).map((e) => e.status)).toEqual(["approved", "approved"]);
    // nothing is requested twice
    expect((await t.modules.manuscript.service.schedule(scope)).notes.some((n) => n.startsWith("episode_approvals_requested"))).toBe(false);
  });
});

describe("AR6: a batch that leaves a waiting episode out does not complete the plot", () => {
  let t: TestCore;
  let scope: Scope;
  beforeAll(async () => {
    t = await createTestCore();
    t.claude.reply({ times: Infinity, when: { schemaHas: ["new_setups"] }, json: { new_setups: [], existing_setup_beats: [], rationale: "새 떡밥 없음" } });
    scriptPipeline(t.claude);
    ({ scope } = await planningNovel(t, { title: "부분 묶음" }));
    expect((await t.http("PUT", `/api/novels/${scope.novelId}/autonomy`, { autonomyLevel: "arc_approval" })).status).toBe(200);
    await bibleApproved(t, scope);
    await approveStructure(t, scope);
    await drain(t, scope, async () => (await t.modules.novel.service.listArcs(scope)).some((a) => a.status === "plan_awaiting_approval"));
    expect((await decideApproval(t, scope, "arc_plan", "approved")).status).toBeLessThan(300);
  }, 60_000);
  afterAll(() => t.close());

  it("the plot goes back to active while the left-out episode still waits; its own approval completes the plot", async () => {
    const pendingArc = async () => (await t.modules.hitl.service.listApprovals(scope, { statuses: ["pending"], types: ["arc"] }))[0];
    await drain(t, scope, async () => !!(await pendingArc()), 150);
    const first = (await pendingArc())!;
    // the batch names only episode 1 (as if episode 2 were under the floor and kept its own request); the plot is
    // moved to awaiting_approval as by a final batch
    const [e1, e2] = (await t.modules.manuscript.service.listEpisodes(scope)).sort((a, b) => a.episodeNo - b.episodeNo);
    await t.testDb.db.update(approvals).set({ payload: { episodeIds: [e1!.id], episodeNos: [1], partial: false } }).where(eq(approvals.id, first.id));
    await t.platform.uow.run((tx) => t.modules.novel.service.transitionArc(tx, scope, first.subjectId, "awaiting_approval", SYS, { arcApprovalId: first.id }));
    expect((await decideApproval(t, scope, "arc", "approved")).status).toBeLessThan(300);
    expect((await t.modules.manuscript.service.getEpisode(scope, e1!.id)).status).toBe("approved");
    expect((await t.modules.manuscript.service.getEpisode(scope, e2!.id)).status).toBe("awaiting_approval");
    expect((await t.modules.novel.service.getArc(scope, first.subjectId)).status).toBe("active"); // AR6, not AR7
  });
});

describe("an unnamed protagonist gets its name from the cast fill", () => {
  let t: TestCore;
  beforeAll(async () => {
    t = await createTestCore();
    scriptWorld(t.claude);
    scriptCastFill(t.claude, "한결");
  });
  afterAll(() => t.close());

  it("the placeholder name is replaced (origin agent) and the cast is confirmed without a human", async () => {
    const { protagonist, ...rest } = BRIEF_CONTENT;
    const hero: Record<string, unknown> = { ...protagonist };
    delete hero.name; // the brief protagonist has no name → the cast seeds "이름 미정"
    const { scope } = await approvedConceptNovel(t, "이름 없는 주인공", { ...rest, protagonist: hero });
    const before = await t.modules.cast.service.getCast(scope);
    expect(before.items.find((c) => c.role === "protagonist")!.name).toBe("이름 미정");
    await enableFullAuto(t, scope, {});
    await drain(t, scope, async () => (await t.modules.cast.service.getCast(scope)).confirmed, 60);
    const hero2 = (await t.modules.cast.service.getCast(scope)).items.find((c) => c.role === "protagonist")!;
    expect(hero2.name).toBe("한결");
    expect(hero2.fieldOrigins).toMatchObject({ name: "agent", desire: "user" });
  });
});
