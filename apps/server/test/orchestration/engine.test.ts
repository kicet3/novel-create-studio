import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "@ncs/db/orm";
import { budgetReservations, costEvents, runs, tasks, wakeRequests } from "@ncs/db/schema";
import { FakeClock } from "@ncs/test-kit";
import { actors } from "../../src/platform/index.js";
import { RunStop, TaskFailure } from "../../src/modules/orchestration/index.js";
import { taskRepo } from "../../src/modules/orchestration/adapters/db/task-repository.js";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { conceptSessionId, deferred, handler, makeEngine, novelWithGoal, providerProfileId, simulateCall } from "./support.js";

let t: TestCore;
let clock: FakeClock;
beforeEach(async () => {
  clock = new FakeClock("2026-11-05T00:00:00.000Z");
  t = await createTestCore({ clock });
});
afterEach(() => t.close());

const sys = actors.system("scheduler");

async function makeTask(kind: "revise_episode" | "polish_episode" | "dedupe_entities" | "check_continuity", scope: { novelId: string }, extra: Record<string, unknown> = {}) {
  const engine = t.modules.orchestration.service;
  return t.platform.uow.run((tx) =>
    engine.createTask(tx, scope, { kind, targetType: kind === "dedupe_entities" ? "novel" : "episode", targetId: (extra.targetId as string) ?? `epi_${Math.random()}`, input: {}, createdBy: sys, ...extra }),
  );
}

