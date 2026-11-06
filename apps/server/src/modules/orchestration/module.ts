/** orchestration module factory (04): engine, budget registries, INV-GOL-02 hook, loops, startup reclaim. */
import { DEFAULTS } from "@ncs/shared";
import { actors, type Platform, type ServerModule } from "../../platform/index.js";
import type { WorkerPool } from "../../runtime/worker-pool.js";
import type { AuditService } from "../audit/index.js";
import type { NovelService } from "../novel/index.js";
import type { BudgetService } from "../budget/index.js";
import type { OrchestrationService } from "./index.js";
import { createOrchestrationEngine, type EngineLlmPort, type EngineOptions } from "./application/engine.js";
import { mountOrchestrationRoutes } from "./adapters/http/routes.js";
import { taskRepo } from "./adapters/db/task-repository.js";

export interface OrchestrationModuleDeps {
  platform: Platform;
  audit: AuditService;
  novel: NovelService;
  /** reservation gating (T8), run cost context, reservation-wait / resume unblocking */
  budget: BudgetService;
  /** shared execution pool (runtime) */
  pool: WorkerPool;
  /** optional (composition request): provider-call recovery on reclaim + provider breaker bindings */
  llm?: EngineLlmPort;
  options?: EngineOptions;
}

export function createOrchestrationModule(deps: OrchestrationModuleDeps): ServerModule<OrchestrationService> {
  const engine = createOrchestrationEngine(deps);
  const { budget, novel, platform } = deps;

  // budget registries (budget is built before orchestration → registry inversion, CONVENTIONS §6)
  budget.registerRunInfoResolver(async (tx, scope, runId) => {
    const run = await taskRepo.getRun(tx.db, scope, runId);
    if (!run) return null;
    const task = await taskRepo.getTask(tx.db, scope, run.taskId);
    return task ? { taskId: task.id, agentRole: run.agentRole, arcId: task.arcId, episodeId: task.episodeId } : null;
  });
  budget.registerActiveRunProbe((runId) => engine.isRunActive(runId));
  // 04 §8.3 (b): another reservation closed → release reservation-wait tasks of the novel (T9 + budget_released)
  budget.onReservationClosed(async (tx, scope, e) => {
    await engine.unblockReservationWaits(tx, scope, e.reservationId, e.runId);
  });
  // 04 §8.3 "재개": budget_resume approved / manual resume → budget-blocked tasks T9 + budget_resumed
  budget.onResumed(async (tx, scope, e) => {
    await engine.unblockByRef(tx, scope, { refType: "budget_policy", refId: e.policyId }, { reason: "budget_resumed", keyPrefix: `budget:${e.approvalId ?? e.policyId}` });
  });

  // INV-GOL-02: a goal change wakes the planning tasks
  novel.onGoalSaved(async ({ tx, scope, goal }) => {
    const planning = await taskRepo.activeByKinds(tx.db, scope, ["plan_arc", "outline_episode", "schedule_episodes"]);
    const stamp = goal.updatedAt instanceof Date ? goal.updatedAt.getTime() : platform.clock.now();
    for (const t of planning) {
      await engine.requestWake(tx, scope, { taskId: t.id, reason: "schedule", idempotencyKey: `goal:${goal.id}:${stamp}:${t.id}`, source: { refType: "goal", refId: goal.id } });
    }
  });

  return {
    name: "orchestration",
    implemented: true,
    service: engine,
    routes: (r) => mountOrchestrationRoutes(r, engine, platform.uow),
    loops: [
      {
        name: "orchestration.dispatcher",
        intervalMs: DEFAULTS["scheduler.poll_interval_seconds"] * 1000,
        wakeOn: ["wake", "task"],
        async tick(signal) {
          await engine.tick(signal);
        },
      },
      {
        name: "orchestration.reclaimer",
        intervalMs: DEFAULTS["reclaim.scan_interval_seconds"] * 1000,
        runOnStart: false,
        async tick() {
          await engine.reclaimOrphans({ startup: false });
        },
      },
    ],
    async start() {
      // 04 §11.1 step 3–4: single process holds the instance lock → every queued/running run is dead
      const n = await engine.reclaimOrphans({ startup: true });
      const released = await budget.sweepStaleReservations({ olderThanMs: 0 }).catch(() => 0);
      if (n || released) platform.log.info({ reclaimed: n, releasedReservations: released, actor: actors.system("orchestrator").id }, "orchestration recovery on boot");
    },
    async stop() {
      engine.abortAll();
    },
  };
}
