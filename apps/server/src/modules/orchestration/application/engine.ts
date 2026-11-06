/**
 * Orchestration engine (design/04 §3–§8, §11–§12; 03 §4.2–4.3; ADR-009).
 *
 *  dispatcher tick:  T2 promotion (deps) → W4 discard → reservation-wait recheck → capacity
 *                    (run.max_concurrent_global / _per_novel, pool) → WC-3 coalesce window →
 *                    pause/budget/handler gate (T8) → claim tx [W3 + R1 + T3 CAS lease + R2]
 *  run:              lease renew timer (heartbeat) · execute (no tx, P-2) · checkpoint (safe point)
 *                    · commit tx fenced on lease_run_id (04 §5.2) · finish (T4–T7, T5 backoff, R4–R6)
 *  reclaim:          startup (all queued/running) and periodic (expired lease, not in the active
 *                    registry, LR-1/LR-2) → recovery hooks (llm: sent→unknown, prepared→abandoned)
 *                    → budget reservations closed → R7/R3 → T10 → `reclaim` wake; next run gets
 *                    rerun_of_run_id so llm can reuse recorded responses (RU-2).
 */
import { DEFAULTS, type AgentRole, type ErrorFamily, type TaskKind } from "@ncs/shared";
import {
  actors,
  ConflictError,
  DomainValidationError,
  NotFoundError,
  type ActorRef,
  type NovelScope,
  type Platform,
  type Tx,
} from "../../../platform/index.js";
import type { WorkerPool } from "../../../runtime/worker-pool.js";
import type { AuditService } from "../../audit/index.js";
import type { BudgetService } from "../../budget/index.js";
import type { NovelService } from "../../novel/index.js";
import {
  RunStop,
  TaskFailure,
  type CommitOutcome,
  type OrchestrationService,
  type Run,
  type RunHandle,
  type RunRecoveryHook,
  type Task,
  type TaskContext,
  type TaskKindHandler,
} from "../index.js";
import { CONCEPT_TASK_KINDS, GOAL_OPTIONAL_TASK_KINDS, TASK_KIND_ROLE } from "../domain/task-kinds.js";
import {
  basePriority,
  canTransitionTask,
  coalescedNotBefore,
  decideFailure,
  effectivePriority,
  MANUSCRIPT_WRITER_KINDS,
  reassignAllowed,
  runTransition,
  taskTransition,
  TERMINAL_TASK_STATUSES,
  URGENT_WAKE_REASONS,
  wakeClaimable,
  wakeKeys,
  type TaskTransition,
} from "../domain/transitions.js";
import { taskRepo as repo } from "../adapters/db/task-repository.js";

/** optional llm surface (composition may pass `llm`): recovery of provider calls + provider breaker roles */
export interface EngineLlmPort {
  recoverInterruptedRun?(tx: Tx, scope: NovelScope, runId: string): Promise<unknown>;
  getBinding?(scope: NovelScope, role: AgentRole, tx?: Tx): Promise<{ providerProfileId: string }>;
}

export interface EngineOptions {
  leaseTtlMs?: number;
  renewIntervalMs?: number;
  coalesceWindowMs?: number;
  maxConcurrentPerNovel?: number;
  maxConcurrentGlobal?: number;
}

export interface EngineDeps {
  platform: Platform;
  audit: AuditService;
  novel: NovelService;
  budget: BudgetService;
  pool: WorkerPool;
  llm?: EngineLlmPort;
  options?: EngineOptions;
}

export type OrchestrationEngine = OrchestrationService & {
  tick(signal: AbortSignal, opts?: { ignoreCoalesceWindow?: boolean }): Promise<number>;
  /** in-process active run registry (LR-1) */
  isRunActive(runId: string): boolean;
  /** abort every active run (shutdown) */
  abortAll(): void;
  /** 04 §8.3 (b): T9 for the novel's `budget_reservation_wait` tasks after a reservation closed */
  unblockReservationWaits(tx: Tx, scope: NovelScope, reservationId: string, closedByRunId?: string): Promise<string[]>;
};

interface ActiveRun {
  novelId: string;
  taskId: string;
  ac: AbortController;
  stopCause: RunStop["reason"] | null;
  timer: NodeJS.Timeout | null;
}

type FinishOutcome =
  | CommitOutcome
  | { kind: "stopped"; stop: RunStop }
  | { kind: "error"; error: unknown };

class LeaseLost extends Error {
  constructor() {
    super("lease lost before commit");
  }
}

const SYS = actors.system("orchestrator");
const SCHED = actors.system("scheduler");
const CLEAR_LEASE = { leaseRunId: null, leaseExpiresAt: null } as const;

const isLlmHandler = (h: TaskKindHandler) => !h.promptTemplateVersion.startsWith("code.");

function classify(err: unknown): { errorFamily: ErrorFamily; retryable: boolean; retryNotBefore?: Date; message: string } {
  const e = err as { errorFamily?: ErrorFamily; retryable?: boolean; retryNotBefore?: Date; message?: string; name?: string };
  const message = err instanceof Error ? err.message : String(err);
  if (e && typeof e === "object" && typeof e.errorFamily === "string") {
    return { errorFamily: e.errorFamily, retryable: e.retryable !== false, retryNotBefore: e.retryNotBefore, message };
  }
  if (e && typeof e === "object" && e.name === "ZodError") return { errorFamily: "internal", retryable: false, message: `invalid task input: ${message}` };
  return { errorFamily: "internal", retryable: true, message };
}

