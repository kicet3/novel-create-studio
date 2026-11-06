import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "@ncs/db/orm";
import { budgetReservations, costEvents } from "@ncs/db/schema";
import { FakeClock } from "@ncs/test-kit";
import type { ApprovalHandler } from "../../src/modules/hitl/index.js";
import type { BudgetApprovalPort } from "../../src/modules/budget/index.js";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { makeEngine, novelWithGoal, simulateCall } from "../orchestration/support.js";

let t: TestCore;
let clock: FakeClock;
beforeEach(async () => {
  clock = new FakeClock("2026-11-05T00:00:00.000Z");
  t = await createTestCore({ clock });
});
afterEach(() => t.close());

/** a run row is required by FKs (reservations / provider calls reference runs) */
async function runFor(scope: { novelId: string }) {
  const e = makeEngine(t);
  let runId = "";
  const { taskId } = await t.platform.uow.run((tx) =>
    t.modules.orchestration.service.createTask(tx, scope, { kind: "dedupe_entities", targetType: "novel", targetId: `${Math.random()}`, input: {}, createdBy: t.owner }),
  );
  e.registerTaskKind({
    kind: "dedupe_entities",
    role: "world_keeper",
    promptTemplateVersion: "code.dedupe_entities@0.0.0",
    inputSchema: (await import("zod")).z.unknown(),
    async execute(ctx) {
      runId = ctx.run.runId;
      return {};
    },
    async commit() {
      return { kind: "done", outputRefs: [] };
    },
  });
  await e.runOnce();
  void taskId;
  return { novelId: scope.novelId, runId };
}

function fakeApprovals() {
  const requested: Array<{ approvalId: string; subjectId: string }> = [];
  const handlers = new Map<string, ApprovalHandler>();
  let n = 0;
  const port: BudgetApprovalPort = {
    async requestApproval(tx, scope, req) {
      // minimal rows so the budget_policies.resume_approval_id FK holds (real hitl does much more)
      const approvalId = t.platform.ids.next("apr");
      const questionId = t.platform.ids.next("qst");
      n++;
      await tx.db.execute(
        sql`INSERT INTO questions (id, novel_id, display_no, grade, question_type, topic, title, body, rationale, blocking_basis, grade_reason)
            VALUES (${questionId}, ${scope.novelId}, ${9000 + n}, 'informational', 'approve_reject', 'budget', ${req.question.title}, ${req.question.body}, 'test', 'none', 'test')`,
      );
      await tx.db.execute(
        sql`INSERT INTO approvals (id, novel_id, approval_type, subject_type, subject_id, question_id, requested_by_actor_type, requested_by_actor_id)
            VALUES (${approvalId}, ${scope.novelId}, ${req.approvalType}, ${req.target.type}, ${req.target.id}, ${questionId}, 'system', 'budget_guard')`,
      );
      requested.push({ approvalId, subjectId: req.target.id });
      return { approvalId, questionId };
    },
    registerApprovalHandler(type, h) {
      handlers.set(type, h);
    },
  };
  return { port, requested, handlers };
}

