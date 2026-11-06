/**
 * Pure view-model helpers for 에이전트 현황 (no React): labels, tones, elapsed/heartbeat formatting,
 * pipeline flow nodes and the swimlane timeline layout. Covered by model.test.ts.
 */
import {
  AGENT_GATE_APPROVAL_TYPES,
  AGENT_PIPELINE_GATES,
  labelKo,
  type AgentGateOverviewDto,
  type AgentPipelineGate,
  type AgentPipelineStage,
  type AgentRole,
  type AgentRoleOverviewDto,
  type AgentRoleState,
  type AgentRunSpanDto,
  type AgentStageOverviewDto,
  type AgentStatusCounts,
  type ApprovalType,
  type RunStatus,
} from "@ncs/shared";
import type { Tone } from "../../components/ui/tone.js";

export const ROLE_STATE_LABEL: Record<AgentRoleState, string> = {
  running: "실행 중",
  error: "실패",
  blocked: "막힘",
  awaiting_human: "사람 대기",
  waiting: "대기",
  idle: "쉬는 중",
};
export const ROLE_STATE_TONE: Record<AgentRoleState, Tone> = {
  running: "info",
  error: "danger",
  blocked: "warn",
  awaiting_human: "violet",
  waiting: "accent",
  idle: "neutral",
};

export const STAGE_LABEL: Record<AgentPipelineStage, string> = {
  concept: "컨셉",
  world: "세계관",
  cast: "캐릭터",
  structure: "구성",
  plot: "플롯",
  outline: "화 개요",
  draft: "초고",
  polish: "교정",
  check: "점검",
};
export const GATE_LABEL: Record<AgentPipelineGate, string> = {
  concept: "컨셉 승인",
  structure: "구성 승인",
  plot: "플롯 승인",
  episode: "화 승인",
};

/** Run bar colour (status palette from the theme tokens; the label/legend carries the meaning too). */
export const RUN_STATUS_TONE: Record<RunStatus, Tone> = {
  queued: "neutral",
  running: "info",
  succeeded: "ok",
  failed: "danger",
  cancelled: "neutral",
  interrupted: "warn",
};
export const RUN_STATUS_VAR: Record<Tone, string> = {
  neutral: "var(--faint)",
  ok: "var(--ok)",
  warn: "var(--warn)",
  danger: "var(--danger)",
  info: "var(--info)",
  accent: "var(--accent)",
  violet: "var(--violet)",
};

export function roleLabel(role: AgentRole): string {
  return labelKo("agent_role", role);
}

/**
 * Server clock offset to use for the ticking clock: keep the previous value unless the new estimate moved by
 * more than `toleranceMs`, so each poll does not restart the 1s timer (network jitter ≈ tens of ms).
 */
export function stableOffset(prev: number | null, next: number, toleranceMs = 1000): number {
  if (prev === null || Math.abs(next - prev) > toleranceMs) return Math.round(next);
  return prev;
}

/** "마지막 신호 12초 전" text for a heartbeat age. */
export function formatSignalAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}초 전` : `${Math.round(s / 60)}분 전`;
}

/** "42초" · "4분 12초" · "1시간 5분" */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 ${String(s % 60).padStart(2, "0")}초`;
  const h = Math.floor(m / 60);
  return `${h}시간 ${m % 60}분`;
}

export type HeartbeatHealth = "ok" | "late" | "stale" | "none";

/** stale = lease expired (reclaim will interrupt it); late = no heartbeat for > 60s */
export function heartbeatHealth(heartbeatAt: string | null, leaseExpiresAt: string | null, now: number): HeartbeatHealth {
  if (leaseExpiresAt && new Date(leaseExpiresAt).getTime() < now) return "stale";
  if (!heartbeatAt) return "none";
  return now - new Date(heartbeatAt).getTime() > 60_000 ? "late" : "ok";
}

/** compact token count: 950 → "950", 12_300 → "1.2만" */
export function formatTokens(n: number): string {
  if (n < 10_000) return n.toLocaleString("ko-KR");
  return `${(n / 10_000).toFixed(n < 100_000 ? 1 : 0)}만`;
}

// ── pipeline flow ──────────────────────────────────────────────────────────
export type FlowNode =
  | { type: "stage"; id: AgentPipelineStage; label: string; stage: AgentStageOverviewDto; active: boolean; total: number; human: number }
  /** pending = approvals awaiting a decision (approvals table); blockedTasks = tasks held behind the gate */
  | { type: "gate"; id: AgentPipelineGate; label: string; pending: number; blockedTasks: number };

const GATE_OF_APPROVAL = new Map<ApprovalType, AgentPipelineGate>(
  AGENT_PIPELINE_GATES.flatMap((g) => AGENT_GATE_APPROVAL_TYPES[g].map((t) => [t, g] as const)),
);

