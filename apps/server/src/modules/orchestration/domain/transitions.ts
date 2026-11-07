/**
 * Orchestration state machines (03 §4.2 Task T1–T12, §4.3 Run R1–R7, 04 §4.3 WakeRequest W1–W5)
 * and pure policies (retry/backoff 04 §7, priority 04 §3.4, reassign 04 §2.2, coalescing 04 §4.2).
 * No I/O.
 */
import { DEFAULTS, type AgentRole, type ErrorFamily, type RunStatus, type RunStopReason, type TaskKind, type TaskStatus, type WakeReason, type WakeStatus } from "@ncs/shared";
import { InvalidTransitionError } from "../../../platform/index.js";

export type TaskAuditAction =
  | "task.created"
  | "task.status_changed"
  | "task.lease_acquired"
  | "task.lease_reclaimed"
  | "task.blocked"
  | "task.unblocked"
  | "task.cancelled";

export interface TaskTransition {
  id: string;
  from: readonly TaskStatus[];
  to: TaskStatus;
  action: TaskAuditAction;
}

export const TASK_TRANSITIONS: readonly TaskTransition[] = [
  { id: "T2", from: ["pending"], to: "ready", action: "task.status_changed" },
  { id: "T3", from: ["ready"], to: "running", action: "task.lease_acquired" },
  { id: "T4", from: ["running"], to: "done", action: "task.status_changed" },
  { id: "T5", from: ["running"], to: "ready", action: "task.status_changed" },
  { id: "T6", from: ["running"], to: "failed", action: "task.status_changed" },
  { id: "T7", from: ["running"], to: "blocked", action: "task.blocked" },
  { id: "T8", from: ["ready", "pending"], to: "blocked", action: "task.blocked" },
  { id: "T9", from: ["blocked"], to: "ready", action: "task.unblocked" },
  { id: "T10", from: ["running"], to: "ready", action: "task.lease_reclaimed" },
  { id: "T11", from: ["pending", "ready", "blocked", "failed"], to: "cancelled", action: "task.cancelled" },
  // user cancel of a running task lands at the next safe point (04 §3.6 "실행 중이면 checkpoint에서")
  { id: "T11s", from: ["running"], to: "cancelled", action: "task.cancelled" },
  { id: "T12", from: ["failed"], to: "ready", action: "task.status_changed" },
  // running → ready at a safe point: pause (03 §4.2 하단), reassign, superseded (06 §3.11)
  { id: "TSP", from: ["running"], to: "ready", action: "task.status_changed" },
];

export function taskTransition(id: TaskTransition["id"], from: TaskStatus): TaskTransition {
  const t = TASK_TRANSITIONS.find((x) => x.id === id);
  if (!t) throw new Error(`unknown task transition ${id}`);
  if (!t.from.includes(from)) throw new InvalidTransitionError("task", from, t.to);
  return t;
}

export function canTransitionTask(id: TaskTransition["id"], from: TaskStatus): boolean {
  return TASK_TRANSITIONS.some((x) => x.id === id && x.from.includes(from));
}

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ["done", "failed", "cancelled"];
export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = ["pending", "ready", "running", "blocked"];

// ── Run ─────────────────────────────────────────────────────────────────
export interface RunTransition {
  id: string;
  from: readonly (RunStatus | "new")[];
  to: RunStatus;
  stopReasons?: readonly RunStopReason[];
  action: "run.queued" | "run.started" | "run.finished" | "run.interrupted";
}

export const RUN_TRANSITIONS: readonly RunTransition[] = [
  { id: "R1", from: ["new"], to: "queued", action: "run.queued" },
  { id: "R2", from: ["queued"], to: "running", action: "run.started" },
  { id: "R3", from: ["queued"], to: "cancelled", action: "run.finished" },
  { id: "R4", from: ["running"], to: "succeeded", stopReasons: ["completed"], action: "run.finished" },
  { id: "R5", from: ["running"], to: "failed", stopReasons: ["error"], action: "run.finished" },
  {
    id: "R6",
    from: ["running"],
    to: "cancelled",
    stopReasons: ["paused", "cancelled_by_user", "budget_blocked", "awaiting_human", "superseded"],
    action: "run.finished",
  },
  { id: "R7", from: ["running"], to: "interrupted", stopReasons: ["lease_lost"], action: "run.interrupted" },
];

