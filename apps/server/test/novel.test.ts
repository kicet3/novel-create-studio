import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "@ncs/db/orm";
import { budgetPolicies, channels, conceptBriefs, conceptSessions, ontologySchemaVersions, roleModelBindings, timelines } from "@ncs/db/schema";
import { AGENT_ROLE, newId } from "@ncs/shared";
import { actors, ConflictError, DomainValidationError, InvalidTransitionError } from "../src/platform/index.js";
import type { GoalSavedContext } from "../src/modules/novel/index.js";
import { createTestCore, type TestCore } from "./support/test-core.js";
import { confirmTestCast } from "./support/cast.js";

let t: TestCore;
const goalHookCalls: GoalSavedContext[] = [];
beforeAll(async () => {
  t = await createTestCore();
  t.modules.novel.service.onGoalSaved(async (ctx) => void goalHookCalls.push(ctx));
});
afterAll(() => t.close());

const goalInput = {
  totalEpisodesMin: 100,
  totalEpisodesMax: 120,
  cadenceEpisodesPerWeek: 7,
  reserveTargetEpisodes: 5,
  endingDirection: "주인공이 탑을 정복한다",
  notes: null,
};

async function insertBrief(novelId: string) {
  const db = t.testDb.db;
  const [session] = await db.select().from(conceptSessions).where(eq(conceptSessions.novelId, novelId));
  const id = newId("cbf");
  await db.insert(conceptBriefs).values({
    id,
    novelId,
    sessionId: session!.id,
    versionNo: 1,
    authorActorType: "user",
    authorActorId: t.ownerId,
    entryMode: "conversation",
    questionSetVersion: "common@1",
    content: {},
    contentMd: "# 컨셉",
  });
  return id;
}

async function approveConcept(novelId: string, opts: { confirmCast?: boolean } = {}) {
  const briefId = await insertBrief(novelId);
  await t.platform.uow.run((tx) =>
    t.modules.novel.service.applyConceptApproval(
      tx,
      { novelId },
      { conceptBriefId: briefId, purpose: "initial", title: "탑의 회귀자", genre: "현대판타지 · 헌터, 회귀", ageRating: "age_15", category: { genre_label: "현대판타지" } },
      t.owner,
    ),
  );
  // 캐릭터 설정 단계: the goal (N3) needs a confirmed cast
  if (opts.confirmCast !== false) await confirmTestCast(t, novelId);
  return briefId;
}

describe("novel N1 (creation set, INV-NOV-06)", () => {
  it("creates novel(concept) + schema v1 + main timeline + web channel + budget policy + all role bindings + concept session", async () => {
    const svc = t.modules.novel.service;
    const novel = await svc.createNovel({ title: "새 작품", entryMode: "conversation" }, t.owner);
    expect(novel.status).toBe("concept");
    const db = t.testDb.db;
    const where = <T extends { novelId: unknown }>(tbl: T) => eq((tbl as never as { novelId: never }).novelId, novel.id as never);
    expect(await db.select().from(ontologySchemaVersions).where(where(ontologySchemaVersions))).toHaveLength(1);
    expect((await db.select().from(ontologySchemaVersions).where(where(ontologySchemaVersions)))[0]!.id).toBe(novel.activeSchemaVersionId);
    expect(await db.select().from(timelines).where(where(timelines))).toHaveLength(1);
    const ch = await db.select().from(channels).where(where(channels));
    expect(ch.map((c) => [c.kind, c.status])).toEqual([["web", "active"]]);
    expect(await db.select().from(budgetPolicies).where(where(budgetPolicies))).toHaveLength(1);
    expect((await db.select().from(roleModelBindings).where(where(roleModelBindings))).map((b) => b.agentRole).sort()).toEqual([...AGENT_ROLE].sort());
    const sessions = await db.select().from(conceptSessions).where(where(conceptSessions));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.activeChannelId).toBe(ch[0]!.id);
    expect(await svc.getGoal({ novelId: novel.id })).toBeNull(); // INV-NOV-05
    const actions = (await t.modules.audit.service.list({ novelId: novel.id })).items.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["novel.created", "concept_session.created"]));
    expect((await svc.getNotificationPolicy({ novelId: novel.id })).deadlineHoursBlocking).toBe(12);
    expect((await svc.getLengthProfile({ novelId: novel.id })).minChars).toBe(5000);
  });

  it("rejects age_19 in MVP (INV-NOV-01)", async () => {
    await expect(t.modules.novel.service.createNovel({ ageRating: "age_19" }, t.owner)).rejects.toBeInstanceOf(DomainValidationError);
  });
});