describe("task lifecycle with the real engine", () => {
  it("runs gate → execute → commit; retryable failure backs off (T5) then succeeds (T4)", async () => {
    const e = makeEngine(t);
    let n = 0;
    const calls: string[] = [];
    e.registerTaskKind(
      handler("dedupe_entities", "world_keeper", {
        async execute(ctx) {
          calls.push(`execute:${ctx.run.attempt}`);
          await ctx.run.checkpoint();
          if (++n === 1) throw new TaskFailure("provider_unavailable", "temporary");
          return {};
        },
        async commit(_tx, ctx) {
          calls.push("commit");
          return { kind: "done", outputRefs: [{ refType: "novel", refId: ctx.scope.novelId }] };
        },
      }),
    );
    expect(() => e.registerTaskKind(handler("dedupe_entities", "world_keeper"))).toThrow(/already registered/);
    const { scope, novel } = await novelWithGoal(t);
    const { taskId, created } = await makeTask("dedupe_entities", scope, { targetId: novel.id });
    expect(created).toBe(true);
    expect((await makeTask("dedupe_entities", scope, { targetId: novel.id })).created).toBe(false); // TC-2

    expect(await e.runOnce()).toBe(1);
    let task = await e.getTask(scope, taskId);
    expect(task.status).toBe("ready");
    expect(task.attemptCount).toBe(1);
    expect(task.notBeforeAt!.getTime()).toBe(clock.now() + 5_000);
    expect(task.latestRun!.status).toBe("failed");
    expect(await e.runOnce()).toBe(0); // backoff not elapsed
    clock.advance(5_000);
    expect(await e.runOnce()).toBe(1);
    task = await e.getTask(scope, taskId);
    expect(task.status).toBe("done");
    expect(task.leaseRunId).toBeNull();
    expect(task.latestRun!.status).toBe("succeeded");
    expect(calls).toEqual(["execute:1", "execute:2", "commit"]);
    const wakes = await t.testDb.db.select().from(wakeRequests).where(eq(wakeRequests.taskId, taskId));
    expect(wakes.map((w) => `${w.reason}:${w.status}`).sort()).toEqual(["retry:claimed", "task_created:claimed"]);
    const actions = (await t.modules.audit.service.list(scope, { targetIds: [taskId] })).items.map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(["task.created", "task.lease_acquired", "task.status_changed"]));
  });

  it("two workers checking out concurrently → exactly one lease (INV-TSK-03)", async () => {
    const gate = deferred();
    const executed: string[] = [];
    const mk = (name: string) => {
      const e = makeEngine(t);
      e.registerTaskKind(
        handler("dedupe_entities", "world_keeper", {
          async execute() {
            executed.push(name);
            await gate.promise;
            return {};
          },
        }),
      );
      return e;
    };
    const a = mk("a");
    const b = mk("b");
    const { scope, novel } = await novelWithGoal(t);
    const { taskId } = await makeTask("dedupe_entities", scope, { targetId: novel.id });
    const [na, nb] = await Promise.all([a.tick(new AbortController().signal, { ignoreCoalesceWindow: true }), b.tick(new AbortController().signal, { ignoreCoalesceWindow: true })]);
    expect(na + nb).toBe(1);
    const leased = await t.testDb.db.select().from(runs).where(eq(runs.taskId, taskId));
    expect(leased.filter((r) => r.status === "running")).toHaveLength(1);
    // the CAS itself: a second acquire on a running task matches 0 rows
    const again = await t.platform.uow.run((tx) => taskRepo.acquireLease(tx.db, scope, taskId, leased[0]!.id, clock.date(), new Date(clock.now() + 1000)));
    expect(again).toBeNull();
    gate.resolve();
    await Promise.all([a.runOnce(), b.runOnce()]);
    await new Promise((r) => setTimeout(r, 20));
    expect(executed).toHaveLength(1);
    expect((await a.getTask(scope, taskId)).status).toBe("done");
  });

  it("respects the coalesce window (WC-3) in background ticks and coalesces wakes (WC-1/2)", async () => {
    const e = makeEngine(t);
    e.registerTaskKind(handler("dedupe_entities", "world_keeper"));
    const { scope, novel } = await novelWithGoal(t);
    const { taskId } = await makeTask("dedupe_entities", scope, { targetId: novel.id });
    const r1 = await t.platform.uow.run((tx) => e.requestWake(tx, scope, { taskId, reason: "dependency_done", idempotencyKey: "dep:x:1" }));
    expect(r1.status).toBe("coalesced");
    const r2 = await t.platform.uow.run((tx) => e.requestWake(tx, scope, { taskId, reason: "dependency_done", idempotencyKey: "dep:x:1" }));
    expect(r2.status).toBe("duplicate");
    const sig = new AbortController().signal;
    expect(await e.tick(sig)).toBe(0); // created < 10 s ago
    clock.advance(10_000);
    expect(await e.tick(sig)).toBe(1);
    await e.runOnce();
    expect((await e.getTask(scope, taskId)).status).toBe("done");
  });

  it("enforces per-novel and global concurrency caps", async () => {
    const gate = deferred();
    const e = makeEngine(t, { maxConcurrentPerNovel: 1, maxConcurrentGlobal: 2 });
    e.registerTaskKind(handler("revise_episode", "writer", { execute: () => gate.promise.then(() => ({})) }));
    const n1 = await novelWithGoal(t);
    const n2 = await novelWithGoal(t);
    const n3 = await novelWithGoal(t);
    for (const n of [n1, n2, n3]) for (let i = 0; i < 2; i++) await makeTask("revise_episode", n.scope);
    const sig = new AbortController().signal;
    expect(await e.tick(sig, { ignoreCoalesceWindow: true })).toBe(2);
    expect(await e.tick(sig, { ignoreCoalesceWindow: true })).toBe(0);
    const running = await t.testDb.db.select().from(tasks).where(eq(tasks.status, "running"));
    expect(new Set(running.map((r) => r.novelId)).size).toBe(2);
    gate.resolve();
    for (let i = 0; i < 4; i++) await e.runOnce();
    expect((await t.testDb.db.select().from(tasks).where(eq(tasks.status, "done"))).length).toBe(6);
  });

  it("pre-lease gate blocks without a run (T8) and dependencies promote on commit (T2)", async () => {
    const e = makeEngine(t);
    e.registerTaskKind(handler("revise_episode", "writer", { gate: async () => ({ ok: false, blockReason: "approval", blockedRef: { refType: "approval", refId: "apr_X" } }) }));
    e.registerTaskKind(handler("check_continuity", "continuity_editor"));
    const { scope } = await novelWithGoal(t);
    const gated = await makeTask("revise_episode", scope);
    const first = await makeTask("check_continuity", scope);
    const second = await makeTask("check_continuity", scope, { dependsOn: [first.taskId] });
    expect((await e.getTask(scope, second.taskId)).status).toBe("pending");
    await e.runOnce();
    const g = await e.getTask(scope, gated.taskId);
    expect(g).toMatchObject({ status: "blocked", blockReason: "approval", blockedRefId: "apr_X", latestRun: null });
    expect((await e.getTask(scope, first.taskId)).status).toBe("done");
    expect((await e.getTask(scope, second.taskId)).status).toBe("ready");
    await e.runOnce();
    expect((await e.getTask(scope, second.taskId)).status).toBe("done");
    // T9 via unblockByRef with answer id appended
    const released = await t.platform.uow.run((tx) => e.unblockByRef(tx, scope, { refType: "approval", refId: "apr_X" }, { reason: "approval_decided", keyPrefix: "approval:apr_X" }, "ans_1"));
    expect(released).toEqual([gated.taskId]);
    expect((await e.getTask(scope, gated.taskId)).input).toMatchObject({ answer_ids: ["ans_1"] });
  });

  it("cancelled dependency cascades T11 to pending dependents", async () => {
    const e = makeEngine(t);
    const { scope } = await novelWithGoal(t);
    const a = await makeTask("check_continuity", scope);
    const b = await makeTask("check_continuity", scope, { dependsOn: [a.taskId] });
    await t.platform.uow.run((tx) => e.cancelTask(tx, scope, a.taskId, t.owner));
    await e.runOnce();
    expect((await e.getTask(scope, b.taskId)).status).toBe("cancelled");
  });
});

