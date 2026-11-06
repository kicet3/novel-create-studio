import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentsOverviewSchema, agentsTimelineSchema, type AgentsOverviewDto, type AgentsTimelineDto } from "@ncs/shared";
import { FakeClock } from "@ncs/test-kit";
import { actors } from "../../src/platform/index.js";
import { TaskFailure } from "../../src/modules/orchestration/index.js";
import { gateForApprovalBlock, roleState, startOfLocalDay } from "../../src/modules/orchestration/domain/agents-overview.js";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { deferred, handler, makeEngine, novelWithGoal } from "./support.js";

let t: TestCore;
let clock: FakeClock;
beforeEach(async () => {
  clock = new FakeClock("2026-11-05T03:00:00.000Z"); // 12:00 Asia/Seoul
  t = await createTestCore({ clock });
});
afterEach(() => t.close());

const sys = actors.system("scheduler");
const sig = () => new AbortController().signal;

async function overview(novelId: string): Promise<AgentsOverviewDto> {
  const r = await t.http("GET", `/api/novels/${novelId}/agents/overview`);
  expect(r.status).toBe(200);
  return agentsOverviewSchema.parse(r.body);
}
async function timeline(novelId: string, hours?: number): Promise<AgentsTimelineDto> {
  const r = await t.http("GET", `/api/novels/${novelId}/agents/timeline${hours ? `?hours=${hours}` : ""}`);
  expect(r.status).toBe(200);
  return agentsTimelineSchema.parse(r.body);
}

describe("GET …/agents/overview", () => {
  it("aggregates roster state, stage counts, approval gates and the run timeline", async () => {
    const e = makeEngine(t);
    const hold = deferred();
    e.registerTaskKind(handler("revise_episode", "writer", { gate: async () => ({ ok: false, blockReason: "approval", blockedRef: { refType: "approval", refId: "apr_X" } }) }));
    e.registerTaskKind(
      handler("dedupe_entities", "world_keeper", {
        async execute() {
          throw new TaskFailure("invalid_output", "형식이 맞지 않습니다", false);
        },
      }),
    );
    e.registerTaskKind(handler("check_continuity", "continuity_editor"));
    e.registerTaskKind(handler("polish_episode", "line_editor", { execute: () => hold.promise.then(() => ({})) }));

    const { scope, novel } = await novelWithGoal(t);
    const mk = (kind: "revise_episode" | "dedupe_entities" | "check_continuity", targetId: string) =>
      t.platform.uow.run((tx) =>
        e.createTask(tx, scope, { kind, targetType: kind === "dedupe_entities" ? "novel" : "episode", targetId, input: { secretNote: "SENTINEL-INPUT" }, createdBy: sys }),
      );
    await mk("revise_episode", "epi_a");
    await mk("dedupe_entities", novel.id);
    await mk("check_continuity", "epi_b");
    // three tasks settle: blocked (gate), failed (non-retryable), done
    await e.runOnce();
    clock.advance(1_000);
    await e.runOnce();

    // polish_episode stays running (execute awaits `hold`)
    await t.platform.uow.run((tx) => e.createTask(tx, scope, { kind: "polish_episode", targetType: "episode", targetId: "epi_c", input: {}, createdBy: sys }));
    expect(await e.tick(sig(), { ignoreCoalesceWindow: true })).toBe(1);
    clock.advance(30_000);

    const raw = await t.http("GET", `/api/novels/${novel.id}/agents/overview`);
    expect(JSON.stringify(raw.body)).not.toContain("SENTINEL-INPUT");
    const rawTl = await t.http("GET", `/api/novels/${novel.id}/agents/timeline`);
    expect(JSON.stringify(rawTl.body)).not.toContain("SENTINEL-INPUT");
    // run error messages are read from the run detail, not the polled timeline
    expect(JSON.stringify(rawTl.body)).not.toContain("형식이 맞지 않습니다");
    const o = await overview(novel.id);
    const tl = await timeline(novel.id);

    expect(o.timezone).toBe("Asia/Seoul");
    expect(o.todayStart).toBe("2026-11-04T15:00:00.000Z");
    expect(o.roles.map((r) => r.role).slice(0, 4)).toEqual(["showrunner", "planner", "scene_director", "writer"]);
    const role = (r: string) => o.roles.find((x) => x.role === r)!;

    expect(role("line_editor").state).toBe("running");
    expect(role("line_editor").current).toHaveLength(1);
    expect(role("line_editor").current[0]).toMatchObject({ kind: "polish_episode", attempt: 1 });
    expect(role("line_editor").current[0]!.startedAt).not.toBeNull();

    // an approval wait is the normal human loop, not a fault
    expect(role("writer").state).toBe("awaiting_human");
    expect(role("writer").awaitingHuman).toBe(1);
    expect(role("writer").blocked[0]).toMatchObject({ kind: "revise_episode", blockReason: "approval", blockedRefType: "approval" });

    expect(role("world_keeper").state).toBe("error");
    expect(role("world_keeper").lastError).toMatchObject({ kind: "dedupe_entities", errorFamily: "invalid_output", recent: true });

    expect(role("continuity_editor").state).toBe("idle");
    expect(role("continuity_editor").today.runs).toBe(1);
    expect(role("planner").state).toBe("idle");

    const stage = (s: string) => o.stages.find((x) => x.stage === s)!;
    expect(o.stages.map((s) => s.stage)).toEqual(["concept", "world", "cast", "structure", "plot", "outline", "draft", "polish", "check"]);
    expect(stage("draft").counts.blocked).toBe(1);
    expect(stage("draft").awaitingApproval).toBe(1);
    expect(stage("world").counts.failed).toBe(1);
    expect(stage("check").counts.done).toBe(1);
    expect(stage("polish").counts.running).toBe(1);
    expect(o.gates.find((g) => g.gate === "plot")!.blockedTasks).toBe(1);
    expect(o.gates.find((g) => g.gate === "episode")!.blockedTasks).toBe(0);

    // timeline: failed + succeeded + running runs (the gated task never leased)
    expect(tl.runs.map((r) => r.status).sort()).toEqual(["failed", "running", "succeeded"]);
    const running = tl.runs.find((r) => r.status === "running")!;
    expect(running).toMatchObject({ kind: "polish_episode", role: "line_editor", finishedAt: null });
    expect(tl.runs.find((r) => r.status === "failed")).toMatchObject({ errorFamily: "invalid_output", kind: "dedupe_entities" });
    expect(tl.runsTruncated).toBe(false);

    // window: 2h later the finished runs drop out of a 1h window, the running run stays
    clock.advance(2 * 3_600_000);
    const later = await timeline(novel.id, 1);
    expect(later.runs.map((r) => r.status)).toEqual(["running"]);
    // a running run older than the created_at bound is still read (runs_running_idx path)
    clock.advance(13 * 3_600_000);
    expect((await timeline(novel.id, 1)).runs.map((r) => r.kind)).toEqual(["polish_episode"]);

    // a day later the old failure no longer paints the card red; it stays in the counts
    clock.advance(10 * 3_600_000);
    const dayLater = await overview(novel.id);
    const wk = dayLater.roles.find((x) => x.role === "world_keeper")!;
    expect(wk.state).toBe("idle");
    expect(wk.counts.failed).toBe(1);
    expect(wk.lastError).toMatchObject({ recent: false });

    hold.resolve();
    await e.runOnce();
  });

  it("validates hours and hides other / unknown novels", async () => {
    const { novel } = await novelWithGoal(t);
    expect((await t.http("GET", `/api/novels/${novel.id}/agents/timeline?hours=0`)).status).toBe(400);
    expect((await t.http("GET", `/api/novels/${novel.id}/agents/timeline?hours=99`)).status).toBe(400);
    expect((await t.http("GET", `/api/novels/nov_01JABCDEFGHJKMNPQRSTVWXYZ0/agents/overview`)).status).toBe(404);
    expect((await t.http("GET", `/api/novels/nov_01JABCDEFGHJKMNPQRSTVWXYZ0/agents/timeline`)).status).toBe(404);
    const empty = await overview(novel.id);
    expect(empty.roles.every((r) => r.state === "idle")).toBe(true);
    expect((await timeline(novel.id)).runs).toEqual([]);
    expect(empty.gates.every((g) => g.blockedTasks === 0)).toBe(true);
  });
});