describe("reservations and ledger (INV-COST-01..04)", () => {
  it("settles one ledger row per call, idempotently, and records overruns (INV-COST-01/03)", async () => {
    const { scope } = await novelWithGoal(t);
    const run = await runFor(scope);
    const r = await simulateCall(t, run, { maxCostMicros: 1000, actualMicros: 1200 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.overrunMicros).toBe(200);
    // replay of the same settlement (crash after commit / retry) → same row
    const again = await t.platform.uow.run((tx) =>
      t.modules.budget.service.settle(tx, scope, {
        providerCallId: r.pclId,
        reservationId: r.reservationId,
        category: "text",
        basis: "measured",
        amountMicros: 1200,
        usage: { inputTokens: 1, outputTokens: 1 },
        ...r.meta,
        isRerun: false,
      }),
    );
    expect(again.costEventId).toBe(r.costEventId);
    const rows = await t.testDb.db.select().from(costEvents).where(eq(costEvents.novelId, scope.novelId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amountMicros: 1200, reservedMicros: 1000, overrunMicros: 200, runId: run.runId, agentRole: "world_keeper", costBasis: "measured" });
    expect(rows[0]!.taskId).not.toBeNull(); // run context resolved by orchestration (04 §8.6)
    const [rsv] = await t.testDb.db.select().from(budgetReservations).where(eq(budgetReservations.id, r.reservationId));
    expect(rsv).toMatchObject({ status: "settled", settledCostEventId: r.costEventId });
    const actions = (await t.modules.audit.service.list(scope, {})).items.map((x) => x.action);
    expect(actions).toContain("cost.overrun_recorded");
  });

  it("closes interrupted calls as unknown (= reserved amount) and corrects late responses with an append-only row (INV-COST-04)", async () => {
    const { scope } = await novelWithGoal(t);
    const run = await runFor(scope);
    const r = await simulateCall(t, run, { maxCostMicros: 3000, stopAfter: "sent" });
    if (!r.ok) throw new Error("reserve failed");
    const budget = t.modules.budget.service;
    const { costEventId } = await t.platform.uow.run((tx) => budget.closeUnknown(tx, scope, r.pclId, r.reservationId, r.meta));
    const [orig] = await t.testDb.db.select().from(costEvents).where(eq(costEvents.id, costEventId));
    expect(orig).toMatchObject({ costBasis: "unknown", amountMicros: 3000 });
    const late = await t.platform.uow.run((tx) => budget.recordLateResponse(tx, scope, { providerCallId: r.pclId, amountMicros: 1800, usage: { inputTokens: 10, outputTokens: 5 } }));
    expect(late.created).toBe(true);
    const lateAgain = await t.platform.uow.run((tx) => budget.recordLateResponse(tx, scope, { providerCallId: r.pclId, amountMicros: 1800, usage: { inputTokens: 10, outputTokens: 5 } }));
    expect(lateAgain).toEqual({ costEventId: late.costEventId, created: false });
    const rows = await t.testDb.db.select().from(costEvents).where(eq(costEvents.novelId, scope.novelId));
    expect(rows).toHaveLength(2);
    const correction = rows.find((x) => x.id === late.costEventId)!;
    expect(correction).toMatchObject({ providerCallId: null, adjustsCostEventId: costEventId, amountMicros: -1200, idempotencyKey: `pcl:${r.pclId}:late` });
    const [unchanged] = await t.testDb.db.select().from(costEvents).where(eq(costEvents.id, costEventId));
    expect(unchanged).toEqual(orig); // original row never updated
    const [view] = await budget.status(scope);
    expect(view!.spentMicros).toBe(1800);
  });

  it("distinguishes reservation_wait (b) from hard_limit (a); (b) does not stop the novel", async () => {
    const { scope } = await novelWithGoal(t);
    const budget = t.modules.budget.service;
    await budget.updatePolicy(scope, "all", { hardLimitMicros: 10_000 }, t.owner);
    const run = await runFor(scope);
    const first = await simulateCall(t, run, { maxCostMicros: 6_000, stopAfter: "sent", seq: 1 });
    expect(first.ok).toBe(true);
    const second = await simulateCall(t, run, { maxCostMicros: 6_000, seq: 2 });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.refusal.reason).toBe("reservation_wait");
    expect(budget.refusalForRun(run.runId)?.reason).toBe("reservation_wait");
    expect((await budget.listPolicies(scope))[0]!.status).toBe("ok");
    expect((await t.modules.novel.service.getNovel(scope)).pausedAt).toBeNull();
    const third = await simulateCall(t, run, { maxCostMicros: 20_000, seq: 3 });
    expect(third.ok).toBe(false);
    if (third.ok) return;
    expect(third.refusal.reason).toBe("hard_limit");
    expect((await budget.listPolicies(scope))[0]!.status).toBe("hard_stopped");
    expect((await t.modules.novel.service.getNovel(scope)).pauseReason).toBe("budget_hard_limit");
  });

  it("concurrent reservations never let spent + reserved exceed the hard limit (G-6)", async () => {
    const { scope } = await novelWithGoal(t);
    const budget = t.modules.budget.service;
    const limit = 50_000;
    await budget.updatePolicy(scope, "all", { hardLimitMicros: limit, softWarnRatio: 1 }, t.owner);
    const run = await runFor(scope);
    const amounts = Array.from({ length: 30 }, (_, i) => 1_000 + ((i * 7919) % 4_000));
    const results = await Promise.all(amounts.map((a, i) => simulateCall(t, run, { maxCostMicros: a, actualMicros: Math.floor(a * 0.9), seq: 10 + i })));
    const ok = results.filter((r) => r.ok).length;
    expect(ok).toBeGreaterThan(5);
    expect(ok).toBeLessThan(amounts.length);
    const rows = await t.testDb.db.select().from(costEvents).where(eq(costEvents.novelId, scope.novelId));
    const spent = rows.reduce((s, r) => s + r.amountMicros, 0);
    expect(spent).toBeLessThanOrEqual(limit);
    expect(rows.every((r) => r.overrunMicros === 0)).toBe(true);
    expect(await budget.activeReservationCount(scope)).toBe(0);
  });

  it("hard limit → budget_resume approval; approve after raising the limit resumes policy, novel and blocked tasks", async () => {
    const approvals = fakeApprovals();
    t.modules.budget.service.connectApprovals(approvals.port);
    expect(approvals.handlers.has("budget_resume")).toBe(true);
    const { scope } = await novelWithGoal(t);
    const budget = t.modules.budget.service;
    await budget.updatePolicy(scope, "all", { hardLimitMicros: 1_000 }, t.owner);
    const run = await runFor(scope);
    const ok = await simulateCall(t, run, { maxCostMicros: 1_000, actualMicros: 1_000, seq: 1 }); // spent == limit → stop (step 7)
    expect(ok.ok).toBe(true);
    const [policy] = await budget.listPolicies(scope);
    expect(policy!.status).toBe("hard_stopped");
    expect(approvals.requested).toEqual([{ approvalId: policy!.resumeApprovalId, subjectId: policy!.id }]);
    expect((await t.modules.novel.service.getNovel(scope)).pauseReason).toBe("budget_hard_limit");
    expect((await budget.admission(scope)).ok).toBe(false);

    // a task blocked on the policy (T7 budget) is released by the resume
    const orch = t.modules.orchestration.service;
    const { taskId } = await t.platform.uow.run((tx) => orch.createTask(tx, scope, { kind: "dedupe_entities", targetType: "novel", targetId: "x", input: {}, createdBy: t.owner }));
    await t.platform.uow.run((tx) => orch.blockTask(tx, scope, taskId, "budget", { refType: "budget_policy", refId: policy!.id }, t.owner));

    // resume over the limit is refused (HTTP 422)
    const refused = await t.http("POST", `/api/novels/${scope.novelId}/budget/policies/all/resume`, {});
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe("budget_limit_still_reached");

    const patched = await t.http("PATCH", `/api/novels/${scope.novelId}/budget/policies/all`, { hardLimitMicros: 5_000 });
    expect(patched.status).toBe(200);
    expect(patched.body.status).toBe("hard_stopped"); // raising never auto-resumes (04 U-5)

    const h = approvals.handlers.get("budget_resume")!;
    const approval = { id: policy!.resumeApprovalId!, subjectId: policy!.id } as never;
    await t.platform.uow.run((tx) => h({ tx, scope, approval, decision: "approved", decisionNote: null, reworkFrom: null, actor: t.owner, answerId: null }));
    const [after] = await budget.listPolicies(scope);
    expect(after).toMatchObject({ status: "ok", resumeApprovalId: policy!.resumeApprovalId });
    expect((await t.modules.novel.service.getNovel(scope)).pausedAt).toBeNull();
    expect((await orch.getTask(scope, taskId)).status).toBe("ready");
    const actions = (await t.modules.audit.service.list(scope, {})).items.map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(["budget.hard_stop_reached", "budget.resumed", "task.unblocked"]));
  });

  it("warns at the soft ratio, rolls calendar windows, and serves the HTTP API", async () => {
    const { scope } = await novelWithGoal(t);
    const budget = t.modules.budget.service;
    await budget.updatePolicy(scope, "all", { hardLimitMicros: 10_000, softWarnRatio: 0.5 }, t.owner);
    const run = await runFor(scope);
    await simulateCall(t, run, { maxCostMicros: 6_000, actualMicros: 6_000 });
    let r = await t.http("GET", `/api/novels/${scope.novelId}/budget`);
    expect(r.status).toBe(200);
    expect(r.body.items[0]).toMatchObject({ category: "all", status: "warning", spentMicros: 6_000, reservedMicros: 0, remainingMicros: 4_000 });
    expect(r.body.hardStopped).toBe(false);
    // text policy created on first PATCH (category policies are optional)
    const text = await t.http("PATCH", `/api/novels/${scope.novelId}/budget/policies/text`, { hardLimitMicros: 7_000 });
    expect(text.status).toBe(200);
    expect(text.body).toMatchObject({ category: "text", status: "warning" });
    const bad = await t.http("PATCH", `/api/novels/${scope.novelId}/budget/policies/text`, { hardLimitMicros: -1 });
    expect(bad.status).toBe(400);
    const events = await t.http("GET", `/api/novels/${scope.novelId}/budget/cost-events?runId=${run.runId}`);
    expect(events.body.items).toHaveLength(1);
    // next month: ledger of the old window no longer counts, warning clears
    clock.set("2026-12-02T00:00:00.000Z");
    r = await t.http("GET", `/api/novels/${scope.novelId}/budget`);
    expect(r.body.items.find((i: { category: string }) => i.category === "all")).toMatchObject({ status: "ok", spentMicros: 0, windowStartedAt: "2026-12-01T00:00:00.000Z" });
  });

  it("unpriced calls are refused (8.4) and stale unattached reservations are swept", async () => {
    const { scope } = await novelWithGoal(t);
    const budget = t.modules.budget.service;
    const run = await runFor(scope);
    const unpriced = await t.platform.uow.run((tx) => budget.reserve(tx, scope, { runId: run.runId, category: "text", maxCostMicros: null }));
    expect(unpriced).toMatchObject({ ok: false, reason: "unpriced" });
    const res = await t.platform.uow.run((tx) => budget.reserve(tx, scope, { runId: run.runId, category: "text", maxCostMicros: 500 }));
    expect(res.ok).toBe(true);
    expect(await budget.sweepStaleReservations()).toBe(0);
    clock.advance(31 * 60_000);
    expect(await budget.sweepStaleReservations()).toBe(1);
    expect(await budget.activeReservationCount(scope)).toBe(0);
  });
});