describe("safe points: pause / cancel / reassign / budget", () => {
  it("pauses a running task at the next checkpoint (R6 paused, task ready + paused_at) and resumes", async () => {
    const e = makeEngine(t);
    const reached = deferred();
    const go = deferred();
    let runs = 0;
    e.registerTaskKind(
      handler("revise_episode", "writer", {
        async execute(ctx) {
          runs++;
          if (runs === 1) {
            reached.resolve();
            await go.promise;
          }
          await ctx.run.checkpoint();
          return {};
        },
      }),
    );
    const { scope } = await novelWithGoal(t);
    const { taskId } = await makeTask("revise_episode", scope);
    const p = e.runOnce();
    await reached.promise;
    await t.platform.uow.run((tx) => e.pause(tx, scope, { scope: "task", id: taskId }, "user", t.owner));
    go.resolve();
    await p;
    let task = await e.getTask(scope, taskId);
    expect(task.status).toBe("ready");
    expect(task.pausedAt).not.toBeNull();
    expect(task.attemptCount).toBe(0);
    expect(task.latestRun).toMatchObject({ status: "cancelled", stopReason: "paused" });
    expect(await e.runOnce()).toBe(0); // paused → no lease (INV-TSK-05)
    await t.platform.uow.run((tx) => e.resume(tx, scope, { scope: "task", id: taskId }, t.owner));
    expect(await e.runOnce()).toBe(1);
    task = await e.getTask(scope, taskId);
    expect(task.status).toBe("done");
    const all = await e.listRuns(scope, taskId);
    expect(all[0]!.rerunOfRunId).toBe(all[1]!.id); // resumed run continues the chain (RU-2)
  });

  it("novel pause stops leasing; budget_hard_limit pause cannot be resumed via orchestration", async () => {
    const e = makeEngine(t);
    e.registerTaskKind(handler("revise_episode", "writer"));
    const { scope } = await novelWithGoal(t);
    await makeTask("revise_episode", scope);
    await t.platform.uow.run((tx) => e.pause(tx, scope, { scope: "novel", id: scope.novelId }, "budget_hard_limit", actors.system("budget_guard")));
    expect(await e.runOnce()).toBe(0);
    await expect(t.platform.uow.run((tx) => e.resume(tx, scope, { scope: "novel", id: scope.novelId }, t.owner))).rejects.toThrow(/예산/);
  });

  it("cancels a running task at the safe point (T11s) and reassigns a running task (task.reassigned)", async () => {
    const e = makeEngine(t);
    const reached = deferred();
    const go = deferred();
    let committed = 0;
    e.registerTaskKind(
      handler("revise_episode", "writer", {
        async execute(ctx) {
          reached.resolve();
          await go.promise;
          await ctx.run.checkpoint();
          return {};
        },
        async commit() {
          committed++;
          return { kind: "done", outputRefs: [] };
        },
      }),
    );
    const { scope } = await novelWithGoal(t);
    const a = await makeTask("revise_episode", scope);
    const p = e.runOnce();
    await reached.promise;
    await t.platform.uow.run((tx) => e.cancelTask(tx, scope, a.taskId, t.owner));
    go.resolve();
    await p;
    expect(await e.getTask(scope, a.taskId)).toMatchObject({ status: "cancelled", latestRun: { stopReason: "cancelled_by_user" } });
    expect(committed).toBe(0);

    // reassign: not allowed role / allowed now / terminal
    const b = await makeTask("revise_episode", scope);
    expect(await t.platform.uow.run((tx) => e.reassignTask(tx, scope, b.taskId, "planner", t.owner))).toEqual({ rejected: "role_not_allowed" });
    expect(await t.platform.uow.run((tx) => e.reassignTask(tx, scope, b.taskId, "line_editor", t.owner))).toEqual({ applied: "now" });
    expect((await e.getTask(scope, b.taskId)).agentRole).toBe("line_editor");
    expect(await t.platform.uow.run((tx) => e.reassignTask(tx, scope, a.taskId, "writer", t.owner))).toEqual({ rejected: "terminal" });
    const r = await t.http("POST", `/api/novels/${scope.novelId}/tasks/${b.taskId}/reassign`, { toRole: "writer" });
    expect(r.status).toBe(200);
    expect(r.body.result).toEqual({ applied: "now" });
    expect(r.body.task.agentRole).toBe("writer");
  });

  it("budget hard stop blocks before lease (T8 budget) and resume unblocks (T9)", async () => {
    const e = makeEngine(t);
    e.registerTaskKind(handler("revise_episode", "writer"));
    const { scope } = await novelWithGoal(t);
    const { taskId } = await makeTask("revise_episode", scope);
    const [policy] = await t.modules.budget.service.listPolicies(scope);
    await t.modules.budget.service.updatePolicy(scope, "all", { hardLimitMicros: 0 }, t.owner); // spent 0 ≥ 0 → hard stop
    expect((await t.modules.budget.service.listPolicies(scope))[0]!.status).toBe("hard_stopped");
    await e.runOnce();
    expect(await e.getTask(scope, taskId)).toMatchObject({ status: "blocked", blockReason: "budget", blockedRefId: policy!.id, latestRun: null });
    await t.modules.budget.service.updatePolicy(scope, "all", { hardLimitMicros: 1_000_000 }, t.owner);
    await t.modules.budget.service.resume(scope, "all", t.owner);
    expect((await e.getTask(scope, taskId)).status).toBe("ready");
    expect((await t.modules.novel.service.getNovel(scope)).pausedAt).toBeNull();
    expect(await e.runOnce()).toBe(1);
  });

  it("a budget refusal during execute blocks the task (T7) without consuming an attempt", async () => {
    const e = makeEngine(t);
    e.registerTaskKind(
      handler("revise_episode", "writer", {
        async execute(ctx) {
          const r = await simulateCall(t, ctx.run, { maxCostMicros: 5_000_000 });
          if (!r.ok) throw Object.assign(new Error("budget"), { errorFamily: "budget_blocked", retryable: false });
          return {};
        },
      }),
    );
    const { scope } = await novelWithGoal(t);
    await t.modules.budget.service.updatePolicy(scope, "all", { hardLimitMicros: 1_000_000 }, t.owner);
    const { taskId } = await makeTask("revise_episode", scope);
    await e.runOnce();
    const task = await e.getTask(scope, taskId);
    expect(task).toMatchObject({ status: "blocked", blockReason: "budget", attemptCount: 0, latestRun: { status: "cancelled", stopReason: "budget_blocked" } });
    expect((await t.modules.novel.service.getNovel(scope)).pauseReason).toBe("budget_hard_limit");
  });
});