export function runTransition(id: RunTransition["id"], from: RunStatus | "new", stopReason?: RunStopReason): RunTransition {
  const t = RUN_TRANSITIONS.find((x) => x.id === id);
  if (!t) throw new Error(`unknown run transition ${id}`);
  if (!t.from.includes(from)) throw new InvalidTransitionError("run", from, t.to);
  if (t.stopReasons && (!stopReason || !t.stopReasons.includes(stopReason))) {
    throw new InvalidTransitionError("run", from, t.to, `stop_reason '${stopReason}' is not allowed for ${id}`);
  }
  return t;
}

// ── WakeRequest ─────────────────────────────────────────────────────────
export const WAKE_TRANSITIONS: readonly { id: string; from: readonly (WakeStatus | "new")[]; to: WakeStatus }[] = [
  { id: "W1", from: ["new"], to: "pending" },
  { id: "W2", from: ["new"], to: "coalesced" },
  { id: "W3", from: ["pending"], to: "claimed" },
  { id: "W4", from: ["pending"], to: "discarded" },
  { id: "W5", from: ["pending"], to: "claimed" },
];

/** WC-3: these reasons skip the coalesce window (a human is waiting) */
export const URGENT_WAKE_REASONS: readonly WakeReason[] = ["user_resume", "question_answered", "approval_decided"];

/** WC-2: not_before of the surviving request when a new one is coalesced into it */
export function coalescedNotBefore(existing: Date | null, incomingReason: WakeReason, incoming: Date | null): Date | null {
  if (incomingReason === "user_resume") return null;
  if (!existing) return null; // existing is already immediate
  if (!incoming) return existing;
  return existing.getTime() >= incoming.getTime() ? existing : incoming;
}

/** WC-3 */
export function wakeClaimable(w: { reason: WakeReason; createdAt: Date; notBeforeAt: Date | null }, now: Date, coalesceWindowMs: number): boolean {
  if (w.notBeforeAt && w.notBeforeAt.getTime() > now.getTime()) return false;
  if (URGENT_WAKE_REASONS.includes(w.reason)) return true;
  return w.createdAt.getTime() <= now.getTime() - coalesceWindowMs;
}

// ── failures → task disposition (04 §7.2) ──────────────────────────────
export type FailureDisposition =
  | { kind: "retry"; notBefore: Date; attemptCount: number }
  | { kind: "failed"; attemptCount: number }
  | { kind: "blocked"; blockReason: "budget" | "budget_reservation_wait" | "provider_unavailable"; attemptCount: number };

export interface FailureInput {
  errorFamily: ErrorFamily;
  retryable: boolean;
  retryNotBefore?: Date;
  attemptCount: number;
  maxAttempts: number;
  /** errorFamily of the previous failed run of the same task (consecutive `internal` → T6) */
  previousErrorFamily?: ErrorFamily | null;
  /** budget refusal reason when errorFamily=budget_blocked */
  budgetReason?: "hard_limit" | "reservation_wait" | "unpriced" | null;
}

const BACKOFF_S = DEFAULTS["llm.retry_backoff_seconds"];

export function backoffMs(attempt: number): number {
  const i = Math.max(0, Math.min(attempt - 1, BACKOFF_S.length - 1));
  return BACKOFF_S[i]! * 1000;
}

