import { describe, expect, it } from "vitest";
import { AGENT_PIPELINE_STAGES, type AgentGateOverviewDto, type AgentRunSpanDto, type AgentStageOverviewDto } from "@ncs/shared";
import {
  describeGate,
  describeOther,
  describeStage,
  flowEdges,
  flowNodes,
  formatElapsed,
  gateApprovalCounts,
  heartbeatHealth,
  layoutTimeline,
  rosterSummary,
  runAttempt,
  runInterval,
  stableOffset,
} from "./model.js";

const T0 = Date.parse("2026-11-05T00:00:00Z");
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

const run = (over: Partial<AgentRunSpanDto>): AgentRunSpanDto => ({
  id: "run_1",
  taskId: "tsk_1",
  taskDisplayNo: 1,
  kind: "draft_episode",
  role: "writer",
  status: "succeeded",
  stopReason: "completed",
  errorFamily: null,
  createdAt: iso(T0),
  startedAt: iso(T0),
  heartbeatAt: null,
  finishedAt: iso(T0 + H),
  taskAttemptCount: 1,
  maxAttempts: 3,
  inputTokens: 0,
  outputTokens: 0,
  costMicros: 0,
  models: [],
  ...over,
});

const zero = { pending: 0, ready: 0, running: 0, blocked: 0, failed: 0, done: 0 };
const stages = (over: Partial<Record<string, Partial<typeof zero>>> = {}): AgentStageOverviewDto[] =>
  AGENT_PIPELINE_STAGES.map((stage) => ({ stage, counts: { ...zero, ...over[stage] }, awaitingQuestion: 0, awaitingApproval: 0 }));
const gates = (held: Partial<Record<string, number>> = {}): AgentGateOverviewDto[] => [
  { gate: "concept", afterStage: "concept", blockedTasks: held.concept ?? 0 },
  { gate: "structure", afterStage: "structure", blockedTasks: held.structure ?? 0 },
  { gate: "plot", afterStage: "plot", blockedTasks: held.plot ?? 0 },
  { gate: "episode", afterStage: "check", blockedTasks: held.episode ?? 0 },
];

describe("formatElapsed", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatElapsed(42_000)).toBe("42초");
    expect(formatElapsed(4 * 60_000 + 5_000)).toBe("4분 05초");
    expect(formatElapsed(65 * 60_000)).toBe("1시간 5분");
    expect(formatElapsed(-5)).toBe("0초");
  });
});

describe("heartbeatHealth", () => {
  it("flags late heartbeats and expired leases", () => {
    expect(heartbeatHealth(iso(T0 - 10_000), iso(T0 + 60_000), T0)).toBe("ok");
    expect(heartbeatHealth(iso(T0 - 90_000), iso(T0 + 60_000), T0)).toBe("late");
    expect(heartbeatHealth(iso(T0 - 10_000), iso(T0 - 1), T0)).toBe("stale");
    expect(heartbeatHealth(null, null, T0)).toBe("none");
  });
});

describe("flow", () => {
  it("inserts each gate after its stage", () => {
    const ids = flowNodes(stages(), gates()).map((n) => `${n.type}:${n.id}`);
    expect(ids).toEqual([
      "stage:concept",
      "gate:concept",
      "stage:world",
      "stage:cast",
      "stage:structure",
      "gate:structure",
      "stage:plot",
      "gate:plot",
      "stage:outline",
      "stage:draft",
      "stage:polish",
      "stage:check",
      "gate:episode",
    ]);
  });
  it("animates edges into running stages and marks pending gates as waiting", () => {
    const nodes = flowNodes(stages({ draft: { running: 1 } }), gates(), { plot: 1 });
    const edges = flowEdges(nodes);
    const edgeInto = (id: string) => edges.find((e) => nodes[e.to]!.id === id && nodes[e.to]!.type === "stage")!;
    expect(edgeInto("draft").state).toBe("moving");
    expect(edges.find((e) => nodes[e.to]!.type === "gate" && nodes[e.to]!.id === "plot")!.state).toBe("waiting");
    expect(edgeInto("outline").state).toBe("waiting"); // leaving a pending gate
    expect(edgeInto("polish").state).toBe("idle");
  });
  it("describes a stage in words", () => {
    const n = flowNodes(stages({ draft: { running: 1, ready: 2, done: 3 } }), []).find((x) => x.id === "draft")!;
    expect(n.type === "stage" && describeStage(n)).toBe("초고: 실행 중 1, 대기 2, 완료 3");
  });
  it("splits human waits from other blocks", () => {
    const st = stages({ plot: { blocked: 3 } }).map((s) => (s.stage === "plot" ? { ...s, awaitingApproval: 1, awaitingQuestion: 1 } : s));
    const n = flowNodes(st, []).find((x) => x.id === "plot")!;
    expect(n.type === "stage" && describeStage(n)).toBe("플롯: 사람 대기 2, 막힘 1");
  });
  it("counts gates from pending approvals, not from the tasks held behind them", () => {
    const counts = gateApprovalCounts([
      { approvalType: "episode" },
      { approvalType: "episode" },
      { approvalType: "story_structure" },
      { approvalType: "series_bible" },
      { approvalType: "arc_plan" },
      { approvalType: "canon_change" },
      { approvalType: "concept_brief", status: "approved" },
    ]);
    expect(counts).toEqual({ concept: 0, structure: 2, plot: 1, episode: 2 });
    // one approval with five tasks behind it reads as one pending approval
    const nodes = flowNodes(stages(), gates({ plot: 5 }), { plot: 1 });
    const plot = nodes.find((n) => n.type === "gate" && n.id === "plot")!;
    expect(plot).toMatchObject({ pending: 1, blockedTasks: 5 });
    expect(plot.type === "gate" && describeGate(plot)).toBe("사람 승인 단계 플롯 승인: 승인 대기 1건, 이 승인을 기다리는 작업 5개");
    // an approval with no task behind it yet still shows as pending
    const concept = flowNodes(stages(), gates(), { concept: 1 }).find((n) => n.type === "gate" && n.id === "concept")!;
    expect(concept).toMatchObject({ pending: 1, blockedTasks: 0 });
  });
  it("describes work outside the pipeline", () => {
    expect(describeOther({ ...zero, running: 1, done: 2 })).toBe("그 밖의 작업(답변 처리·비주얼 등): 실행 중 1, 완료 2");
  });
});