describe("orphan reclaim (FR-AGT-02, 04 §11)", () => {
  it("kill mid-run → startup reclaim: re-queued, recorded response reused, interrupted call = unknown cost, zero duplicate ledger rows", async () => {
    const { scope } = await novelWithGoal(t);
    // ── process 1: claims, makes one completed call and one in-flight call, then "dies"
    const p1 = makeEngine(t);
    const hang = deferred();
    const inFlight = deferred<{ pclId: string }>();
    let p1Committed = false;
    p1.registerTaskKind(
      handler("revise_episode", "writer", {
        async execute(ctx) {
          await simulateCall(t, ctx.run, { maxCostMicros: 1000, actualMicros: 700, seq: 1 });
          const c2 = await simulateCall(t, ctx.run, { maxCostMicros: 2000, seq: 2, stopAfter: "sent" });
          inFlight.resolve({ pclId: c2.pclId });
          await hang.promise; // never answered before the crash
          await ctx.run.checkpoint();
          return {};
        },
        async commit() {
          p1Committed = true;
          return { kind: "done", outputRefs: [] };
        },
      }),
    );
    const { taskId } = await makeTask("revise_episode", scope);
    const p1Done = p1.runOnce();
    const { pclId: lost } = await inFlight.promise;
    const [deadRun] = await p1.listRuns(scope, taskId);
    expect(deadRun!.status).toBe("running");

    // ── process 2 boots: instance lock proves process 1 is gone → reclaim everything (startup)
    const p2 = makeEngine(t);
    const prv = await providerProfileId(t);
    p2.registerRunRecovery(async (tx, s, run) => {
      // what llm does for the provider_calls it owns (P5): sent → unknown + unknown ledger row
      const res = await tx.db.execute(sql`SELECT id, reservation_id FROM provider_calls WHERE run_id = ${run.runId} AND status = 'sent'`);
      for (const r of (res as unknown as { rows: Array<{ id: string; reservation_id: string }> }).rows) {
        await tx.db.execute(sql`UPDATE provider_calls SET status = 'unknown' WHERE id = ${r.id} AND status = 'sent'`);
        await t.modules.budget.service.closeUnknown(tx, s, r.id, r.reservation_id, { provider: "anthropic", modelId: "claude-test-model", providerProfileId: prv, providerProfileVersion: 1 });
      }
    });
    expect(await p2.reclaimOrphans({ startup: true })).toBe(1);
    let task = await p2.getTask(scope, taskId);
    expect(task).toMatchObject({ status: "ready", leaseRunId: null, attemptCount: 0 });
    const interrupted = (await p2.listRuns(scope, taskId))[0]!;
    expect(interrupted).toMatchObject({ status: "interrupted", stopReason: "lease_lost" });
    const unknown = await t.testDb.db.select().from(costEvents).where(eq(costEvents.providerCallId, lost));
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toMatchObject({ costBasis: "unknown", amountMicros: 2000, reservedMicros: 2000 });
    const rsv = await t.testDb.db.select().from(budgetReservations).where(and(eq(budgetReservations.runId, deadRun!.id)));
    expect(rsv.map((r) => r.status).sort()).toEqual(["settled", "unknown_closed"]);
    const audits = (await t.modules.audit.service.list(scope, {})).items.map((x) => x.action);
    expect(audits).toEqual(expect.arrayContaining(["run.interrupted", "task.lease_reclaimed", "cost.unknown_recorded"]));
    expect((await t.testDb.db.select().from(wakeRequests).where(eq(wakeRequests.taskId, taskId))).some((w) => w.reason === "reclaim" && w.status === "pending")).toBe(true);

    // ── process 2 reruns: reuses the stored response of call #1 (no new call), re-issues call #2 as rerun
    let reusedFrom: readonly string[] = [];
    p2.registerTaskKind(
      handler("revise_episode", "writer", {
        async execute(ctx) {
          reusedFrom = ctx.run.runChain ?? [];
          const stored = await t.testDb.query<{ id: string }>(`SELECT id FROM provider_calls WHERE run_id = $1 AND status = 'responded'`, [reusedFrom[0]]);
          expect(stored).toHaveLength(1); // RU-2: reuse, do not call again
          await simulateCall(t, ctx.run, { maxCostMicros: 2000, actualMicros: 1500, seq: 1, isRerun: true });
          return {};
        },
      }),
    );
    expect(await p2.runOnce()).toBe(1);
    task = await p2.getTask(scope, taskId);
    expect(task.status).toBe("done");
    const [rerun] = await p2.listRuns(scope, taskId);
    expect(rerun!.rerunOfRunId).toBe(deadRun!.id);
    expect(reusedFrom).toEqual([deadRun!.id]);
    expect(rerun!.costMicros).toBe(1500);

    // ── the zombie of process 1 wakes up late: fenced out, writes nothing
    hang.resolve();
    await p1Done;
    expect(p1Committed).toBe(false);
    expect((await p2.getTask(scope, taskId)).status).toBe("done");
    // ledger: one row per provider call (3 calls), no duplicates; idempotent re-close
    const ledger = await t.testDb.db.select().from(costEvents).where(eq(costEvents.novelId, scope.novelId));
    expect(ledger).toHaveLength(3);
    expect(new Set(ledger.map((l) => l.providerCallId)).size).toBe(3);
    expect(ledger.filter((l) => l.isRerun)).toHaveLength(1);
    await t.platform.uow.run((tx) => t.modules.budget.service.closeUnknown(tx, scope, lost, rsv.find((r) => r.status === "unknown_closed")!.id));
    expect(await t.testDb.db.select().from(costEvents).where(eq(costEvents.novelId, scope.novelId))).toHaveLength(3);
  });

  it("periodic reclaim skips active runs (LR-1/LR-2) but reclaims expired leases of dead runs", async () => {
    const { scope } = await novelWithGoal(t);
    const e = makeEngine(t, { leaseTtlMs: 1_000, renewIntervalMs: 60_000 });
    const hang = deferred();
    const started = deferred();
    e.registerTaskKind(
      handler("revise_episode", "writer", {
        async execute() {
          started.resolve();
          await hang.promise;
          return {};
        },
      }),
    );
    const { taskId } = await makeTask("revise_episode", scope);
    const p = e.runOnce();
    await started.promise;
    clock.advance(5_000); // lease expired, but the run is alive in this process
    expect(await e.reclaimOrphans()).toBe(0);
    expect((await e.getTask(scope, taskId)).status).toBe("running");
    // another engine (no registry entry) sees an expired lease of a run it does not own
    const other = makeEngine(t, { leaseTtlMs: 1_000 });
    clock.advance(5_000);
    expect(await other.reclaimOrphans()).toBe(1);
    expect((await e.getTask(scope, taskId)).status).toBe("ready");
    hang.resolve();
    await p;
    const [r] = await e.listRuns(scope, taskId);
    expect(r!.status).toBe("interrupted");
  });

  it("RunStop thrown by a handler and invalid input are classified", async () => {
    const e = makeEngine(t);
    e.registerTaskKind(
      handler("revise_episode", "writer", {
        async execute() {
          throw new RunStop("superseded", "entity split");
        },
      }),
    );
    const { scope } = await novelWithGoal(t);
    const { taskId } = await makeTask("revise_episode", scope);
    await e.runOnce();
    expect(await e.getTask(scope, taskId)).toMatchObject({ status: "ready", attemptCount: 0, latestRun: { stopReason: "superseded" } });
    await t.testDb.exec(`UPDATE tasks SET input = '{"n":"x"}' WHERE id = '${taskId}'`);
    await e.runOnce();
    expect(await e.getTask(scope, taskId)).toMatchObject({ status: "failed", latestRun: { errorFamily: "internal" } });
    const retried = await t.http("POST", `/api/novels/${scope.novelId}/tasks/${taskId}/retry`, {});
    expect(retried.body).toMatchObject({ status: "ready", maxAttempts: 4 });
  });

  it("concept tasks need no goal; other kinds need one (INV-GOL-01)", async () => {
    const novel = await t.modules.novel.service.createNovel({}, t.owner);
    const scope = { novelId: novel.id };
    const e = t.modules.orchestration.service;
    await expect(t.platform.uow.run((tx) => e.createTask(tx, scope, { kind: "plan_series_bible", targetType: "novel", targetId: novel.id, input: {}, createdBy: sys }))).rejects.toThrow(/목표/);
    const session = await conceptSessionId(t, novel.id);
    const r = await t.platform.uow.run((tx) => e.createTask(tx, scope, { kind: "check_concept_brief", targetType: "concept_session", targetId: session, input: {}, createdBy: t.owner, cycleKey: "cnm_1" }));
    const task = await e.getTask(scope, r.taskId);
    expect(task).toMatchObject({ goalId: null, priority: 950, input: { cycle_key: "cnm_1" } });
    const other = await t.platform.uow.run((tx) => e.createTask(tx, scope, { kind: "check_concept_brief", targetType: "concept_session", targetId: session, input: {}, createdBy: t.owner, cycleKey: "cnm_2" }));
    expect(other.created).toBe(true); // different cycle_key → new task (TC-2)
    const list = await t.http("GET", `/api/novels/${novel.id}/tasks?status=ready&kind=check_concept_brief`);
    expect(list.body.items).toHaveLength(2);
  });
});