/** Pending approvals per pipeline gate (other approval types — canon change, budget… — are not gates). */
export function gateApprovalCounts(approvals: ReadonlyArray<{ approvalType: ApprovalType; status?: string }>): Record<AgentPipelineGate, number> {
  const out = Object.fromEntries(AGENT_PIPELINE_GATES.map((g) => [g, 0])) as Record<AgentPipelineGate, number>;
  for (const a of approvals) {
    if (a.status && a.status !== "pending") continue;
    const g = GATE_OF_APPROVAL.get(a.approvalType);
    if (g) out[g] += 1;
  }
  return out;
}

export const totalOf = (c: AgentStatusCounts): number => c.pending + c.ready + c.running + c.blocked + c.failed + c.done;

/** Stages in order with each gate inserted after the stage it follows. */
export function flowNodes(stages: AgentStageOverviewDto[], gates: AgentGateOverviewDto[], approvals?: Partial<Record<AgentPipelineGate, number>>): FlowNode[] {
  const out: FlowNode[] = [];
  for (const s of stages) {
    const c = s.counts;
    out.push({ type: "stage", id: s.stage, label: STAGE_LABEL[s.stage], stage: s, active: c.running > 0, total: totalOf(c), human: s.awaitingApproval + s.awaitingQuestion });
    for (const g of gates)
      if (g.afterStage === s.stage) out.push({ type: "gate", id: g.gate, label: GATE_LABEL[g.gate], pending: approvals?.[g.gate] ?? 0, blockedTasks: g.blockedTasks });
  }
  return out;
}

/** Edge i connects node i → i+1; it moves when work is flowing into or out of the target. */
export function flowEdges(nodes: FlowNode[]): Array<{ from: number; to: number; state: "moving" | "waiting" | "idle" }> {
  const edges: Array<{ from: number; to: number; state: "moving" | "waiting" | "idle" }> = [];
  for (let i = 0; i + 1 < nodes.length; i++) {
    const to = nodes[i + 1]!;
    const from = nodes[i]!;
    let state: "moving" | "waiting" | "idle" = "idle";
    if (to.type === "gate" && to.pending > 0) state = "waiting";
    else if (from.type === "gate" && from.pending > 0) state = "waiting";
    else if (to.type === "stage" && (to.active || to.stage.counts.ready > 0)) state = "moving";
    edges.push({ from: i, to: i + 1, state });
  }
  return edges;
}

function describeCounts(c: AgentStatusCounts, human: number): string[] {
  const parts: string[] = [];
  if (c.running) parts.push(`실행 중 ${c.running}`);
  if (c.ready + c.pending) parts.push(`대기 ${c.ready + c.pending}`);
  if (human) parts.push(`사람 대기 ${human}`);
  if (c.blocked - human > 0) parts.push(`막힘 ${c.blocked - human}`);
  if (c.failed) parts.push(`실패 ${c.failed}`);
  if (c.done) parts.push(`완료 ${c.done}`);
  return parts;
}

/** Text equivalent of the flow diagram (screen readers, reduced visuals). */
export function describeStage(n: Extract<FlowNode, { type: "stage" }>): string {
  const parts = describeCounts(n.stage.counts, n.human);
  return `${n.label}: ${parts.length ? parts.join(", ") : "작업 없음"}`;
}

export function describeGate(n: Extract<FlowNode, { type: "gate" }>): string {
  const held = n.blockedTasks ? `, 이 승인을 기다리는 작업 ${n.blockedTasks}개` : "";
  return `사람 승인 단계 ${n.label}: ${n.pending ? `승인 대기 ${n.pending}건` : "승인 대기 없음"}${held}`;
}

/** Tasks outside the pipeline (answer handling, visual production…). */
export function describeOther(c: AgentStatusCounts): string {
  const parts = describeCounts(c, 0);
  return `그 밖의 작업(답변 처리·비주얼 등): ${parts.length ? parts.join(", ") : "작업 없음"}`;
}

// ── roster summary ─────────────────────────────────────────────────────────
export function rosterSummary(roles: AgentRoleOverviewDto[]) {
  return {
    running: roles.reduce((a, r) => a + r.current.length, 0),
    awaitingHuman: roles.reduce((a, r) => a + r.awaitingHuman, 0),
    blocked: roles.reduce((a, r) => a + r.counts.blocked - r.awaitingHuman, 0),
    failed: roles.reduce((a, r) => a + r.counts.failed, 0),
    waiting: roles.reduce((a, r) => a + r.counts.pending + r.counts.ready, 0),
    todayCostMicros: roles.reduce((a, r) => a + r.today.costMicros, 0),
    todayTokens: roles.reduce((a, r) => a + r.today.inputTokens + r.today.outputTokens, 0),
  };
}

