/**
 * Pure aggregation for the read-only agent overview ("에이전트 현황"). No I/O: the HTTP adapter
 * loads rows (orchestration tables + llm read ports) and passes them in with `now`.
 */
import {
  AGENT_GATE_AFTER_STAGE,
  AGENT_RECENT_ERROR_MS,
  AGENT_PIPELINE_GATES,
  AGENT_PIPELINE_STAGES,
  TASK_KIND_STAGE,
  type AgentPipelineGate,
  type AgentPipelineStage,
  type AgentRole,
  type AgentRoleState,
  type RefType,
  type ErrorFamily,
  type RunStatus,
  type RunStopReason,
  type TaskBlockReason,
  type TaskKind,
  type TaskStatus,
} from "@ncs/shared";

/** Roster order shown on the page (총괄 first, media roles last). */
export const ROSTER_ORDER: readonly AgentRole[] = [
  "showrunner",
  "planner",
  "scene_director",
  "writer",
  "line_editor",
  "continuity_editor",
  "foreshadow_manager",
  "world_keeper",
  "concept_partner",
  "visual_producer",
];

export interface StatusCounts {
  pending: number;
  ready: number;
  running: number;
  blocked: number;
  failed: number;
  done: number;
}
const zero = (): StatusCounts => ({ pending: 0, ready: 0, running: 0, blocked: 0, failed: 0, done: 0 });

export interface TaskCountRow {
  kind: TaskKind;
  agentRole: AgentRole;
  status: TaskStatus;
  blockReason: TaskBlockReason | null;
  blockedRefType: RefType | null;
  n: number;
}

export interface OpenTaskRow {
  id: string;
  displayNo: number;
  kind: TaskKind;
  agentRole: AgentRole;
  status: TaskStatus;
  blockReason: TaskBlockReason | null;
  blockedRefType: RefType | null;
  blockedRefId: string | null;
  leaseRunId: string | null;
  leaseExpiresAt: Date | null;
  attemptCount: number;
  maxAttempts: number;
  startedAt: Date | null;
}

export interface FailedTaskRow {
  id: string;
  displayNo: number;
  kind: TaskKind;
  agentRole: AgentRole;
  updatedAt: Date;
  errorFamily: ErrorFamily | null;
  errorMessage: string | null;
}

export interface RunSpanRow {
  id: string;
  taskId: string;
  taskDisplayNo: number;
  kind: TaskKind;
  role: AgentRole;
  status: RunStatus;
  stopReason: RunStopReason | null;
  errorFamily: ErrorFamily | null;
  createdAt: Date;
  startedAt: Date | null;
  heartbeatAt: Date | null;
  finishedAt: Date | null;
  taskAttemptCount: number;
  maxAttempts: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  modelsUsed: unknown;
  /** agent-to-agent repair rounds (runs.output_summary.repairRounds); 0 when absent */
  repairRounds?: number;
}

export interface RoleUsageRow {
  agentRole: AgentRole;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  lastActiveAt: Date | null;
}

export interface LiveRunInfo {
  model: { provider: string; modelId: string } | null;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
}

export interface OverviewInput {
  now: Date;
  todayStart: Date;
  timezone: string;
  paused: boolean;
  counts: TaskCountRow[];
  open: OpenTaskRow[];
  failed: FailedTaskRow[];
  /** heartbeat of the runs leased by running tasks */
  runHeartbeats: ReadonlyMap<string, { startedAt: Date | null; heartbeatAt: Date | null }>;
  usage: RoleUsageRow[];
  /** run id → live info (running runs only) */
  live: ReadonlyMap<string, LiveRunInfo>;
  /** role → bound model id */
  bindings: ReadonlyMap<AgentRole, string>;
}

/** Which approval gate a task blocked on `approval` is waiting behind (null = not on the pipeline). */
export function gateForApprovalBlock(kind: TaskKind, blockedRefType: RefType | null): AgentPipelineGate | null {
  const stage = TASK_KIND_STAGE[kind];
  switch (stage) {
    case "concept":
    case "world":
    case "cast":
      return "concept";
    case "structure":
      return "structure";
    case "plot":
    case "outline":
    case "draft":
      // `novel` ref = story-structure gate (manuscript structureGateRef); otherwise the arc / bible approval
      if (blockedRefType === "novel") return "structure";
      return "plot";
    case "polish":
    case "check":
      return "episode";
    default:
      return null;
  }
}