export function createOrchestrationEngine(deps: EngineDeps): OrchestrationEngine {
  const { platform, audit, novel, budget, pool } = deps;
  const { uow, ids, clock, log, config } = platform;
  const opt = {
    leaseTtlMs: deps.options?.leaseTtlMs ?? DEFAULTS["lease.ttl_seconds"] * 1000,
    renewIntervalMs: deps.options?.renewIntervalMs ?? DEFAULTS["lease.renew_interval_seconds"] * 1000,
    coalesceWindowMs: deps.options?.coalesceWindowMs ?? DEFAULTS["wake.coalesce_window_seconds"] * 1000,
    maxPerNovel: deps.options?.maxConcurrentPerNovel ?? config.run.max_concurrent_per_novel,
    maxGlobal: deps.options?.maxConcurrentGlobal ?? config.run.max_concurrent_global,
  };
  const handlers = new Map<TaskKind, TaskKindHandler>();
  const recoveryHooks: RunRecoveryHook[] = [];
  const active = new Map<string, ActiveRun>();
  const inflight = new Set<Promise<void>>();
  const taskTarget = (id: string) => ({ type: "task" as const, id });
  const runTarget = (id: string) => ({ type: "run" as const, id });
  const notifyTask = (tx: Tx, novelId: string) => tx.afterCommit(() => platform.workSignal.notify("task", novelId));

  const mustTask = async (tx: Tx | undefined, scope: NovelScope, id: string, forUpdate = false) => {
    const t = await repo.getTask(tx?.db ?? uow.db, scope, id, forUpdate && !!tx);
    if (!t) throw new NotFoundError("작업", id);
    return t;
  };

  /** apply a task transition from the table + audit, CAS on the expected status */
  const transition = async (
    tx: Tx,
    scope: NovelScope,
    task: Task,
    id: TaskTransition["id"],
    patch: Partial<Task>,
    actor: ActorRef,
    extra: { reason?: string | null; details?: unknown; leaseRunId?: string } = {},
  ): Promise<Task> => {
    const t = taskTransition(id, task.status);
    const updated = await repo.updateTask(tx.db, scope, task.id, { ...patch, status: t.to }, { statuses: [task.status], leaseRunId: extra.leaseRunId });
    if (!updated) throw new ConflictError("task_changed", "작업 상태가 바뀌어 처리하지 못했습니다. 다시 시도하세요.", { taskId: task.id });
    await audit.record(tx, {
      novelId: scope.novelId,
      actor,
      action: t.action,
      target: taskTarget(task.id),
      before: { status: task.status, agentRole: task.agentRole },
      after: { status: updated.status, blockReason: updated.blockReason, agentRole: updated.agentRole },
      reason: extra.reason ?? null,
      details: { transition: t.id, ...(extra.details as object | undefined) },
    });
    notifyTask(tx, scope.novelId);
    return updated;
  };

  const inputOf = (t: Task) => (t.input && typeof t.input === "object" ? (t.input as Record<string, unknown>) : {});
  const withoutKeys = (t: Task, keys: string[]) => {
    const copy = { ...inputOf(t) };
    for (const k of keys) delete copy[k];
    return copy;
  };

  // ── wakes (04 §4) ──────────────────────────────────────────────────────
  const requestWake: OrchestrationService["requestWake"] = async (tx, scope, w) => {
    const dup = await repo.findWakeByKey(tx.db, scope, w.idempotencyKey);
    if (dup) return { wakeId: dup.id, status: "duplicate" };
    const base = {
      novelId: scope.novelId,
      taskId: w.taskId,
      reason: w.reason,
      idempotencyKey: w.idempotencyKey,
      notBeforeAt: w.notBefore ?? null,
      sourceRefType: w.source?.refType ?? null,
      sourceRefId: w.source?.refId ?? null,
      createdAt: clock.date(),
    };
    if (w.taskId) {
      const [pending] = await repo.pendingWakesForTask(tx.db, scope, w.taskId, true);
      if (pending) {
        // W2 / WC-1: keep the existing request, record the new one as coalesced
        const row = await repo.insertWake(tx.db, { ...base, id: ids.next("wak"), status: "coalesced", coalescedIntoId: pending.id });
        if (!row) return { wakeId: (await repo.findWakeByKey(tx.db, scope, w.idempotencyKey))!.id, status: "duplicate" };
        const notBeforeAt = coalescedNotBefore(pending.notBeforeAt, w.reason, w.notBefore ?? null);
        const urgent = URGENT_WAKE_REASONS.includes(w.reason) && !URGENT_WAKE_REASONS.includes(pending.reason);
        await repo.updateWake(tx.db, scope, pending.id, { notBeforeAt, ...(urgent ? { reason: w.reason } : {}) }, "pending");
        tx.afterCommit(() => platform.workSignal.notify("wake", scope.novelId));
        return { wakeId: row.id, status: "coalesced" };
      }
    }
    const row = await repo.insertWake(tx.db, { ...base, id: ids.next("wak"), status: "pending" }); // W1
    if (!row) return { wakeId: (await repo.findWakeByKey(tx.db, scope, w.idempotencyKey))!.id, status: "duplicate" };
    tx.afterCommit(() => platform.workSignal.notify("wake", scope.novelId));
    return { wakeId: row.id, status: "pending" };
  };

  const discardPendingWakes = async (tx: Tx, scope: NovelScope, taskId: string) => {
    for (const w of await repo.pendingWakesForTask(tx.db, scope, taskId, true)) await repo.updateWake(tx.db, scope, w.id, { status: "discarded" }, "pending"); // W4
  };

  // ── dependencies (T2 / T11 cascade) ───────────────────────────────────
  /** after `doneTask` completed: promote dependents whose deps are all done (same tx) */
  const promoteDependents = async (tx: Tx, scope: NovelScope, doneTaskId: string) => {
    for (const d of await repo.dependentsOf(tx.db, scope, doneTaskId)) {
      if (d.status === "pending") {
        const deps = await repo.depsOf(tx.db, scope, d.id);
        if (deps.every((x) => x.status === "done" || x.id === doneTaskId)) {
          const fresh = await repo.getTask(tx.db, scope, d.id, true);
          if (fresh?.status === "pending") await transition(tx, scope, fresh, "T2", {}, SCHED);
        }
      }
      if (!TERMINAL_TASK_STATUSES.includes(d.status)) {
        await requestWake(tx, scope, { taskId: d.id, reason: "dependency_done", idempotencyKey: wakeKeys.dependency(doneTaskId, d.id) });
      }
    }
  };

  const promotePending = async () => {
    for (const row of await repo.pendingWithDeps(uow.db, 200)) {
      const t = row.task;
      const scope = { novelId: t.novelId };
      if (row.cancelled > 0 || row.done === row.total) {
        await uow
          .run(async (tx) => {
            const fresh = await repo.getTask(tx.db, scope, t.id, true);
            if (fresh?.status !== "pending") return;
            const deps = await repo.depsOf(tx.db, scope, t.id);
            let cancelledDep = false;
            for (const dep of deps.filter((d) => d.status === "cancelled")) {
              if (dep.supersededByTaskId) await repo.replaceDependency(tx.db, scope, t.id, dep.id, dep.supersededByTaskId);
              else cancelledDep = true;
            }
            if (cancelledDep) {
              await transition(tx, scope, fresh, "T11", { completedAt: clock.date() }, SCHED, { reason: "dependency_cancelled" });
              await discardPendingWakes(tx, scope, t.id);
              return;
            }
            const after = await repo.depsOf(tx.db, scope, t.id);
            if (after.every((d) => d.status === "done")) await transition(tx, scope, fresh, "T2", {}, SCHED);
          })
          .catch((err) => log.warn({ err, taskId: t.id }, "dependency promotion failed"));
      }
    }
  };

  // ── unblock helpers (T9) ───────────────────────────────────────────────
  const unblockTasks = async (tx: Tx, scope: NovelScope, blocked: Task[], wake: (t: Task) => { reason: Parameters<typeof requestWake>[2]["reason"]; key: string; source?: { refType: Task["blockedRefType"] & string; refId: string } }, addAnswerId?: string) => {
    const out: string[] = [];
    for (const t of blocked) {
      if (t.status !== "blocked") continue;
      const input = addAnswerId ? { ...inputOf(t), answer_ids: [...((inputOf(t).answer_ids as string[] | undefined) ?? []), addAnswerId] } : undefined;
      await transition(tx, scope, t, "T9", { blockReason: null, blockedRefType: null, blockedRefId: null, ...(input ? { input } : {}) }, SYS);
      const w = wake(t);
      await requestWake(tx, scope, { taskId: t.id, reason: w.reason, idempotencyKey: w.key, source: w.source });
      out.push(t.id);
    }
    return out;
  };

  const recheckReservationWaits = async () => {
    const byNovel = new Map<string, Task[]>();
    for (const t of await repo.blockedByReason(uow.db, null, "budget_reservation_wait")) byNovel.set(t.novelId, [...(byNovel.get(t.novelId) ?? []), t]);
    for (const [novelId, list] of byNovel) {
      const scope = { novelId };
      if ((await budget.activeReservationCount(scope)) > 0) continue;
      const stamp = Math.floor(clock.now() / 60_000);
      await uow
        .run(async (tx) => {
          const fresh = (await repo.getTasks(tx.db, scope, list.map((t) => t.id))).filter((t) => t.status === "blocked" && t.blockReason === "budget_reservation_wait");
          await unblockTasks(tx, scope, fresh, (t) => ({ reason: "budget_released", key: wakeKeys.budgetReleased(`tick${stamp}`, t.id) }));
        })
        .catch((err) => log.warn({ err, novelId }, "reservation-wait recheck failed"));
    }
  };

  // ── block from outside / before lease (T7 / T8) ───────────────────────
  const blockReady = async (task: Task, blockReason: NonNullable<Task["blockReason"]>, ref: { refType: NonNullable<Task["blockedRefType"]>; refId: string } | null, actor: ActorRef) => {
    const scope = { novelId: task.novelId };
    await uow.run(async (tx) => {
      const t = await repo.getTask(tx.db, scope, task.id, true);
      if (!t || t.status !== "ready") return;
      await transition(tx, scope, t, "T8", { blockReason, blockedRefType: ref?.refType ?? null, blockedRefId: ref?.refId ?? null }, actor);
      await discardPendingWakes(tx, scope, t.id);
    });
  };

  // ── run cost cache (runs.cost_micros etc., 04 §14) ─────────────────────
  const updateRunCache = async (tx: Tx, scope: NovelScope, runId: string, a?: ActiveRunNotes) => {
    const s = await budget.runCostSummary(scope, runId, tx).catch(() => null);
    const patch: Partial<Run> = {};
    if (s) Object.assign(patch, { costMicros: s.costMicros, inputTokens: s.inputTokens, outputTokens: s.outputTokens });
    if (a?.modelsUsed.length) patch.modelsUsed = a.modelsUsed;
    if (a && a.safePointSeq > 0) patch.safePointSeq = a.safePointSeq;
    if (Object.keys(patch).length) await repo.updateRun(tx.db, scope, runId, patch);
  };

  interface ActiveRunNotes {
    modelsUsed: Array<{ provider: string; modelId: string; modelVersion?: string | null }>;
    safePointSeq: number;
  }

  // ── finish (T4–T7, T10, T11s, TSP; R4–R7) ─────────────────────────────
  const finishInTx = async (tx: Tx, scope: NovelScope, runId: string, outcome: FinishOutcome, notes?: ActiveRunNotes) => {
    const now = clock.date();
    const t = await repo.getTask(tx.db, scope, (await repo.getRun(tx.db, scope, runId))!.taskId, true);
    const run = (await repo.getRun(tx.db, scope, runId, true))!;
    const finishRun = async (id: "R4" | "R5" | "R6" | "R7", stopReason: NonNullable<Run["stopReason"]>, error?: { family: ErrorFamily; message: string }) => {
      if (run.status !== "running") return;
      const rt = runTransition(id, run.status, stopReason);
      await repo.updateRun(
        tx.db,
        scope,
        runId,
        { status: rt.to, stopReason, finishedAt: now, errorFamily: error?.family ?? null, errorMessage: error?.message.slice(0, 2000) ?? null },
        ["running"],
      );
      await audit.record(tx, {
        novelId: scope.novelId,
        actor: SYS,
        action: rt.action,
        target: runTarget(runId),
        after: { status: rt.to, stopReason, errorFamily: error?.family ?? null },
        details: { taskId: run.taskId, outcome: outcome.kind },
      });
    };
    if (!t || t.leaseRunId !== runId || t.status !== "running") {
      // lease lost (reclaimed / blocked from outside): never touch the task (04 §5.2 fencing)
      await finishRun("R6", "superseded");
      await budget.closeRunReservations(tx, scope, runId);
      await updateRunCache(tx, scope, runId, notes);
      return;
    }
    const agent = actors.agent(t.agentRole, runId);
    const input = inputOf(t);
    switch (outcome.kind) {
      case "done": {
        await transition(tx, scope, t, "T4", { ...CLEAR_LEASE, outputRefs: outcome.outputRefs, completedAt: now }, SYS, { leaseRunId: runId });
        await finishRun("R4", "completed");
        await promoteDependents(tx, scope, t.id);
        break;
      }
      case "awaiting_human": {
        await transition(
          tx,
          scope,
          t,
          "T7",
          { ...CLEAR_LEASE, blockReason: outcome.blockReason, blockedRefType: outcome.blockedRef.refType, blockedRefId: outcome.blockedRef.refId },
          agent,
          { leaseRunId: runId },
        );
        await finishRun("R6", "awaiting_human");
        break;
      }
      case "stopped": {
        const reason = outcome.stop.reason;
        if (reason === "cancelled_by_user") {
          const supersededBy = typeof input.superseded_by === "string" ? input.superseded_by : null;
          await transition(tx, scope, t, "T11s", { ...CLEAR_LEASE, input: withoutKeys(t, ["cancel_requested", "superseded_by"]), supersededByTaskId: supersededBy, completedAt: now }, SYS, {
            leaseRunId: runId,
            reason: outcome.stop.message,
          });
          await finishRun("R6", "cancelled_by_user");
        } else if (reason === "superseded") {
          const toRole = typeof input.reassign_to === "string" ? (input.reassign_to as AgentRole) : null;
          const updated = await transition(
            tx,
            scope,
            t,
            "TSP",
            { ...CLEAR_LEASE, ...(toRole ? { agentRole: toRole } : {}), input: withoutKeys(t, ["reassign_to"]) },
            SYS,
            { leaseRunId: runId, reason: toRole ? "reassigned" : outcome.stop.message },
          );
          await finishRun("R6", "superseded");
          await requestWake(tx, scope, {
            taskId: updated.id,
            reason: toRole ? "user_resume" : "reclaim",
            idempotencyKey: toRole ? wakeKeys.resume(`reassign_${runId}`, t.id) : wakeKeys.reclaim(runId, t.id),
          });
        } else if (reason === "budget_blocked") {
          const r = budget.refusalForRun(runId) ?? (await budget.admission(scope, "text", tx));
          const ref = !r.ok && r.policyId ? { refType: "budget_policy" as const, refId: r.policyId } : null;
          const waitOnly = !r.ok && r.reason === "reservation_wait";
          await transition(
            tx,
            scope,
            t,
            "T7",
            { ...CLEAR_LEASE, blockReason: waitOnly ? "budget_reservation_wait" : "budget", blockedRefType: ref?.refType ?? null, blockedRefId: ref?.refId ?? null },
            actors.system("budget_guard"),
            { leaseRunId: runId },
          );
          if (!r.ok && r.reason === "hard_limit" && r.policyId) await budget.enforceHardStop(tx, scope, r.policyId);
          await finishRun("R6", "budget_blocked");
        } else if (reason === "awaiting_human") {
          await transition(tx, scope, t, "T7", { ...CLEAR_LEASE, blockReason: "question" }, agent, { leaseRunId: runId });
          await finishRun("R6", "awaiting_human");
        } else if (reason === "lease_lost") {
          await transition(tx, scope, t, "T10", { ...CLEAR_LEASE }, SYS, { leaseRunId: runId });
          await finishRun("R7", "lease_lost");
          await requestWake(tx, scope, { taskId: t.id, reason: "reclaim", idempotencyKey: wakeKeys.reclaim(runId, t.id) });
        } else {
          // paused (task / arc / novel / shutdown): running → ready, paused_at kept (03 §4.2 하단)
          await transition(tx, scope, t, "TSP", { ...CLEAR_LEASE }, SYS, { leaseRunId: runId, reason: outcome.stop.message });
          await finishRun("R6", "paused");
        }
        break;
      }
      case "retry":
      case "failed":
      case "error": {
        const c =
          outcome.kind === "error"
            ? classify(outcome.error)
            : { errorFamily: "internal" as ErrorFamily, retryable: outcome.kind === "retry", retryNotBefore: outcome.kind === "retry" ? outcome.notBefore : undefined, message: outcome.reason };
        const prev = await repo.listRuns(tx.db, scope, t.id);
        const previousErrorFamily = prev.find((r) => r.id !== runId && r.status === "failed")?.errorFamily ?? null;
        const refusal = c.errorFamily === "budget_blocked" ? (budget.refusalForRun(runId) ?? (await budget.admission(scope, "text", tx))) : null;
        const d = decideFailure(
          {
            errorFamily: c.errorFamily,
            retryable: c.retryable,
            retryNotBefore: c.retryNotBefore,
            attemptCount: t.attemptCount,
            maxAttempts: t.maxAttempts,
            previousErrorFamily,
            budgetReason: refusal && !refusal.ok ? refusal.reason : null,
          },
          now,
        );
        const err = { family: c.errorFamily, message: c.message };
        if (d.kind === "retry") {
          await transition(tx, scope, t, "T5", { ...CLEAR_LEASE, attemptCount: d.attemptCount, notBeforeAt: d.notBefore }, SYS, { leaseRunId: runId, reason: c.message.slice(0, 500) });
          await finishRun("R5", "error", err);
          await requestWake(tx, scope, { taskId: t.id, reason: "retry", idempotencyKey: wakeKeys.retry(t.id, d.attemptCount), notBefore: d.notBefore });
        } else if (d.kind === "failed") {
          await transition(tx, scope, t, "T6", { ...CLEAR_LEASE, attemptCount: d.attemptCount, completedAt: now }, SYS, { leaseRunId: runId, reason: c.message.slice(0, 500) });
          await finishRun("R5", "error", err);
        } else {
          const ref = refusal && !refusal.ok && refusal.policyId ? { refType: "budget_policy" as const, refId: refusal.policyId } : null;
          await transition(
            tx,
            scope,
            t,
            "T7",
            { ...CLEAR_LEASE, attemptCount: d.attemptCount, blockReason: d.blockReason, blockedRefType: ref?.refType ?? null, blockedRefId: ref?.refId ?? null },
            d.blockReason === "provider_unavailable" ? actors.system("health_check") : actors.system("budget_guard"),
            { leaseRunId: runId, reason: c.message.slice(0, 500) },
          );
          if (refusal && !refusal.ok && refusal.reason === "hard_limit" && refusal.policyId) await budget.enforceHardStop(tx, scope, refusal.policyId);
          if (d.blockReason === "provider_unavailable") await finishRun("R5", "error", err);
          else await finishRun("R6", "budget_blocked");
        }
        break;
      }
    }
    // R4 guard: no unsettled reservation outlives the run (INV-COST-02)
    await budget.closeRunReservations(tx, scope, runId);
    await updateRunCache(tx, scope, runId, notes);
  };

  // ── execution ───────────────────────────────────────────────────────────
  const execute = async (scope: NovelScope, task: Task, run: Run, handler: TaskKindHandler, chain: string[], outer: AbortSignal) => {
    const ac = new AbortController();
    const entry: ActiveRun = { novelId: scope.novelId, taskId: task.id, ac, stopCause: null, timer: null };
    active.set(run.id, entry);
    const notes: ActiveRunNotes = { modelsUsed: [], safePointSeq: 0 };
    // graceful stop (02 §7.3, 04 §8.3): an in-flight provider call is received and saved; the run then
    // stops at its next safe point. Only the hard deadline (`abortAll`) aborts the provider signal.
    const onOuterAbort = () => {
      entry.stopCause ??= "paused";
    };
    outer.addEventListener("abort", onOuterAbort, { once: true });
    if (outer.aborted) onOuterAbort();
    const renew = async () => {
      try {
        const ok = await uow.run((tx) => repo.renewLease(tx.db, scope, task.id, run.id, clock.date(), new Date(clock.now() + opt.leaseTtlMs)));
        if (!ok) entry.stopCause = "lease_lost"; // fenced at commit / next safe point (04 §5.2)
      } catch (err) {
        log.warn({ err, runId: run.id }, "lease renew failed");
      }
    };
    entry.timer = setInterval(() => void renew(), opt.renewIntervalMs);
    entry.timer.unref?.();
    const llmTask = isLlmHandler(handler);

    const handle: RunHandle = {
      novelId: scope.novelId,
      runId: run.id,
      taskId: task.id,
      role: task.agentRole,
      signal: ac.signal,
      attempt: task.attemptCount + 1,
      rerunOfRunId: run.rerunOfRunId,
      runChain: chain,
      async checkpoint() {
        if (ac.signal.aborted || entry.stopCause) throw new RunStop(entry.stopCause ?? "lease_lost");
        const t = await repo.getTask(uow.db, scope, task.id);
        if (!t || t.status !== "running" || t.leaseRunId !== run.id) throw new RunStop("lease_lost", "lease lost");
        const input = inputOf(t);
        if (input.cancel_requested) throw new RunStop("cancelled_by_user");
        if (input.reassign_to) throw new RunStop("superseded", "reassigned");
        if (t.pausedAt) throw new RunStop("paused", "task paused");
        const n = await novel.getNovel(scope);
        if (n.pausedAt) throw new RunStop("paused", `novel paused (${n.pauseReason})`);
        if (t.arcId && (await novel.getArc(scope, t.arcId)).pausedAt) throw new RunStop("paused", "arc paused");
        if (llmTask && !(await budget.admission(scope)).ok) throw new RunStop("budget_blocked");
      },
      noteModelUsed(m) {
        if (!notes.modelsUsed.some((x) => x.provider === m.provider && x.modelId === m.modelId && x.modelVersion === (m.modelVersion ?? null))) {
          notes.modelsUsed.push({ provider: m.provider, modelId: m.modelId, modelVersion: m.modelVersion ?? null });
        }
      },
      noteSafePoint(seq) {
        notes.safePointSeq = Math.max(notes.safePointSeq, seq);
      },
      async attachContextSnapshot(tx, snapshotId) {
        await repo.updateRun(tx?.db ?? uow.db, scope, run.id, { contextSnapshotId: snapshotId });
      },
    };

    const finish = (outcome: FinishOutcome) => uow.run((tx) => finishInTx(tx, scope, run.id, outcome, notes));
    try {
      let ctx: TaskContext<unknown>;
      try {
        const input = handler.inputSchema.parse(task.input);
        ctx = { scope, task, input, run: handle, log: log.child({ taskId: task.id, runId: run.id, kind: task.kind }) };
      } catch (err) {
        await finish({ kind: "error", error: new TaskFailure("internal", `invalid task input: ${(err as Error).message}`, false) });
        return;
      }
      try {
        const proposal = await handler.execute(ctx);
        await handle.checkpoint();
        await uow.run(async (tx) => {
          // fencing (04 §5.2): the lease must still be ours, otherwise roll back
          const fenced = await repo.getTask(tx.db, scope, task.id, true);
          if (!fenced || fenced.status !== "running" || fenced.leaseRunId !== run.id) throw new LeaseLost();
          const outcome = await handler.commit(tx, { ...ctx, task: fenced }, proposal);
          await finishInTx(tx, scope, run.id, outcome, notes);
        });
      } catch (err) {
        if (err instanceof LeaseLost) {
          await finish({ kind: "stopped", stop: new RunStop("lease_lost") });
        } else if (err instanceof RunStop) {
          await finish({ kind: "stopped", stop: err });
        } else {
          if (!(err instanceof TaskFailure)) log.warn({ err, taskId: task.id, kind: task.kind }, "task run failed");
          await finish({ kind: "error", error: err });
        }
      }
    } catch (err) {
      log.error({ err, runId: run.id }, "finishing run failed");
    } finally {
      if (entry.timer) clearInterval(entry.timer);
      outer.removeEventListener("abort", onOuterAbort);
      active.delete(run.id);
    }
  };

  /** claim one ready task: gates (T8) then one tx: W3 + R1 + T3 CAS + R2. Returns the started run. */
  const claim = async (task: Task, handler: TaskKindHandler): Promise<{ run: Run; task: Task; chain: string[] } | null> => {
    const scope = { novelId: task.novelId };
    if (isLlmHandler(handler)) {
      // T8 budget first so the board shows *why* (a hard stop also pauses the novel)
      const adm = await budget.admission(scope);
      if (!adm.ok) {
        await blockReady(task, "budget", { refType: "budget_policy", refId: adm.policyId }, actors.system("budget_guard"));
        return null;
      }
    }
    const n = await novel.getNovel(scope);
    if (n.pausedAt) return null; // INV-NOV-03 / INV-TSK-05
    if (task.arcId && (await novel.getArc(scope, task.arcId)).pausedAt) return null;
    if (handler.gate) {
      const g = await handler.gate(scope, task);
      if (!g.ok) {
        await blockReady(task, g.blockReason, g.blockedRef ? { refType: g.blockedRef.refType, refId: g.blockedRef.refId } : null, SYS);
        return null;
      }
    }
    return uow.run(async (tx) => {
      const t = await repo.getTask(tx.db, scope, task.id, true);
      const now = clock.date();
      if (!t || t.status !== "ready" || t.pausedAt || (t.notBeforeAt && t.notBeforeAt > now)) return null;
      if (t.episodeId && MANUSCRIPT_WRITER_KINDS.includes(t.kind) && (await repo.runningWriterOnEpisode(tx.db, scope, t.episodeId, MANUSCRIPT_WRITER_KINDS, t.id))) return null;
      const runId = ids.next("run");
      const prev = await repo.latestRun(tx.db, scope, t.id);
      const rerunOf =
        prev && (prev.status === "interrupted" || (prev.status === "cancelled" && ["paused", "lease_lost", "superseded", "budget_blocked"].includes(prev.stopReason ?? "")))
          ? prev.id
          : null;
      let [wake] = await repo.pendingWakesForTask(tx.db, scope, t.id, true);
      if (!wake) {
        wake = (await repo.insertWake(tx.db, {
          id: ids.next("wak"),
          novelId: scope.novelId,
          taskId: t.id,
          reason: rerunOf ? "reclaim" : t.attemptCount > 0 ? "retry" : "task_created",
          idempotencyKey: wakeKeys.dispatch(runId),
          status: "pending",
          createdAt: now,
        }))!;
      }
      const r1 = runTransition("R1", "new");
      let run = await repo.insertRun(tx.db, {
        id: runId,
        novelId: scope.novelId,
        taskId: t.id,
        wakeRequestId: wake.id,
        agentRole: t.agentRole,
        status: r1.to,
        promptTemplateVersion: handler.promptTemplateVersion,
        rerunOfRunId: rerunOf,
        createdAt: now,
      });
      await repo.updateWake(tx.db, scope, wake.id, { status: "claimed", claimedRunId: runId }, "pending"); // W3
      await audit.record(tx, { novelId: scope.novelId, actor: SYS, action: r1.action, target: runTarget(runId), details: { taskId: t.id, kind: t.kind, wakeId: wake.id, reason: wake.reason } });
      const leased = await repo.acquireLease(tx.db, scope, t.id, runId, now, new Date(now.getTime() + opt.leaseTtlMs)); // T3 CAS
      if (!leased) {
        const r3 = runTransition("R3", "queued");
        await repo.updateRun(tx.db, scope, runId, { status: r3.to, stopReason: "lease_lost", finishedAt: now }, ["queued"]);
        await audit.record(tx, { novelId: scope.novelId, actor: SYS, action: r3.action, target: runTarget(runId), after: { status: r3.to, stopReason: "lease_lost" } });
        return null;
      }
      const r2 = runTransition("R2", "queued");
      run = (await repo.updateRun(tx.db, scope, runId, { status: r2.to, startedAt: now, heartbeatAt: now }, ["queued"]))!;
      await audit.record(tx, {
        novelId: scope.novelId,
        actor: SYS,
        action: "task.lease_acquired",
        target: taskTarget(t.id),
        before: { status: t.status },
        after: { status: leased.status },
        details: { transition: "T3", runId, attempt: t.attemptCount + 1, rerunOfRunId: rerunOf },
      });
      await audit.record(tx, { novelId: scope.novelId, actor: SYS, action: r2.action, target: runTarget(runId), details: { taskId: t.id, kind: t.kind } });
      const chain = rerunOf ? await repo.runChain(tx.db, scope, rerunOf) : [];
      return { run, task: leased, chain };
    });
  };

  const tick = async (signal: AbortSignal, o: { ignoreCoalesceWindow?: boolean } = {}): Promise<number> => {
    await promotePending();
    for (const w of await repo.discardableWakes(uow.db)) await repo.updateWake(uow.db, { novelId: w.novelId }, w.id, { status: "discarded" }, "pending"); // W4
    await recheckReservationWaits();
    const free = Math.min(pool.available(), opt.maxGlobal - active.size);
    if (free <= 0 || signal.aborted) return 0;
    const now = clock.date();
    const ready = await repo.readyTasks(uow.db, now, [...handlers.keys()], free * 4 + 8);
    const wakes = await repo.pendingWakesFor(uow.db, ready.map((t) => t.id));
    const candidates = ready
      .filter((t) => {
        if (o.ignoreCoalesceWindow) return true;
        const ws = wakes.filter((w) => w.taskId === t.id);
        return ws.length === 0 || ws.some((w) => wakeClaimable(w, now, opt.coalesceWindowMs)); // WC-3
      })
      .sort((a, b) => effectivePriority(b.priority, b.createdAt, now) - effectivePriority(a.priority, a.createdAt, now));
    let started = 0;
    const perNovel = new Map<string, number>();
    for (const a of active.values()) perNovel.set(a.novelId, (perNovel.get(a.novelId) ?? 0) + 1);
    for (const t of candidates) {
      if (signal.aborted || started >= free) break;
      if ((perNovel.get(t.novelId) ?? 0) >= opt.maxPerNovel) continue;
      const handler = handlers.get(t.kind)!;
      const claimed = await claim(t, handler).catch((err) => {
        log.warn({ err, taskId: t.id }, "claim failed");
        return null;
      });
      if (!claimed) continue;
      started++;
      perNovel.set(t.novelId, (perNovel.get(t.novelId) ?? 0) + 1);
      // register before the job starts so concurrent ticks see the slot as taken
      active.set(claimed.run.id, { novelId: t.novelId, taskId: t.id, ac: new AbortController(), stopCause: null, timer: null });
      const p = pool
        .submit(() => execute({ novelId: t.novelId }, claimed.task, claimed.run, handler, claimed.chain, signal))
        .catch((err) => log.error({ err }, "task execution crashed"));
      inflight.add(p);
      void p.finally(() => inflight.delete(p));
    }
    return started;
  };

  // ── reclaim (04 §11) ────────────────────────────────────────────────────
  const reclaimOrphans = async (o: { startup?: boolean } = {}): Promise<number> => {
    const startup = o.startup ?? false;
    const now = clock.date();
    if (!startup) {
      // LR-2: active runs with an expired lease are renewed, never reclaimed
      for (const [runId, a] of active) {
        const ok = await uow
          .run((tx) => repo.renewLease(tx.db, { novelId: a.novelId }, a.taskId, runId, now, new Date(now.getTime() + opt.leaseTtlMs)))
          .catch(() => true);
        if (!ok) a.stopCause = "lease_lost"; // soft stop; fenced at commit
      }
    }
    let n = 0;
    for (const { run } of await repo.orphanCandidates(uow.db, startup, now)) {
      if (active.has(run.id)) continue;
      const scope = { novelId: run.novelId };
      const done = await uow
        .run(async (tx) => {
          const r = await repo.getRun(tx.db, scope, run.id, true);
          if (!r || (r.status !== "queued" && r.status !== "running")) return false;
          // 1–2: provider calls (llm owns provider_calls): sent → unknown (+ unknown ledger row), prepared → abandoned
          for (const h of recoveryHooks) await h(tx, scope, { runId: r.id, taskId: r.taskId });
          await deps.llm?.recoverInterruptedRun?.(tx, scope, r.id);
          await budget.closeRunReservations(tx, scope, r.id);
          // 3 (R7) / 6 (R3)
          const rt = r.status === "queued" ? runTransition("R3", "queued") : runTransition("R7", "running", "lease_lost");
          await repo.updateRun(tx.db, scope, r.id, { status: rt.to, stopReason: "lease_lost", finishedAt: clock.date() }, [r.status]);
          await audit.record(tx, {
            novelId: scope.novelId,
            actor: SYS,
            action: rt.action,
            target: runTarget(r.id),
            before: { status: r.status },
            after: { status: rt.to, stopReason: "lease_lost" },
            details: { taskId: r.taskId, startup },
          });
          // 4 (T10) + 5 reclaim wake
          const t = await repo.getTask(tx.db, scope, r.taskId, true);
          if (t && t.status === "running" && t.leaseRunId === r.id) {
            await transition(tx, scope, t, "T10", { ...CLEAR_LEASE }, SYS, { details: { runId: r.id } });
          }
          if (t && !TERMINAL_TASK_STATUSES.includes(t.status)) {
            await requestWake(tx, scope, { taskId: t.id, reason: "reclaim", idempotencyKey: wakeKeys.reclaim(r.id, t.id), source: { refType: "run", refId: r.id } });
          }
          await updateRunCache(tx, scope, r.id);
          return true;
        })
        .catch((err) => {
          log.error({ err, runId: run.id }, "reclaim failed");
          return false;
        });
      if (done) n++;
    }
    return n;
  };

  // ── service ─────────────────────────────────────────────────────────────
  const engine: OrchestrationEngine = {
    tick,
    isRunActive: (runId) => active.has(runId),
    async unblockReservationWaits(tx, scope, reservationId, closedByRunId) {
      // the run that released its own reservation is not "another" reservation (04 §8.3 (b))
      const ownTaskId = closedByRunId ? (await repo.getRun(tx.db, scope, closedByRunId))?.taskId : undefined;
      const ids = (await repo.blockedByReason(tx.db, scope, "budget_reservation_wait")).map((t) => t.id).filter((id) => id !== ownTaskId);
      const fresh = (await repo.getTasks(tx.db, scope, ids)).filter((t) => t.status === "blocked" && t.blockReason === "budget_reservation_wait");
      return unblockTasks(tx, scope, fresh, (t) => ({ reason: "budget_released", key: wakeKeys.budgetReleased(reservationId, t.id) }));
    },
    /** hard stop at the shutdown deadline: aborts in-flight provider calls (they close as `unknown`) */
    abortAll() {
      for (const a of active.values()) {
        a.stopCause ??= "paused";
        a.ac.abort();
      }
    },
    registerTaskKind(handler) {
      if (handlers.has(handler.kind)) throw new Error(`task kind already registered: ${handler.kind}`);
      handlers.set(handler.kind, handler as TaskKindHandler);
    },
    getTaskKind: (kind) => handlers.get(kind),
    registeredTaskKinds: () => [...handlers.keys()],
    registerRunRecovery(hook) {
      recoveryHooks.push(hook);
    },

    async createTask(tx, scope, input) {
      const cycleKey = input.cycleKey ?? null;
      const existing = await repo.findActive(tx.db, scope, input.kind, input.targetType, input.targetId, cycleKey); // TC-2
      if (existing) return { taskId: existing.id, created: false };
      let goalId: string | null = null;
      if (!GOAL_OPTIONAL_TASK_KINDS.includes(input.kind)) {
        const goal = await novel.getGoal(scope, tx);
        if (!goal) throw new DomainValidationError("goal_required", "목표가 없어 작업을 만들 수 없습니다."); // INV-GOL-01 / INV-TSK-01
        goalId = goal.id;
      } else if (CONCEPT_TASK_KINDS.includes(input.kind) && input.targetType !== "concept_session") {
        throw new DomainValidationError("invalid_target", "컨셉 작업의 대상은 컨셉 세션이어야 합니다.");
      }
      const dependsOn = [...new Set(input.dependsOn ?? [])];
      const deps = await repo.getTasks(tx.db, scope, dependsOn);
      if (deps.length !== dependsOn.length) throw new DomainValidationError("dependency_not_found", "선행 작업을 찾을 수 없습니다.", { dependsOn });
      const allDone = deps.every((d) => d.status === "done");
      const base = (input.input ?? {}) as Record<string, unknown>;
      const maxAttempts = input.maxAttempts ?? (input.kind === "extract_facts" ? DEFAULTS["extraction.max_retries"] + 1 : DEFAULTS["task.max_attempts"]); // TC-4
      const task = await repo.insertTask(tx.db, {
        id: ids.next("tsk"),
        novelId: scope.novelId,
        displayNo: await novel.nextDisplayNo(tx, scope, "task"),
        kind: input.kind,
        agentRole: TASK_KIND_ROLE[input.kind],
        targetType: input.targetType,
        targetId: input.targetId,
        goalId,
        arcId: input.arcId ?? null,
        episodeId: input.episodeId ?? null,
        parentTaskId: input.parentTaskId ?? null,
        status: allDone ? "ready" : "pending", // T1 (+T2 when nothing to wait for)
        priority: input.priority ?? basePriority(input.kind),
        maxAttempts,
        notBeforeAt: input.notBefore ?? null,
        input: cycleKey ? { ...base, cycle_key: cycleKey } : base,
        createdByActorType: input.createdBy.type,
        createdByActorId: input.createdBy.id,
        createdAt: clock.date(),
      });
      await repo.insertDeps(tx.db, scope, task.id, dependsOn);
      await audit.record(tx, {
        novelId: scope.novelId,
        actor: input.createdBy,
        action: "task.created",
        target: taskTarget(task.id),
        after: { kind: task.kind, status: task.status, targetType: task.targetType, targetId: task.targetId, displayNo: task.displayNo, agentRole: task.agentRole },
        details: { transition: "T1", ...(cycleKey ? { cycleKey } : {}), ...(dependsOn.length ? { dependsOn } : {}) },
      });
      await requestWake(tx, scope, { taskId: task.id, reason: "task_created", idempotencyKey: wakeKeys.created(task.id), notBefore: input.notBefore }); // TC-3
      notifyTask(tx, scope.novelId);
      return { taskId: task.id, created: true };
    },

    requestWake,

    async unblockByRef(tx, scope, ref, wake, addAnswerId) {
      const blocked = await repo.blockedByRef(tx.db, scope, ref.refType, ref.refId);
      return unblockTasks(tx, scope, blocked, (t) => ({ reason: wake.reason, key: `${wake.keyPrefix}:${t.id}`, source: { refType: ref.refType, refId: ref.refId } }), addAnswerId);
    },

    async blockTask(tx, scope, taskId, reason, ref, actor) {
      const t = await mustTask(tx, scope, taskId, true);
      if (t.status === "running") {
        // T7 from outside the run: clearing the lease fences the run out (it stops at its next safe point)
        await transition(tx, scope, t, "T7", { ...CLEAR_LEASE, blockReason: reason, blockedRefType: ref?.refType ?? null, blockedRefId: ref?.refId ?? null }, actor);
        const a = t.leaseRunId ? active.get(t.leaseRunId) : undefined;
        if (a) tx.afterCommit(() => {
          a.stopCause = "lease_lost"; // soft: the in-flight call is saved, the run stops at its next safe point
        });
        return;
      }
      if (!canTransitionTask("T8", t.status)) throw new ConflictError("invalid_transition", "차단할 수 없는 작업 상태입니다.", { status: t.status });
      await transition(tx, scope, t, "T8", { blockReason: reason, blockedRefType: ref?.refType ?? null, blockedRefId: ref?.refId ?? null }, actor);
      await discardPendingWakes(tx, scope, t.id);
    },

    async pause(tx, scope, target, reason, actor) {
      if (target.scope === "novel") return void (await novel.pause(scope, reason, actor, { tx }));
      if (target.scope === "arc") return void (await novel.setArcPaused(scope, target.id, true, actor, tx));
      const t = await mustTask(tx, scope, target.id, true);
      if (TERMINAL_TASK_STATUSES.includes(t.status)) throw new ConflictError("invalid_transition", "끝난 작업은 일시정지할 수 없습니다.", { status: t.status });
      if (t.pausedAt) return;
      await repo.updateTask(tx.db, scope, t.id, { pausedAt: clock.date() });
      await audit.record(tx, { novelId: scope.novelId, actor, action: "task.paused", target: taskTarget(t.id), details: { reason, status: t.status } });
    },

    async resume(tx, scope, target, actor) {
      if (target.scope === "novel") {
        const n = await novel.getNovel(scope, tx);
        if (n.pausedAt && n.pauseReason === "budget_hard_limit") {
          throw new ConflictError("budget_resume_required", "예산 한도로 멈춘 작품은 예산 재개 승인 후에 다시 시작합니다.");
        }
        if (n.pausedAt && n.pauseReason === "ontology_integrity") {
          throw new ConflictError("integrity_check_required", "온톨로지 무결성 점검을 통과해야 다시 시작할 수 있습니다.");
        }
        return void (await novel.resume(scope, actor, { tx }));
      }
      if (target.scope === "arc") return void (await novel.setArcPaused(scope, target.id, false, actor, tx));
      const t = await mustTask(tx, scope, target.id, true);
      if (!t.pausedAt) return;
      await repo.updateTask(tx.db, scope, t.id, { pausedAt: null });
      const ev = await audit.record(tx, { novelId: scope.novelId, actor, action: "task.resumed", target: taskTarget(t.id) });
      if (!TERMINAL_TASK_STATUSES.includes(t.status)) {
        await requestWake(tx, scope, { taskId: t.id, reason: "user_resume", idempotencyKey: wakeKeys.resume(ev.seq, t.id) });
      }
      notifyTask(tx, scope.novelId);
    },

    async cancelTask(tx, scope, taskId, actor, supersededBy) {
      const t = await mustTask(tx, scope, taskId, true);
      if (t.status === "running") {
        // lands at the next safe point (T11s)
        await repo.updateTask(tx.db, scope, t.id, { input: { ...inputOf(t), cancel_requested: true, ...(supersededBy ? { superseded_by: supersededBy } : {}) } });
        return;
      }
      if (!canTransitionTask("T11", t.status)) {
        throw new ConflictError("invalid_transition", "이미 끝난 작업은 취소할 수 없습니다.", { status: t.status });
      }
      await transition(tx, scope, t, "T11", { supersededByTaskId: supersededBy ?? null, completedAt: clock.date() }, actor);
      await discardPendingWakes(tx, scope, t.id);
    },

    retryTask(scope, taskId, actor) {
      return uow.run(async (tx) => {
        const t = await mustTask(tx, scope, taskId, true);
        if (t.status !== "failed") throw new ConflictError("invalid_transition", "실패한 작업만 다시 시도할 수 있습니다.", { status: t.status });
        const updated = await transition(tx, scope, t, "T12", { maxAttempts: t.maxAttempts + 1, notBeforeAt: null, completedAt: null }, actor, { reason: "사용자 재시도(T12)" });
        await requestWake(tx, scope, { taskId: t.id, reason: "user_resume", idempotencyKey: wakeKeys.resume(`retry${updated.maxAttempts}`, t.id) });
        return updated;
      });
    },

    async reassignTask(tx, scope, taskId, toRole, actor) {
      const t = await mustTask(tx, scope, taskId, true);
      if (["done", "failed", "cancelled"].includes(t.status)) return { rejected: "terminal" };
      if (t.agentRole === toRole) return { applied: "now" };
      if (!reassignAllowed(t.kind, toRole)) return { rejected: "role_not_allowed" };
      if (t.status === "running") {
        await repo.updateTask(tx.db, scope, t.id, { input: { ...inputOf(t), reassign_to: toRole } });
        await audit.record(tx, {
          novelId: scope.novelId,
          actor,
          action: "task.reassigned",
          target: taskTarget(t.id),
          before: { agentRole: t.agentRole },
          after: { agentRole: toRole },
          details: { applied: "after_safe_point" },
        });
        return { applied: "after_safe_point" };
      }
      await repo.updateTask(tx.db, scope, t.id, { agentRole: toRole });
      const ev = await audit.record(tx, {
        novelId: scope.novelId,
        actor,
        action: "task.reassigned",
        target: taskTarget(t.id),
        before: { agentRole: t.agentRole },
        after: { agentRole: toRole },
        details: { applied: "now" },
      });
      if (t.status === "ready") await requestWake(tx, scope, { taskId: t.id, reason: "user_resume", idempotencyKey: wakeKeys.resume(ev.seq, t.id) });
      return { applied: "now" };
    },

    async blockTasksForProvider(tx, providerProfileId) {
      if (!deps.llm?.getBinding) return 0;
      let n = 0;
      for (const novelId of await repo.novelsWithReadyTasks(tx.db)) {
        const scope = { novelId };
        const ready = await repo.readyByRoles(tx.db, scope, [...new Set(Object.values(TASK_KIND_ROLE))]);
        const roles = [...new Set(ready.map((t) => t.agentRole))];
        const affected = new Set<AgentRole>();
        for (const role of roles) {
          const b = await deps.llm.getBinding(scope, role, tx).catch(() => null);
          if (b?.providerProfileId === providerProfileId) affected.add(role);
        }
        for (const t of ready.filter((x) => affected.has(x.agentRole) && handlers.get(x.kind) && isLlmHandler(handlers.get(x.kind)!))) {
          await transition(tx, scope, t, "T8", { blockReason: "provider_unavailable", blockedRefType: null, blockedRefId: null }, actors.system("health_check"), {
            details: { providerProfileId },
          });
          n++;
        }
      }
      return n;
    },

    async getTask(scope, taskId, tx) {
      const t = await mustTask(tx, scope, taskId);
      return (await repo.attachLatestRuns(tx?.db ?? uow.db, scope, [t]))[0]!;
    },
    listTasks: (scope, filter = {}, tx) => repo.list(tx?.db ?? uow.db, scope, filter),
    listRuns: (scope, taskId) => repo.listRuns(uow.db, scope, taskId),
    async getRun(scope, runId, tx) {
      const r = await repo.getRun(tx?.db ?? uow.db, scope, runId);
      if (!r) throw new NotFoundError("실행", runId);
      return r;
    },
    reclaimOrphans,
    async runOnce() {
      const n = await tick(new AbortController().signal, { ignoreCoalesceWindow: true });
      await Promise.all([...inflight]);
      return n;
    },
  };
  return engine;
}