// ── timeline layout ────────────────────────────────────────────────────────
export interface TimelineBar {
  run: AgentRunSpanDto;
  x: number;
  w: number;
  /** sub-row inside the lane (overlapping runs stack) */
  row: number;
  start: number;
  end: number;
  live: boolean;
}
export interface TimelineLane {
  role: AgentRole;
  label: string;
  y: number;
  rows: number;
  height: number;
  bars: TimelineBar[];
}
export interface TimelineLayout {
  width: number;
  height: number;
  gutter: number;
  lanes: TimelineLane[];
  ticks: Array<{ x: number; t: number }>;
  nowX: number;
}

export const LANE_ROW_H = 18;
export const LANE_PAD = 8;
const MIN_BAR_W = 3;

/** Visible interval of a run: start → finish (running = now; ended without finish = last heartbeat). */
export function runInterval(r: AgentRunSpanDto, now: number): { start: number; end: number; live: boolean } {
  const start = new Date(r.startedAt ?? r.createdAt).getTime();
  const live = r.finishedAt === null && (r.status === "running" || r.status === "queued");
  const endIso = r.finishedAt ?? (live ? null : (r.heartbeatAt ?? r.startedAt ?? r.createdAt));
  const end = endIso ? new Date(endIso).getTime() : now;
  return { start, end: Math.max(end, start), live };
}

function tickStep(spanMs: number): number {
  const h = spanMs / 3_600_000;
  if (h <= 1.5) return 10 * 60_000;
  if (h <= 3) return 30 * 60_000;
  if (h <= 8) return 3_600_000;
  if (h <= 24) return 3 * 3_600_000;
  return 6 * 3_600_000;
}

/**
 * Swimlanes per role (roster order; roles without runs in the window are omitted), greedy row packing
 * so overlapping runs of one role never cover each other.
 */
export function layoutTimeline(
  runs: AgentRunSpanDto[],
  o: { since: number; now: number; width: number; gutter: number; order: readonly AgentRole[] },
): TimelineLayout {
  const span = Math.max(1, o.now - o.since);
  const plot = Math.max(1, o.width - o.gutter);
  const xOf = (t: number) => o.gutter + ((Math.min(Math.max(t, o.since), o.now) - o.since) / span) * plot;

  const byRole = new Map<AgentRole, AgentRunSpanDto[]>();
  for (const r of runs) byRole.set(r.role, [...(byRole.get(r.role) ?? []), r]);

  const lanes: TimelineLane[] = [];
  let y = 0;
  for (const role of o.order) {
    const list = byRole.get(role);
    if (!list?.length) continue;
    const items = list
      .map((run) => ({ run, ...runInterval(run, o.now) }))
      .filter((i) => i.end >= o.since)
      .sort((a, b) => a.start - b.start || a.run.id.localeCompare(b.run.id));
    if (!items.length) continue;
    const rowEnds: number[] = [];
    const bars: TimelineBar[] = items.map((i) => {
      const x = xOf(i.start);
      const w = Math.max(MIN_BAR_W, xOf(i.end) - x);
      let row = rowEnds.findIndex((end) => end + 2 <= x);
      if (row === -1) {
        row = rowEnds.length;
        rowEnds.push(x + w);
      } else rowEnds[row] = x + w;
      return { run: i.run, x, w, row, start: i.start, end: i.end, live: i.live };
    });
    const rows = Math.max(1, rowEnds.length);
    const height = rows * LANE_ROW_H + LANE_PAD * 2;
    lanes.push({ role, label: roleLabel(role), y, rows, height, bars });
    y += height;
  }

  const step = tickStep(span);
  const ticks: Array<{ x: number; t: number }> = [];
  for (let t = Math.ceil(o.since / step) * step; t <= o.now; t += step) ticks.push({ x: xOf(t), t });

  return { width: o.width, height: y, gutter: o.gutter, lanes, ticks, nowX: xOf(o.now) };
}

/**
 * Attempt text of a run. Runs carry no attempt number, only the task's current count, which moves when a
 * run ends: a live run is attempt count+1 (same as the roster card); a finished one shows the task's count.
 */
export function runAttempt(r: Pick<AgentRunSpanDto, "taskAttemptCount" | "maxAttempts">, live: boolean): { label: string; value: string } {
  return live ? { label: "시도", value: `${r.taskAttemptCount + 1}/${r.maxAttempts}` } : { label: "작업 시도", value: `현재 ${r.taskAttemptCount}/${r.maxAttempts}` };
}

/** One-line text for a run (tooltip / table / aria-label). */
export function describeRun(r: AgentRunSpanDto, now: number): string {
  const { start, end, live } = runInterval(r, now);
  const status = labelKo("run_status", r.status);
  const err = r.errorFamily ? ` · ${labelKo("error_family", r.errorFamily)}` : "";
  return `T-${r.taskDisplayNo} ${labelKo("task_kind", r.kind)} · ${status}${err} · ${live ? "경과 " : ""}${formatElapsed(end - start)}`;
}
