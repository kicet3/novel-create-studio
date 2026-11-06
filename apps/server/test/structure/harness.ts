/**
 * Harness of the story-structure tests (설계 추가 0008): a planning novel with an approved concept brief, a drain loop
 * over the real engine + scheduler, and approval helpers that go through the real hitl decision path.
 */
import { eq } from "@ncs/db/orm";
import { conceptBriefs, conceptSessions } from "@ncs/db/schema";
import { expect } from "vitest";
import { manuscriptTestHooks } from "../../src/modules/manuscript/module.js";
import { completeTestCast, confirmTestCast } from "../support/cast.js";
import type { TestCore } from "../support/test-core.js";

export type Scope = { novelId: string };

export async function drain(t: TestCore, scope: Scope, until: () => Promise<boolean>, max = 80): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (await until()) return;
    await t.testDb.exec(`UPDATE tasks SET not_before_at = NULL WHERE novel_id = '${scope.novelId}' AND status = 'ready'`);
    await t.testDb.exec(`UPDATE wake_requests SET not_before_at = NULL WHERE novel_id = '${scope.novelId}' AND status = 'pending'`);
    const ran = await t.modules.orchestration.service.runOnce();
    const sched = await t.modules.manuscript.service.schedule(scope);
    // 설계 추가 0014: full_auto novels move on through the autopilot (no-op for other levels)
    const auto = await t.modules.autopilot.service.tick(scope);
    if (auto.decided.length || auto.steps.length || auto.answered.length || auto.published.length) continue;
    if (!ran && !sched.createdTasks.length && !(await t.modules.orchestration.service.runOnce()) && i > 6) break;
  }
  if (!(await until())) {
    const tasks = await t.modules.orchestration.service.listTasks(scope, { includeCancelled: true, limit: 300 });
    const unscripted = t.claude.unmatched.map((r) => `${r.system.slice(0, 60)} | ${Object.keys((r.schema?.properties ?? {}) as object).join(",")}`);
    throw new Error(`stalled: ${JSON.stringify(tasks.map((x) => [x.kind, x.status, x.blockReason, x.latestRun?.errorMessage]))} unscripted: ${JSON.stringify(unscripted)}`);
  }
}

/** novel in planning: approved brief, cast (complete or only confirmed), goal of `episodes` episodes */
export async function planningNovel(t: TestCore, opts: { complete?: boolean; episodes?: number; title?: string } = {}) {
  const nv = t.modules.novel.service;
  const novel = await nv.createNovel({ title: opts.title ?? "회귀자의 흉터" }, t.owner);
  const scope = { novelId: novel.id };
  const [session] = await t.testDb.db.select().from(conceptSessions).where(eq(conceptSessions.novelId, novel.id));
  const briefId = t.platform.ids.next("cbf");
  await t.testDb.db.insert(conceptBriefs).values({
    id: briefId,
    novelId: novel.id,
    sessionId: session!.id,
    versionNo: 1,
    authorActorType: "user",
    authorActorId: t.ownerId,
    entryMode: "conversation",
    questionSetVersion: "common@1",
    content: { logline: "회귀한 검사가 흉터의 비밀을 쫓는다" },
    contentMd: "# 브리프",
  } as typeof conceptBriefs.$inferInsert);
  await t.platform.uow.run((tx) => nv.applyConceptApproval(tx, scope, { conceptBriefId: briefId, purpose: "initial", genre: "회귀 판타지", ageRating: "age_15", category: {} }, t.owner));
  if (opts.complete === false) await confirmTestCast(t, novel.id, "한결");
  else await completeTestCast(t, novel.id, "한결");
  const total = opts.episodes ?? 12;
  await nv.saveGoal(scope, { totalEpisodesMin: total, totalEpisodesMax: total, cadenceEpisodesPerWeek: 5, reserveTargetEpisodes: 2, endingDirection: "흉터의 비밀을 밝히고 회귀를 끝낸다", notes: null }, t.owner);
  return { novel, scope };
}

/** the hitl decision path of a pending approval (inbox `POST …/approvals/:id/decision`) */
export async function decideApproval(t: TestCore, scope: Scope, type: string, decision: "approved" | "rejected", body: Record<string, unknown> = {}) {
  const list = await t.http("GET", `/api/novels/${scope.novelId}/approvals?status=pending`);
  const a = (list.body.items as Array<{ id: string; approvalType: string }>).find((x) => x.approvalType === type);
  expect(a, `pending ${type} approval`).toBeTruthy();
  return t.http("POST", `/api/novels/${scope.novelId}/approvals/${a!.id}/decision`, { decision, ...body });
}

export async function bibleApproved(t: TestCore, scope: Scope) {
  await drain(t, scope, async () => (await t.modules.novel.service.listBibles(scope)).some((b) => b.status === "awaiting_approval"));
  const r = await decideApproval(t, scope, "series_bible", "approved");
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
}

export async function structureAwaiting(t: TestCore, scope: Scope) {
  await drain(t, scope, async () => (await t.modules.novel.service.getStructure(scope))?.status === "awaiting_approval");
  return (await t.modules.novel.service.getStructure(scope))!;
}

export async function approveStructure(t: TestCore, scope: Scope) {
  const s = await structureAwaiting(t, scope);
  const r = await t.http("POST", `/api/novels/${scope.novelId}/structure/decision`, { decision: "approved", expectedRevision: s.revision });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}

export const hooks = (t: TestCore) => manuscriptTestHooks.get(t.modules.manuscript.service)!;