export function decideFailure(f: FailureInput, now: Date): FailureDisposition {
  // budget / provider blocks do not consume an attempt (the run never did useful work)
  if (f.errorFamily === "budget_blocked") {
    return { kind: "blocked", blockReason: f.budgetReason === "reservation_wait" ? "budget_reservation_wait" : "budget", attemptCount: f.attemptCount };
  }
  const attemptCount = Math.min(f.attemptCount + 1, f.maxAttempts);
  if (f.errorFamily === "auth_failed" || f.errorFamily === "quota_exhausted") {
    return { kind: "blocked", blockReason: "provider_unavailable", attemptCount };
  }
  const exhausted = f.attemptCount + 1 >= f.maxAttempts;
  if (f.errorFamily === "provider_unavailable" && (exhausted || !f.retryable)) {
    return { kind: "blocked", blockReason: "provider_unavailable", attemptCount };
  }
  const consecutiveInternal = f.errorFamily === "internal" && f.previousErrorFamily === "internal";
  if (!f.retryable || exhausted || consecutiveInternal || f.errorFamily === "content_filtered") return { kind: "failed", attemptCount };
  const nb = f.retryNotBefore && f.retryNotBefore.getTime() > now.getTime() ? f.retryNotBefore : new Date(now.getTime() + backoffMs(f.attemptCount + 1));
  return { kind: "retry", notBefore: nb, attemptCount };
}

// ── priority (04 §3.4 base values) ──────────────────────────────────────
export function basePriority(kind: TaskKind): number {
  switch (kind) {
    case "concept_turn":
    case "import_concept":
    case "check_concept_brief":
    case "revision_chat_turn":
      return 950;
    case "interpret_answer":
    case "apply_answer":
    case "grade_question":
      return 900;
    case "plan_rework":
    case "revise_episode":
      return 800;
    case "check_continuity":
    case "check_setups":
    case "check_text_safety":
      return 700;
    case "outline_episode":
    case "draft_episode":
    case "split_scenes":
    case "extract_facts":
    case "link_mentions":
    case "polish_episode":
    case "adjust_length":
      return 500;
    case "plan_series_bible":
    case "plan_structure":
    case "plan_arc":
    case "plan_setups":
    case "build_initial_ontology":
    case "schedule_episodes":
      return 400;
    case "dedupe_entities":
    case "review_setup_due":
      return 100;
    default:
      return 0;
  }
}

/** starvation guard: + min(100, waited minutes / 10) */
export function effectivePriority(priority: number, createdAt: Date, now: Date): number {
  const waitedMin = Math.max(0, (now.getTime() - createdAt.getTime()) / 60_000);
  return priority + Math.min(100, Math.floor(waitedMin / 10));
}

// ── reassign (04 §2.2) ──────────────────────────────────────────────────
export const REASSIGNABLE: Readonly<Partial<Record<TaskKind, readonly AgentRole[]>>> = {
  revise_episode: ["writer", "line_editor"],
  polish_episode: ["writer", "line_editor"],
  adjust_length: ["writer", "line_editor"],
};

export function reassignAllowed(kind: TaskKind, toRole: AgentRole): boolean {
  return REASSIGNABLE[kind]?.includes(toRole) ?? false;
}

/** episode manuscript writers may not run concurrently on the same episode (04 §3.3, §5.3) */
export const MANUSCRIPT_WRITER_KINDS: readonly TaskKind[] = ["outline_episode", "draft_episode", "revise_episode", "polish_episode", "adjust_length"];

/** wake idempotency keys (04 §4.1) */
export const wakeKeys = {
  created: (taskId: string) => `task:${taskId}:created`,
  dependency: (predId: string, taskId: string) => `dep:${predId}:${taskId}`,
  retry: (taskId: string, attempt: number) => `retry:${taskId}:${attempt}`,
  reclaim: (runId: string, taskId: string) => `reclaim:${runId}:${taskId}`,
  resume: (seq: number | string, taskId: string) => `resume:${seq}:${taskId}`,
  budgetReleased: (reservationId: string, taskId: string) => `budget_rel:${reservationId}:${taskId}`,
  dispatch: (runId: string) => `dispatch:${runId}`,
};
