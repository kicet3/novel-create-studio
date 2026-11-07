/** Shared pipeline helpers for the revision chat / sequential tests (same flow as test/manuscript/pipeline.test.ts). */
import { and, eq } from "@ncs/db/orm";
import { approvals, conceptBriefs, conceptSessions, questions } from "@ncs/db/schema";
import type { ApprovalType } from "@ncs/shared";
import { manuscriptTestHooks } from "../../src/modules/manuscript/module.js";
import type { TestCore } from "../support/test-core.js";
import { completeTestCast } from "../support/cast.js";

export function pipelineHelpers(t: TestCore) {
  const ms = () => t.modules.manuscript.service;
  const hooks = () => manuscriptTestHooks.get(ms())!;

  async function drain(scope: { novelId: string }, until?: () => Promise<boolean>, max = 80) {
    for (let i = 0; i < max; i++) {
      if (until && (await until())) return;
      await t.testDb.exec(`UPDATE tasks SET not_before_at = NULL WHERE novel_id = '${scope.novelId}' AND status = 'ready'`);
      const ran = await t.modules.orchestration.service.runOnce();
      const sched = await ms().schedule(scope);
      if (!ran && !sched.createdTasks.length && !until) return;
      if (!ran && !sched.createdTasks.length && until && !(await until())) {
        if (!(await t.modules.orchestration.service.runOnce())) break;
      }
    }
    if (until && !(await until())) {
      const tasks = await t.modules.orchestration.service.listTasks(scope, { includeCancelled: true, limit: 200 });
      const unscripted = t.claude.unmatched.map((r) => `${r.system.slice(0, 60)} | ${Object.keys((r.schema?.properties ?? {}) as object).join(",")}`);
      throw new Error(`pipeline stalled: ${JSON.stringify(tasks.map((x) => [x.kind, x.status, x.latestRun?.errorMessage]))} unscripted: ${JSON.stringify(unscripted)}`);
    }
  }

  async function arcPlanAwaiting(scope: { novelId: string }) {
    const arcs = await t.modules.novel.service.listArcs(scope);
    if (arcs.some((a) => a.status === "plan_awaiting_approval")) return true;
    const arc = arcs.find((a) => a.status === "planned");
    if (!arc || !(await ms().listEpisodes(scope, { arcId: arc.id })).length) return false;
    const setups = await t.modules.orchestration.service.listTasks(scope, { kinds: ["plan_setups"], targetId: arc.id });
    if (setups.length && setups.every((x) => x.status === "failed")) {
      await t.platform.uow.run((tx) => ms().requestArcPlanApproval(tx, scope, arc.id, t.owner));
      return true;
    }
    return false;
  }

  async function approvalFor(scope: { novelId: string }, type: ApprovalType, subjectType: "series_bible" | "arc" | "episode", subjectId: string) {
    const [existing] = await t.testDb.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.novelId, scope.novelId), eq(approvals.subjectId, subjectId), eq(approvals.approvalType, type), eq(approvals.status, "pending")));
    if (existing) return existing;
    const qid = t.platform.ids.next("qst");
    const aid = t.platform.ids.next("apr");
    await t.testDb.db.insert(questions).values({
      id: qid,
      novelId: scope.novelId,
      displayNo: Math.floor(Math.random() * 1e6) + 1000,
      grade: "informational",
      questionType: "approve_reject",
      topic: "approval_gate",
      title: "test approval",
      body: "test",
      rationale: "test",
      blockingBasis: "approval_gate",
      gradeReason: "test",
    });
    const [row] = await t.testDb.db
      .insert(approvals)
      .values({ id: aid, novelId: scope.novelId, approvalType: type, subjectType, subjectId, questionId: qid, requestedByActorType: "system", requestedByActorId: "orchestrator" })
      .returning();
    return row!;
  }

  async function decide(scope: { novelId: string }, type: "series_bible" | "arc_plan" | "episode", subjectId: string, decision: "approved" | "rejected", extra: { note?: string; reworkFrom?: "outline" | "draft" | "polish" } = {}) {
    const subjectType = type === "series_bible" ? "series_bible" : type === "arc_plan" ? "arc" : "episode";
    const approval = await approvalFor(scope, type, subjectType, subjectId);
    await t.platform.uow.run((tx) =>
      hooks().approvalHandlers[type]({ tx, scope, approval, decision, decisionNote: extra.note ?? null, reworkFrom: extra.reworkFrom ?? null, actor: t.owner, answerId: null }),
    );
    return approval;
  }

  async function approveStructure(scope: { novelId: string }) {
    await drain(scope, async () => (await t.modules.novel.service.getStructure(scope))?.status === "awaiting_approval");
    const s = (await t.modules.novel.service.getStructure(scope))!;
    const r = await t.http("POST", `/api/novels/${scope.novelId}/structure/decision`, { decision: "approved", expectedRevision: s.revision });
    if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  }

  async function planningNovel(title = "회귀자의 흉터") {
    const nv = t.modules.novel.service;
    const novel = await nv.createNovel({ title }, t.owner);
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
    await completeTestCast(t, novel.id, "한결");
    await nv.saveGoal(scope, { totalEpisodesMin: 12, totalEpisodesMax: 12, cadenceEpisodesPerWeek: 5, reserveTargetEpisodes: 2, endingDirection: "흉터의 비밀을 밝히고 회귀를 끝낸다", notes: null }, t.owner);
    return { novel, scope };
  }

  /** novel whose first plot is approved and episode 1 waits for approval */
  async function novelWithEpisodeAwaiting(opts: { title?: string; sequential?: boolean } = {}) {
    const { scope, novel } = await planningNovel(opts.title);
    if (opts.sequential === false) await t.modules.novel.service.updateSettings(scope, { sequentialEpisodes: false }, t.owner);
    await drain(scope, async () => (await t.modules.novel.service.listBibles(scope)).some((b) => b.status === "awaiting_approval"));
    await decide(scope, "series_bible", (await t.modules.novel.service.listBibles(scope))[0]!.id, "approved");
    await approveStructure(scope);
    await drain(scope, () => arcPlanAwaiting(scope));
    await decide(scope, "arc_plan", (await t.modules.novel.service.listArcs(scope))[0]!.id, "approved");
    await drain(scope, async () => (await ms().getEpisodeByNo(scope, 1)).status === "awaiting_approval", 100);
    return { scope, novel };
  }

  return { ms, drain, decide, approvalFor, novelWithEpisodeAwaiting };
}