describe("novel status transitions N2/N3 + goal", () => {
  it("goal cannot be saved during concept (INV-NOV-05)", async () => {
    const n = await t.modules.novel.service.createNovel({}, t.owner);
    await expect(t.modules.novel.service.saveGoal({ novelId: n.id }, goalInput, t.owner)).rejects.toBeInstanceOf(DomainValidationError);
  });

  it("N2 applies M-01~M-05, N3 creates the goal and enters planning; revisions bump and check staleness", async () => {
    const svc = t.modules.novel.service;
    const n = await svc.createNovel({}, t.owner);
    const scope = { novelId: n.id };
    const briefId = await approveConcept(n.id, { confirmCast: false });
    let novel = await svc.getNovel(scope);
    expect(novel).toMatchObject({ status: "onboarding", title: "탑의 회귀자", genre: "현대판타지 · 헌터, 회귀", approvedConceptBriefId: briefId });

    // N2 twice is rejected
    await expect(
      t.platform.uow.run((tx) => svc.applyConceptApproval(tx, scope, { conceptBriefId: briefId, purpose: "initial", genre: "x", ageRating: "age_15", category: {} }, t.owner)),
    ).rejects.toBeInstanceOf(InvalidTransitionError);

    // 캐릭터 설정 단계 (cast guard): no confirmed cast → the first goal save is refused
    await expect(svc.saveGoal(scope, goalInput, t.owner)).rejects.toMatchObject({ code: "cast_not_confirmed", status: 422 });
    expect((await svc.getNovel(scope)).status).toBe("onboarding");
    await confirmTestCast(t, n.id);

    const g1 = await svc.saveGoal(scope, goalInput, t.owner);
    expect(g1.revision).toBe(1);
    novel = await svc.getNovel(scope);
    expect(novel.status).toBe("planning");
    const hook = goalHookCalls.find((c) => c.scope.novelId === n.id)!;
    expect(hook.enteredPlanning).toBe(true);
    expect(hook.previous).toBeNull();

    const g2 = await svc.saveGoal(scope, { ...goalInput, totalEpisodesMin: 110, expectedRevision: 1 }, t.owner);
    expect(g2.revision).toBe(2);
    expect(goalHookCalls.filter((c) => c.scope.novelId === n.id).at(-1)!.enteredPlanning).toBe(false);
    await expect(svc.saveGoal(scope, { ...goalInput, expectedRevision: 1 }, t.owner)).rejects.toBeInstanceOf(ConflictError);
    // unchanged save is a no-op
    expect((await svc.saveGoal(scope, { ...goalInput, totalEpisodesMin: 110 }, t.owner)).revision).toBe(2);

    const statusEvents = (await t.modules.audit.service.list(scope, { actionPrefix: "novel.status_changed" })).items;
    expect(statusEvents.map((e) => (e.after as { status: string }).status)).toEqual(["planning", "onboarding"]);
    expect((await t.modules.audit.service.list(scope, { actionPrefix: "goal." })).items).toHaveLength(2);
  });

  it("an ending direction change after the first save waits for an ending_change approval (03 Goal, 05 §10)", async () => {
    const svc = t.modules.novel.service;
    const n = await svc.createNovel({}, t.owner);
    const scope = { novelId: n.id };
    await approveConcept(n.id);
    await svc.saveGoal(scope, goalInput, t.owner);
    const saved = await svc.saveGoal(scope, { ...goalInput, totalEpisodesMin: 90, endingDirection: "주인공이 탑을 무너뜨린다" }, t.owner);
    expect(saved).toMatchObject({ revision: 2, totalEpisodesMin: 90, endingDirection: goalInput.endingDirection });
    expect(saved.pendingEndingChange?.endingDirection).toBe("주인공이 탑을 무너뜨린다");
    const pending = await t.modules.hitl.service.listApprovals(scope, { statuses: ["pending"], types: ["ending_change"] });
    expect(pending).toHaveLength(1);
    // approve over HTTP → applied, audit with approvalId
    const r = await t.http("POST", `/api/novels/${n.id}/questions/${pending[0]!.questionId}/answers`, { approval: { decision: "approved" } });
    expect(r.status).toBeLessThan(300);
    const g = await svc.getGoal(scope);
    expect(g).toMatchObject({ endingDirection: "주인공이 탑을 무너뜨린다", revision: 3 });
    const goalEvents = (await t.modules.audit.service.list(scope, { actionPrefix: "goal." })).items;
    expect(goalEvents.some((e) => e.approvalId === pending[0]!.id)).toBe(true);

    // rejected → unchanged
    const again = await svc.saveGoal(scope, { ...goalInput, totalEpisodesMin: 90, endingDirection: "다른 결말" }, t.owner);
    expect(again.endingDirection).toBe("주인공이 탑을 무너뜨린다");
    const p2 = (await t.modules.hitl.service.listApprovals(scope, { statuses: ["pending"], types: ["ending_change"] }))[0]!;
    const rj = await t.http("POST", `/api/novels/${n.id}/questions/${p2.questionId}/answers`, { approval: { decision: "rejected", decisionNote: "아니요" } });
    expect(rj.status).toBeLessThan(300);
    expect((await t.modules.hitl.service.getApproval(scope, p2.id)).status).toBe("rejected");
    expect((await svc.getGoal(scope))!.endingDirection).toBe("주인공이 탑을 무너뜨린다");
  });

  it("generic transitions follow the table (N4–N6) and reject the rest", async () => {
    const svc = t.modules.novel.service;
    const n = await svc.createNovel({}, t.owner);
    const scope = { novelId: n.id };
    const run = (to: Parameters<typeof svc.transitionStatus>[2]) => t.platform.uow.run((tx) => svc.transitionStatus(tx, scope, to, t.owner));
    await expect(run("serializing")).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(run("planning")).rejects.toBeInstanceOf(InvalidTransitionError); // only via saveGoal
    await approveConcept(n.id);
    await svc.saveGoal(scope, goalInput, t.owner);
    expect((await run("serializing")).status).toBe("serializing");
    expect((await run("completed")).status).toBe("completed");
    expect((await run("archived")).status).toBe("archived");
    await expect(run("completed")).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(svc.saveGoal(scope, goalInput, t.owner)).rejects.toBeInstanceOf(DomainValidationError);
  });
});

