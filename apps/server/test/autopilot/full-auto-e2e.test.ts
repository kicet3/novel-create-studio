/**
 * 설계 추가 0014 — 완전 자율 end-to-end: from a concept the author approved, ONE human action (PUT /autonomy with the
 * acknowledgements and the "구성·결말도 자동 승인" opt-in, scheduled publishing) and then only the engine, the scheduler
 * and the autopilot loop: world candidates → cast fill + confirm → goal → bible → structure → plot plan → episodes →
 * approvals → scheduled publishing. No human answer is recorded after the switch.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "@ncs/db/orm";
import { answers, approvals } from "@ncs/db/schema";
import * as dto from "@ncs/shared";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { scriptPipeline } from "../support/pipeline-script.js";
import { scriptWorld } from "../support/world.js";
import { drain } from "../structure/harness.js";
import { approvedConceptNovel, auditActions, enableFullAuto, scriptCastFill, type Scope } from "./harness.js";

describe("full_auto end to end", () => {
  let t: TestCore;
  let scope: Scope;
  let switchedAt: Date;
  beforeAll(async () => {
    t = await createTestCore();
    scriptWorld(t.claude);
    scriptCastFill(t.claude);
    // no setups (a planted beat the scripted check never finds would end in the rewrite limit — a human gate)
    t.claude.reply({ times: Infinity, when: { schemaHas: ["new_setups"] }, json: { new_setups: [], existing_setup_beats: [], rationale: "새 떡밥 없음" } });
    scriptPipeline(t.claude);
    ({ scope } = await approvedConceptNovel(t));
    switchedAt = new Date();
    await enableFullAuto(t, scope, { autoApproveStructure: true, autoConfirmConcept: true, maxEpisodesPerDay: 3 }, "scheduled");
  });
  afterAll(() => t.close());

  it("reaches three approved episodes without any human action", async () => {
    const approved = async () => (await t.modules.manuscript.service.listEpisodes(scope)).filter((e) => e.status === "approved" || e.status === "published").length;
    await drain(t, scope, async () => (await approved()) >= 3, 400);

    // the front steps ran on the author's behalf
    const steps = (await auditActions(t, scope, "autopilot.step")).map((e) => (e.after as { step?: string }).step);
    expect(steps).toEqual(expect.arrayContaining(["world_approve", "cast_fill", "cast_confirm", "goal_save"]));
    const world = dto.worldOntologyViewSchema.parse((await t.http("GET", `/api/novels/${scope.novelId}/world-ontology`)).body);
    expect(world.counts.approved).toBeGreaterThan(0);
    const cast = await t.modules.cast.service.getCast(scope);
    expect(cast.confirmed).toBe(true);
    expect(cast.completeness.complete).toBe(true);
    const hero = cast.items.find((c) => c.role === "protagonist")!;
    expect(hero.fieldOrigins).toMatchObject({ desire: "user", appearance: "agent" }); // user-authored field kept, agent fill marked agent
    const goal = (await t.modules.novel.service.getGoal(scope))!;
    expect(goal).toMatchObject({ totalEpisodesMin: 12, cadenceEpisodesPerWeek: 7, endingDirection: "흉터의 비밀을 밝히고 회귀를 끝낸다" });

    // every gate was an approval row decided automatically (approved only, no deciding user)
    const rows = await t.testDb.db.select().from(approvals).where(eq(approvals.novelId, scope.novelId));
    const auto = rows.filter((r) => r.autoDecided);
    expect(new Set(auto.map((r) => r.approvalType))).toEqual(new Set(["series_bible", "story_structure", "arc_plan", "episode"]));
    for (const r of auto) expect(r).toMatchObject({ status: "approved", decidedByUserId: null });
    const decided = await auditActions(t, scope, "autopilot.approval_decided");
    expect(new Set(decided.map((e) => (e.after as { approvalType: string }).approvalType))).toEqual(new Set(["series_bible", "story_structure", "arc_plan", "episode"]));
    const ap = (await auditActions(t, scope, "approval.decided")).filter((e) => (e.details as { auto?: boolean } | null)?.auto);
    expect(ap.length).toBe(auto.length);
    expect(ap.every((e) => e.actorType === "system" && e.actorId === "autopilot")).toBe(true);
    // answers after the switch: only auto answers (provenance), none by a human
    const human = await t.testDb.db.select().from(answers).where(and(eq(answers.novelId, scope.novelId), eq(answers.autoAnswered, false), sql`${answers.createdAt} >= ${switchedAt.toISOString()}`));
    expect(human).toHaveLength(0);
    const autoAnswered = await t.testDb.db.select().from(answers).where(and(eq(answers.novelId, scope.novelId), eq(answers.autoAnswered, true)));
    expect(autoAnswered.length).toBe(auto.length);
    const qs = await t.testDb.query<{ resolution_source: string }>(`SELECT resolution_source FROM questions WHERE novel_id = '${scope.novelId}' AND approval_id IN (SELECT id FROM approvals WHERE auto_decided)`);
    expect(qs.every((q) => q.resolution_source === "auto_answer")).toBe(true);

    // the daily cap: three episodes started today, the fourth waits for tomorrow
    const started = (await t.modules.manuscript.service.listEpisodes(scope)).filter((e) => e.status !== "planned");
    expect(started.length).toBe(3);
    const sched = await t.modules.manuscript.service.schedule(scope);
    expect(sched.notes).toContain("autopilot:daily_episode_cap");
    const view = dto.autopilotViewSchema.parse((await t.http("GET", `/api/novels/${scope.novelId}/autopilot`)).body);
    expect(view).toMatchObject({ active: true, level: "full_auto", today: { startedEpisodes: 3, maxEpisodes: 3 } });
    expect(view.recent.some((e) => e.action === "autopilot.approval_decided")).toBe(true);
  });

  it("publishes the approved episodes in order at their scheduled slots", async () => {
    await t.modules.autopilot.service.tick(scope);
    const eps = (await t.modules.manuscript.service.listEpisodes(scope)).filter((e) => e.status === "approved").sort((a, b) => a.episodeNo - b.episodeNo);
    expect(eps.length).toBe(3);
    for (const e of eps) expect(e.scheduledPublishAt).not.toBeNull();
    // one slot a day (7 a week) at 18:00 Asia/Seoul, in episode order
    const times = eps.map((e) => e.scheduledPublishAt!.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    for (const x of times) expect(new Date(x).getUTCHours()).toBe(9);
    expect((await auditActions(t, scope, "episode.publish_scheduled")).length).toBe(3);
    // the slots arrive (test time travel: the schedule moves to the past)
    await t.testDb.exec(`UPDATE episodes SET scheduled_publish_at = now() - interval '1 minute' * episode_no WHERE novel_id = '${scope.novelId}' AND status = 'approved'`);
    const r = await t.modules.autopilot.service.tick(scope);
    expect(r.published).toHaveLength(3);
    const pub = (await t.modules.manuscript.service.listEpisodes(scope)).filter((e) => e.status === "published");
    expect(pub.map((e) => e.episodeNo).sort()).toEqual([1, 2, 3]);
    expect(pub.every((e) => e.publishedByActorType === "system" && e.publishedByActorId === "autopilot")).toBe(true);
  });
});

describe("full_auto + 컨셉 확정 자동 승인 (opt-in)", () => {
  let t: TestCore;
  beforeAll(async () => {
    t = await createTestCore();
    t.claude.reply({ times: Infinity, when: { schemaHas: ["llm_overlap_signals"] }, json: { llm_overlap_signals: [], safety_flags: [], notes: [] } });
    scriptWorld(t.claude);
  });
  afterAll(() => t.close());

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

  it("the autopilot submits the filled brief and approves the first concept (no safety / similarity signal)", async () => {
    const created = await t.http("POST", "/api/novels", { title: "회귀 짐꾼", entryMode: "direct_input" });
    const scope = { novelId: created.body.id as string };
    const base = `/api/novels/${scope.novelId}`;
    const view = await t.http("GET", `${base}/concept/session`);
    const sessionId = (view.body.session?.id ?? view.body.id) as string;
    for (const [path, value] of REQUIRED) expect((await t.http("PATCH", `${base}/concept/sessions/${sessionId}/brief`, { path, value })).status).toBe(200);
    await enableFullAuto(t, scope, { autoConfirmConcept: true });
    await drain(t, scope, async () => (await t.modules.novel.service.getNovel(scope)).status === "onboarding", 30);
    const brief = (await t.modules.concept.service.getApprovedBrief(scope))!;
    expect(brief.authorActorType).toBe("user"); // the brief stays the author's (delegated), only the decision is automatic
    const [row] = await t.testDb.db.select().from(approvals).where(and(eq(approvals.novelId, scope.novelId), eq(approvals.approvalType, "concept_brief")));
    expect(row).toMatchObject({ status: "approved", autoDecided: true, decidedByUserId: null });
    expect((await auditActions(t, scope, "autopilot.step")).some((e) => (e.after as { step?: string }).step === "concept_submit")).toBe(true);
  });

  it("without the opt-in the concept waits for the author (human gate, notice once)", async () => {
    const created = await t.http("POST", "/api/novels", { title: "수동 컨셉", entryMode: "direct_input" });
    const scope = { novelId: created.body.id as string };
    await enableFullAuto(t, scope, {});
    await t.modules.autopilot.service.tick(scope);
    await t.modules.autopilot.service.tick(scope);
    const v = dto.autopilotViewSchema.parse((await t.http("GET", `/api/novels/${scope.novelId}/autopilot`)).body);
    expect(v.phase).toBe("concept");
    expect(v.waitingHuman.map((w) => w.kind)).toContain("concept_confirm");
    expect((await auditActions(t, scope, "autopilot.gate_hit")).filter((e) => (e.details as { key?: string }).key === "step:concept_confirm")).toHaveLength(1);
  });
});
