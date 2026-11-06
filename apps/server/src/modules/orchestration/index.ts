/**
 * orchestration — public API (design/04 §3–§8, §11–§13; 03 §4.2–4.3).
 * Owns: tasks, task_dependencies, wake_requests, runs.
 *
 * TASK-KIND REGISTRY: modules contribute work by registering one `TaskKindHandler` per `task_kind`
 * (`orchestration.registerTaskKind(handler)`), usually built with `agents.defineAgentTask(...)` for
 * LLM tasks. The engine runs `execute` outside any transaction (no domain writes — P-2) and then
 * `commit` inside ONE transaction after fencing the lease (04 §5.2, §6.1).
 *
 * Engine: application/engine.ts — CAS lease + fencing, heartbeat renewal, orphan reclaim (startup +
 * periodic), wake coalescing (WC-1..3), concurrency caps (run.max_concurrent_*), retry/backoff (04 §7.2),
 * pre-lease gates (pause, budget hard stop, handler.gate), pause/resume/cancel/reassign at safe points.
 *
 * RULE: `RunHandle.checkpoint()` reads outside any transaction — never call it inside `uow.run`.
 */
import type { z } from "zod";
import type {
  AgentRole,
  PauseReason,
  PauseScope,
  RefType,
  RunStopReason,
  ErrorFamily,
  TargetType,
  TaskBlockReason,
  TaskKind,
  TaskStatus,
  WakeReason,
} from "@ncs/shared";
import type { RunsRow, TasksRow } from "@ncs/db/schema";
import type { ActorRef, Logger, NovelScope, Tx } from "../../platform/index.js";

export type Task = TasksRow;
export type Run = RunsRow;

// ── run handle & outcomes (04 §6.1, §6.4, §10.2) ─────────────────────────
export interface RunHandle {
  readonly novelId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly role: AgentRole;
  /** aborted when the lease is lost / shutdown / pause — pass to LLM calls */
  readonly signal: AbortSignal;
  /** 1-based attempt number of the task */
  readonly attempt: number;
  /** safe point (04 §6.4): throws RunStop when the run must stop. Call OUTSIDE transactions. */
  checkpoint(): Promise<void>;
  /** previous run when this run re-executes an interrupted/stopped one (runs.rerun_of_run_id) */
  readonly rerunOfRunId?: string | null;
  /** previous runs of the rerun chain, newest first (RU-2 response reuse scope; excludes this run) */
  readonly runChain?: readonly string[];
  /** record a model used by this run (copied to runs.models_used at finish) */
  noteModelUsed?(m: { provider: string; modelId: string; modelVersion?: string | null }): void;
  /** last ProviderCall.seq whose response is stored (runs.safe_point_seq) */
  noteSafePoint?(seq: number): void;
  /** runs.context_snapshot_id (agents ContextBuilder); pass the caller's tx when inside one */
  attachContextSnapshot?(tx: Tx | null, snapshotId: string): Promise<void>;
}

/**
 * Reclaim hook (04 §11.2 steps 1–2), called in the reclaim transaction of an orphaned run BEFORE the
 * run is marked interrupted: the provider_calls owner closes `sent` calls as unknown
 * (budget.closeUnknown with call meta) and `prepared` calls as abandoned (budget.release).
 */
export type RunRecoveryHook = (tx: Tx, scope: NovelScope, run: { runId: string; taskId: string }) => Promise<void>;

/** Thrown by checkpoint() (or handlers) to end a run at a safe point (R6). */
export class RunStop extends Error {
  constructor(readonly reason: Exclude<RunStopReason, "completed" | "error">, message?: string) {
    super(message ?? `run stopped: ${reason}`);
    this.name = "RunStop";
  }
}

/** Thrown by handlers for a classified failure (ModelCallError from llm also carries `errorFamily`). */
export class TaskFailure extends Error {
  constructor(
    readonly errorFamily: ErrorFamily,
    message: string,
    readonly retryable = true,
    readonly retryNotBefore?: Date,
  ) {
    super(message);
    this.name = "TaskFailure";
  }
}

export type CommitOutcome =
  | { kind: "done"; outputRefs: Array<{ refType: RefType; refId: string }> }
  | { kind: "awaiting_human"; blockReason: "question" | "approval"; blockedRef: { refType: "question" | "approval"; refId: string } }
  | { kind: "retry"; reason: string; notBefore?: Date }
  | { kind: "failed"; reason: string };

export interface TaskContext<I> {
  readonly scope: NovelScope;
  readonly task: Task;
  readonly input: I;
  readonly run: RunHandle;
  readonly log: Logger;
}

/** One handler per task_kind. */
export interface TaskKindHandler<I = unknown, P = unknown> {
  readonly kind: TaskKind;
  /** must equal TASK_KIND_ROLE[kind] unless reassigned */
  readonly role: AgentRole;
  /** `<agent_role>.<task_kind>@<semver>` → runs.prompt_template_version; deterministic tasks use `code.<kind>@<semver>` */
  readonly promptTemplateVersion: string;
  readonly inputSchema: z.ZodType<I>;
  /** pre-lease gate (e.g. INV-BIB-02, INV-ARC-02); return a block to keep the task from running */
  gate?(scope: NovelScope, task: Task): Promise<{ ok: true } | { ok: false; blockReason: TaskBlockReason; blockedRef?: { refType: RefType; refId: string } }>;
  /** proposals only — no domain writes (P-2). LLM calls go through llm.ModelCallPort with ctx.run. */
  execute(ctx: TaskContext<I>): Promise<P>;
  /** deterministic writes in the engine's transaction; create follow-up tasks via orchestration.createTask(tx, …) */
  commit(tx: Tx, ctx: TaskContext<I>, proposal: P): Promise<CommitOutcome>;
  /**
   * optional: a run ended WITHOUT its commit (stopped at a safe point — cancel, pause, lease lost, budget, reassign —,
   * the commit transaction rolled back, or execute threw). Runs in its own transaction after the run is finished (the
   * task already shows its next status); `proposal` is set when execute returned. Best effort: errors are logged.
   */
  onUncommitted?(tx: Tx, ctx: TaskContext<I>, info: { outcome: "stopped" | "error"; reason: string; proposal: P | undefined }): Promise<void>;
}