describe("novel settings", () => {
  it("autonomy: non-full_auto forces manual publish; full_auto needs the warning ack (INV-NOV-02/04)", async () => {
    const svc = t.modules.novel.service;
    const n = await svc.createNovel({}, t.owner);
    const scope = { novelId: n.id };
    await expect(svc.changeAutonomy(scope, { autonomyLevel: "full_auto", acknowledgedFullAutoWarning: false }, t.owner)).rejects.toBeInstanceOf(
      DomainValidationError,
    );
    const a = await svc.changeAutonomy(scope, { autonomyLevel: "full_auto", publishPolicy: "scheduled", acknowledgedFullAutoWarning: true }, t.owner);
    expect([a.autonomyLevel, a.publishPolicy]).toEqual(["full_auto", "scheduled"]);
    const b = await svc.changeAutonomy(scope, { autonomyLevel: "arc_approval", publishPolicy: "scheduled", acknowledgedFullAutoWarning: false }, t.owner);
    expect([b.autonomyLevel, b.publishPolicy]).toEqual(["arc_approval", "manual"]);
    expect((await t.modules.audit.service.list(scope, { actionPrefix: "novel.autonomy_changed" })).items).toHaveLength(2);
  });

  it("pause/resume set and clear paused_at with audit; settings diff only records changed fields", async () => {
    const svc = t.modules.novel.service;
    const n = await svc.createNovel({}, t.owner);
    const scope = { novelId: n.id };
    const p = await svc.pause(scope, "budget_hard_limit", actors.system("budget_guard"));
    expect(p.pausedAt).not.toBeNull();
    expect(p.pauseReason).toBe("budget_hard_limit");
    const r = await svc.resume(scope, t.owner);
    expect([r.pausedAt, r.pauseReason]).toEqual([null, null]);
    await svc.updateSettings(scope, { title: n.title, timezone: "Asia/Tokyo" }, t.owner);
    const [ev] = (await t.modules.audit.service.list(scope, { actionPrefix: "novel.settings_changed" })).items;
    expect(ev!.before).toEqual({ timezone: "Asia/Seoul" });
    expect(ev!.after).toEqual({ timezone: "Asia/Tokyo" });
  });

  it("length profile edits clone the install preset into a novel-owned profile", async () => {
    const svc = t.modules.novel.service;
    const n = await svc.createNovel({}, t.owner);
    const scope = { novelId: n.id };
    const preset = await svc.getLengthProfile(scope);
    expect(preset.novelId).toBeNull();
    const own = await svc.updateLengthProfile(scope, { minChars: 4000, maxChars: 4500 }, t.owner);
    expect(own.novelId).toBe(n.id);
    expect((await svc.getLengthProfile(scope)).id).toBe(own.id);
    expect((await svc.listLengthPresets())[0]!.minChars).toBe(5000);
    await expect(svc.updateLengthProfile(scope, { minChars: 9000 }, t.owner)).rejects.toBeInstanceOf(DomainValidationError);
  });
});