/** question / approval blocks are the normal human-in-the-loop wait, not a fault */
export const isHumanBlock = (reason: TaskBlockReason | null): boolean => reason === "question" || reason === "approval";

/** `awaitingHuman` ⊆ `c.blocked`; `recentError` = the role's latest failure is within AGENT_RECENT_ERROR_MS. */
export function roleState(c: StatusCounts, awaitingHuman = 0, recentError = c.failed > 0): AgentRoleState {
  if (c.running > 0) return "running";
  if (recentError) return "error";
  if (c.blocked - awaitingHuman > 0) return "blocked";
  if (awaitingHuman > 0) return "awaiting_human";
  if (c.pending + c.ready > 0) return "waiting";
  return "idle";
}

/** "provider/model" labels of runs.models_used (tolerates malformed jsonb). */
export function modelLabels(modelsUsed: unknown): string[] {
  if (!Array.isArray(modelsUsed)) return [];
  const out: string[] = [];
  for (const m of modelsUsed) {
    if (typeof m === "string") out.push(m);
    else if (m && typeof m === "object" && typeof (m as { modelId?: unknown }).modelId === "string") out.push((m as { modelId: string }).modelId);
  }
  return [...new Set(out)];
}

/** Midnight of `at`'s calendar day in `timeZone` (DST shifts inside the day are ignored). */
export function startOfLocalDay(at: Date, timeZone: string): Date {
  let parts: Record<string, string>;
  try {
    const f = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    parts = Object.fromEntries(f.formatToParts(at).map((p) => [p.type, p.value]));
  } catch {
    parts = { hour: String(at.getUTCHours()), minute: String(at.getUTCMinutes()), second: String(at.getUTCSeconds()) };
  }
  const elapsed = ((Number(parts.hour) % 24) * 3600 + Number(parts.minute) * 60 + Number(parts.second)) * 1000 + at.getUTCMilliseconds();
  return new Date(at.getTime() - elapsed);
}

function add(c: StatusCounts, status: TaskStatus, n: number): void {
  if (status in c) c[status as keyof StatusCounts] += n;
}