describe("agents overview domain", () => {
  it("maps approval blocks onto gates", () => {
    expect(gateForApprovalBlock("concept_turn", "approval")).toBe("concept");
    expect(gateForApprovalBlock("plan_series_bible", "approval")).toBe("structure");
    expect(gateForApprovalBlock("plan_arc", "novel")).toBe("structure");
    expect(gateForApprovalBlock("plan_arc", "approval")).toBe("plot");
    expect(gateForApprovalBlock("outline_episode", "approval")).toBe("plot");
    expect(gateForApprovalBlock("polish_episode", "approval")).toBe("episode");
    expect(gateForApprovalBlock("interpret_answer", "approval")).toBeNull();
  });
  it("derives role state by precedence", () => {
    const c = { pending: 0, ready: 0, running: 0, blocked: 0, failed: 0, done: 3 };
    expect(roleState(c)).toBe("idle");
    expect(roleState({ ...c, ready: 1 })).toBe("waiting");
    expect(roleState({ ...c, ready: 1, blocked: 1 })).toBe("blocked");
    expect(roleState({ ...c, ready: 1, blocked: 1 }, 1)).toBe("awaiting_human");
    expect(roleState({ ...c, blocked: 2 }, 1)).toBe("blocked");
    expect(roleState({ ...c, blocked: 1, failed: 1 }, 0, true)).toBe("error");
    expect(roleState({ ...c, ready: 1, failed: 1 }, 0, false)).toBe("waiting");
    expect(roleState({ ...c, failed: 1, running: 1 }, 0, true)).toBe("running");
  });
  it("computes local midnight", () => {
    expect(startOfLocalDay(new Date("2026-11-05T14:59:00Z"), "Asia/Seoul").toISOString()).toBe("2026-11-04T15:00:00.000Z");
    expect(startOfLocalDay(new Date("2026-11-05T15:00:00Z"), "Asia/Seoul").toISOString()).toBe("2026-11-05T15:00:00.000Z");
    expect(startOfLocalDay(new Date("2026-11-05T03:00:00Z"), "UTC").toISOString()).toBe("2026-11-05T00:00:00.000Z");
  });
});