describe("arcs and series bibles", () => {
  it("arc ranges cannot overlap (INV-ARC-01) and status follows the arc table", async () => {
    const svc = t.modules.novel.service;
    const n = await svc.createNovel({}, t.owner);
    const scope = { novelId: n.id };
    const base = { goalText: "목표", conflictText: "갈등", endCondition: "끝" };
    const a1 = await svc.createArc(undefined, scope, { ...base, ord: 1, title: "1부", plannedEpisodeFrom: 1, plannedEpisodeTo: 30 }, t.owner);
    await expect(svc.createArc(undefined, scope, { ...base, ord: 2, title: "2부", plannedEpisodeFrom: 30, plannedEpisodeTo: 60 }, t.owner)).rejects.toBeInstanceOf(
      ConflictError,
    );
    const a2 = await svc.createArc(undefined, scope, { ...base, ord: 2, title: "2부", plannedEpisodeFrom: 31, plannedEpisodeTo: 60 }, t.owner);
    expect((await svc.findArcForEpisode(scope, 31))!.id).toBe(a2.id);
    const tr = (to: Parameters<typeof svc.transitionArc>[3]) => t.platform.uow.run((tx) => svc.transitionArc(tx, scope, a1.id, to, t.owner));
    await expect(tr("completed")).rejects.toBeInstanceOf(InvalidTransitionError);
    expect((await tr("plan_awaiting_approval")).status).toBe("plan_awaiting_approval");
    expect((await tr("active")).status).toBe("active");
    expect((await tr("completed")).status).toBe("completed");
    await expect(svc.updateArc(scope, a1.id, { title: "x" }, t.owner)).rejects.toBeInstanceOf(DomainValidationError);
    const paused = await svc.setArcPaused(scope, a2.id, true, t.owner);
    expect(paused.pausedAt).not.toBeNull();
  });

  it("approving a bible supersedes the previous approved version (INV-BIB-01)", async () => {
    const svc = t.modules.novel.service;
    const n = await svc.createNovel({}, t.owner);
    const scope = { novelId: n.id };
    const briefId = await approveConcept(n.id);
    const planner = actors.agent("planner", newId("run"));
    // agent actors need an existing run for activity_log? (no FK) — run id is recorded only
    const input = { logline: "로그라인", synopsis: "줄거리", content: {}, contentMd: "# 기획서", conceptBriefId: briefId };
    const { uow } = t.platform;
    const b1 = await uow.run((tx) => svc.createBibleVersion(tx, scope, input, planner));
    expect([b1.versionNo, b1.status]).toEqual([1, "draft"]);
    await uow.run((tx) => svc.transitionBible(tx, scope, b1.id, "awaiting_approval", planner));
    await expect(uow.run((tx) => svc.transitionBible(tx, scope, b1.id, "draft", planner).then(() => svc.transitionBible(tx, scope, b1.id, "approved", t.owner)))).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );
    await uow.run((tx) => svc.transitionBible(tx, scope, b1.id, "approved", t.owner));
    expect((await svc.getApprovedBible(scope))!.id).toBe(b1.id);
    const b2 = await uow.run((tx) => svc.createBibleVersion(tx, scope, input, planner));
    await uow.run(async (tx) => {
      await svc.transitionBible(tx, scope, b2.id, "awaiting_approval", planner);
      await svc.transitionBible(tx, scope, b2.id, "approved", t.owner);
    });
    expect((await svc.getBible(scope, b1.id)).status).toBe("superseded");
    expect((await svc.getApprovedBible(scope))!.id).toBe(b2.id);
    expect((await svc.listBibles(scope)).map((b) => b.versionNo)).toEqual([2, 1]);
  });
});

describe("novel HTTP", () => {
  it("POST/GET novels, goal flow errors, tenant 404", async () => {
    const created = await t.http("POST", "/api/novels", { title: "HTTP 작품" });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    expect((await t.http("GET", `/api/novels/${id}`)).body.title).toBe("HTTP 작품");
    expect((await t.http("GET", "/api/novels")).body.items.some((x: { id: string }) => x.id === id)).toBe(true);
    const goal = await t.http("PUT", `/api/novels/${id}/goal`, goalInput);
    expect(goal.status).toBe(422);
    expect(goal.body.error.code).toBe("concept_not_approved");
    expect((await t.http("PUT", `/api/novels/${id}/goal`, { ...goalInput, totalEpisodesMax: 1 })).status).toBe(400);
    expect((await t.http("PATCH", `/api/novels/${id}`, { timezone: "UTC" })).body.timezone).toBe("UTC");
    expect((await t.http("POST", `/api/novels/${id}/pause`, {})).body.pauseReason).toBe("user");
    expect((await t.http("GET", `/api/novels/${newId("nov")}`)).status).toBe(404);
    expect((await t.http("GET", `/api/novels/not-an-id/arcs`)).status).toBe(404);
    expect((await t.http("GET", "/api/me")).body.id).toBe(t.ownerId);
    const home = await t.http("GET", `/api/novels/${id}/home`);
    expect(home.status).toBe(200);
    expect(home.body.novel.id).toBe(id);
    expect(home.body.modules.novel).toBe(true);
  });
});