export function buildAgentsOverview(i: OverviewInput) {
  const byRole = new Map<AgentRole, StatusCounts>(ROSTER_ORDER.map((r) => [r, zero()]));
  const byStage = new Map<AgentPipelineStage, { counts: StatusCounts; awaitingQuestion: number; awaitingApproval: number }>(
    AGENT_PIPELINE_STAGES.map((s) => [s, { counts: zero(), awaitingQuestion: 0, awaitingApproval: 0 }]),
  );
  const gates = new Map<AgentPipelineGate, number>(AGENT_PIPELINE_GATES.map((g) => [g, 0]));
  const humanByRole = new Map<AgentRole, number>();
  const other = zero();

  for (const row of i.counts) {
    if (row.status === "cancelled") continue;
    const rc = byRole.get(row.agentRole) ?? zero();
    byRole.set(row.agentRole, rc);
    add(rc, row.status, row.n);
    if (row.status === "blocked" && isHumanBlock(row.blockReason)) humanByRole.set(row.agentRole, (humanByRole.get(row.agentRole) ?? 0) + row.n);
    const stage = TASK_KIND_STAGE[row.kind];
    const st = stage ? byStage.get(stage)! : null;
    add(st ? st.counts : other, row.status, row.n);
    if (row.status === "blocked" && st) {
      if (row.blockReason === "question") st.awaitingQuestion += row.n;
      if (row.blockReason === "approval") {
        st.awaitingApproval += row.n;
        const g = gateForApprovalBlock(row.kind, row.blockedRefType);
        if (g) gates.set(g, gates.get(g)! + row.n);
      }
    }
  }

  const usage = new Map(i.usage.map((u) => [u.agentRole, u]));
  const lastError = new Map<AgentRole, FailedTaskRow>();
  for (const f of i.failed) {
    const prev = lastError.get(f.agentRole);
    if (!prev || prev.updatedAt < f.updatedAt) lastError.set(f.agentRole, f);
  }

  const roles = [...byRole.entries()].map(([role, counts]) => {
    const mine = i.open.filter((t) => t.agentRole === role);
    const current = mine
      .filter((t) => t.status === "running")
      .map((t) => {
        const run = t.leaseRunId ? i.runHeartbeats.get(t.leaseRunId) : undefined;
        const live = t.leaseRunId ? i.live.get(t.leaseRunId) : undefined;
        return {
          taskId: t.id,
          displayNo: t.displayNo,
          kind: t.kind,
          runId: t.leaseRunId,
          startedAt: run?.startedAt ?? t.startedAt,
          heartbeatAt: run?.heartbeatAt ?? null,
          leaseExpiresAt: t.leaseExpiresAt,
          attempt: t.attemptCount + 1,
          maxAttempts: t.maxAttempts,
          model: live?.model ?? null,
          inputTokens: live?.inputTokens ?? 0,
          outputTokens: live?.outputTokens ?? 0,
          costMicros: live?.costMicros ?? 0,
        };
      });
    const blocked = mine
      .filter((t) => t.status === "blocked")
      // human waits first: they are what the author can act on
      .sort((a, b) => Number(isHumanBlock(b.blockReason)) - Number(isHumanBlock(a.blockReason)))
      .slice(0, 5)
      .map((t) => ({ taskId: t.id, displayNo: t.displayNo, kind: t.kind, blockReason: t.blockReason, blockedRefType: t.blockedRefType, blockedRefId: t.blockedRefId }));
    const err = lastError.get(role);
    const recent = !!err && i.now.getTime() - err.updatedAt.getTime() <= AGENT_RECENT_ERROR_MS;
    const awaitingHuman = humanByRole.get(role) ?? 0;
    const u = usage.get(role);
    return {
      role,
      state: roleState(counts, awaitingHuman, recent),
      counts,
      awaitingHuman,
      current,
      blocked,
      lastError: err
        ? { taskId: err.id, displayNo: err.displayNo, kind: err.kind, errorFamily: err.errorFamily, errorMessage: err.errorMessage, at: err.updatedAt, recent }
        : null,
      boundModelId: i.bindings.get(role) ?? null,
      // finished usage is copied to runs.* at finish (counted by finish time); add what running runs have recorded so far
      today: {
        runs: u?.runs ?? 0,
        inputTokens: (u?.inputTokens ?? 0) + current.reduce((a, c) => a + c.inputTokens, 0),
        outputTokens: (u?.outputTokens ?? 0) + current.reduce((a, c) => a + c.outputTokens, 0),
        costMicros: (u?.costMicros ?? 0) + current.reduce((a, c) => a + c.costMicros, 0),
      },
      lastActiveAt: u?.lastActiveAt ?? null,
    };
  });

  return {
    now: i.now,
    todayStart: i.todayStart,
    timezone: i.timezone,
    paused: i.paused,
    roles,
    stages: [...byStage.entries()].map(([stage, s]) => ({ stage, ...s })),
    other,
    gates: AGENT_PIPELINE_GATES.map((gate) => ({ gate, afterStage: AGENT_GATE_AFTER_STAGE[gate], blockedTasks: gates.get(gate)! })),
  };
}

export interface TimelineInput {
  now: Date;
  since: Date;
  timezone: string;
  /** runs overlapping the window (newest first), possibly one more than `runLimit` */
  runs: RunSpanRow[];
  runLimit: number;
  /** run id → live info (running runs only) */
  live: ReadonlyMap<string, LiveRunInfo>;
}

export function buildAgentsTimeline(i: TimelineInput) {
  const truncated = i.runs.length > i.runLimit;
  const runs = (truncated ? i.runs.slice(0, i.runLimit) : i.runs).map(({ modelsUsed, ...r }) => {
    const live = i.live.get(r.id);
    return {
      ...r,
      inputTokens: live ? live.inputTokens : r.inputTokens,
      outputTokens: live ? live.outputTokens : r.outputTokens,
      costMicros: live ? live.costMicros : r.costMicros,
      models: live?.model ? [live.model.modelId] : modelLabels(modelsUsed),
      repairRounds: r.repairRounds ?? 0,
    };
  });
  return { now: i.now, since: i.since, timezone: i.timezone, runs, runsTruncated: truncated };
}