describe("roster summary", () => {
  it("counts human waits apart from blocks", () => {
    const role = { counts: { ...zero, blocked: 3, failed: 1 }, awaitingHuman: 2, current: [], today: { runs: 0, inputTokens: 0, outputTokens: 0, costMicros: 0 } };
    expect(rosterSummary([role as never])).toMatchObject({ awaitingHuman: 2, blocked: 1, failed: 1 });
  });
});

describe("attempts and clock", () => {
  it("labels a live run like the roster card and a finished run as the task's count", () => {
    expect(runAttempt({ taskAttemptCount: 0, maxAttempts: 3 }, true)).toEqual({ label: "시도", value: "1/3" });
    expect(runAttempt({ taskAttemptCount: 3, maxAttempts: 3 }, false)).toEqual({ label: "작업 시도", value: "현재 3/3" });
  });
  it("keeps the clock offset unless it moved by more than a second", () => {
    expect(stableOffset(null, 120.4)).toBe(120);
    expect(stableOffset(120, 480)).toBe(120);
    expect(stableOffset(120, 1500)).toBe(1500);
  });
});

describe("timeline layout", () => {
  it("uses now for running runs and last heartbeat for unfinished dead runs", () => {
    expect(runInterval(run({ status: "running", finishedAt: null }), T0 + 2 * H)).toMatchObject({ end: T0 + 2 * H, live: true });
    expect(runInterval(run({ status: "interrupted", finishedAt: null, heartbeatAt: iso(T0 + 600_000) }), T0 + 2 * H)).toMatchObject({ end: T0 + 600_000, live: false });
  });

  it("orders lanes by roster, skips idle roles, stacks overlapping runs and clamps to the window", () => {
    const runs = [
      run({ id: "a", role: "writer", startedAt: iso(T0 + H), finishedAt: iso(T0 + 3 * H) }),
      run({ id: "b", role: "writer", startedAt: iso(T0 + 2 * H), finishedAt: iso(T0 + 2.5 * H) }),
      run({ id: "c", role: "writer", startedAt: iso(T0 + 3.5 * H), finishedAt: iso(T0 + 3.6 * H) }),
      run({ id: "d", role: "planner", startedAt: iso(T0 - H), finishedAt: iso(T0 + 0.5 * H) }),
    ];
    const l = layoutTimeline(runs, { since: T0, now: T0 + 4 * H, width: 400, gutter: 0, order: ["showrunner", "planner", "writer"] });
    expect(l.lanes.map((x) => x.role)).toEqual(["planner", "writer"]);
    const writer = l.lanes[1]!;
    expect(writer.rows).toBe(2);
    expect(Object.fromEntries(writer.bars.map((b) => [b.run.id, b.row]))).toEqual({ a: 0, b: 1, c: 0 });
    expect(writer.bars.find((b) => b.run.id === "a")).toMatchObject({ x: 100, w: 200 });
    // planner run started before the window: clamped to x=0
    expect(l.lanes[0]!.bars[0]).toMatchObject({ x: 0, w: 50 });
    expect(writer.y).toBe(l.lanes[0]!.height);
    expect(l.nowX).toBe(400);
    expect(l.ticks.map((t) => t.x)).toEqual([0, 100, 200, 300, 400]);
  });

  it("gives tiny runs a minimum width and drops runs that ended before the window", () => {
    const l = layoutTimeline(
      [run({ id: "tiny", startedAt: iso(T0 + H), finishedAt: iso(T0 + H + 1000) }), run({ id: "old", startedAt: iso(T0 - 3 * H), finishedAt: iso(T0 - 2 * H) })],
      { since: T0, now: T0 + 4 * H, width: 400, gutter: 0, order: ["writer"] },
    );
    expect(l.lanes[0]!.bars.map((b) => b.run.id)).toEqual(["tiny"]);
    expect(l.lanes[0]!.bars[0]!.w).toBe(3);
  });
});