export interface TaskKindRegistry {
  registerTaskKind<I, P>(handler: TaskKindHandler<I, P>): void;
  getTaskKind(kind: TaskKind): TaskKindHandler | undefined;
  registeredTaskKinds(): TaskKind[];
}

// ── inputs ───────────────────────────────────────────────────────────────
export interface CreateTaskInput {
  kind: TaskKind;
  targetType: TargetType;
  targetId: string;
  input: unknown;
  createdBy: ActorRef;
  dependsOn?: string[];
  /** TC-2 de-duplication key (e.g. last cnm_ id for concept_turn) */
  cycleKey?: string;
  arcId?: string | null;
  episodeId?: string | null;
  parentTaskId?: string | null;
  priority?: number;
  maxAttempts?: number;
  notBefore?: Date;
}

export interface RequestWakeInput {
  taskId: string | null;
  reason: WakeReason;
  idempotencyKey: string;
  notBefore?: Date;
  source?: { refType: RefType; refId: string };
}

export interface TaskFilter {
  statuses?: TaskStatus[];
  kinds?: TaskKind[];
  agentRole?: AgentRole;
  arcId?: string;
  episodeId?: string;
  targetType?: TargetType;
  targetId?: string;
  includeCancelled?: boolean;
  limit?: number;
}

export interface TaskWithLatestRun extends Task {
  latestRun: Pick<Run, "id" | "status" | "stopReason" | "errorFamily" | "errorMessage" | "startedAt" | "heartbeatAt" | "finishedAt" | "costMicros"> | null;
}

// ── service (04 §13 OrchestrationApi + registry + read side) ──────────────
export interface OrchestrationService extends TaskKindRegistry {
  createTask(tx: Tx, scope: NovelScope, input: CreateTaskInput): Promise<{ taskId: string; created: boolean }>;
  requestWake(tx: Tx, scope: NovelScope, w: RequestWakeInput): Promise<{ wakeId: string; status: "pending" | "coalesced" | "duplicate" }>;
  /** T9: unblock tasks blocked on a question/approval/budget policy (or a novel-wide gate such as the story structure), add wakes; returns task ids */
  unblockByRef(
    tx: Tx,
    scope: NovelScope,
    ref: { refType: "question" | "approval" | "budget_policy" | "novel"; refId: string },
    wake: { reason: WakeReason; keyPrefix: string },
    addAnswerId?: string,
  ): Promise<string[]>;
  /** T7/T8 from outside a run (e.g. budget_guard, health_check) */
  blockTask(tx: Tx, scope: NovelScope, taskId: string, reason: TaskBlockReason, ref: { refType: RefType; refId: string } | null, actor: ActorRef): Promise<void>;
  pause(tx: Tx, scope: NovelScope, target: { scope: PauseScope; id: string }, reason: PauseReason, actor: ActorRef): Promise<void>;
  resume(tx: Tx, scope: NovelScope, target: { scope: PauseScope; id: string }, actor: ActorRef): Promise<void>;
  cancelTask(tx: Tx, scope: NovelScope, taskId: string, actor: ActorRef, supersededBy?: string): Promise<void>;
  /** T12 (user retry of a failed task, max_attempts + 1) */
  retryTask(scope: NovelScope, taskId: string, actor: ActorRef): Promise<Task>;
  reassignTask(
    tx: Tx,
    scope: NovelScope,
    taskId: string,
    toRole: AgentRole,
    actor: ActorRef,
  ): Promise<{ applied: "now" | "after_safe_point" } | { rejected: "role_not_allowed" | "terminal" }>;
  /** 04 §7.3 provider circuit breaker (install level) */
  blockTasksForProvider(tx: Tx, providerProfileId: string): Promise<number>;

  getTask(scope: NovelScope, taskId: string, tx?: Tx): Promise<TaskWithLatestRun>;
  listTasks(scope: NovelScope, filter?: TaskFilter, tx?: Tx): Promise<TaskWithLatestRun[]>;
  listRuns(scope: NovelScope, taskId: string): Promise<Run[]>;
  getRun(scope: NovelScope, runId: string, tx?: Tx): Promise<Run>;
  /** run one dispatcher pass now (tests / CLI; ignores the coalesce window); resolves after started runs finish */
  runOnce(): Promise<number>;
  /** 04 §11.2: reclaim orphaned runs (startup=true: every queued/running run). Returns the number reclaimed. */
  reclaimOrphans(opts?: { startup?: boolean }): Promise<number>;
  /** llm (provider_calls owner) registers its interrupted-call recovery here */
  registerRunRecovery(hook: RunRecoveryHook): void;
}

export { TASK_KIND_ROLE, TASK_KIND_TARGET, CONCEPT_TASK_KINDS, GOAL_OPTIONAL_TASK_KINDS, MVP_ALPHA_TASK_KINDS } from "./domain/task-kinds.js";
export type { OrchestrationModuleDeps } from "./module.js";
export { createOrchestrationModule } from "./module.js";
