/**
 * Runs cut off by a server stop / crash / restart (02 §7.3, 04 §11): the run ends as interrupted (R7), the task is
 * re-queued (T10 + reclaim wake) WITHOUT using an attempt, and the next process reruns it. A crash loop is capped by
 * `task.max_interruptions` (then T6 failed; [다시 시도] resets the count). Concept turns resume after a restart.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actors } from "../../src/platform/index.js";
import type { OrchestrationEngine } from "../../src/modules/orchestration/application/engine.js";
import { TaskFailure, type TaskKindHandler } from "../../src/modules/orchestration/index.js";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { conceptHarness, installConceptStubs, type Scripted } from "../concept/support.js";
import { deferred, handler, makeEngine, novelWithGoal } from "./support.js";

let t: TestCore;
let script: Scripted[];
beforeAll(async () => {
  t = await createTestCore();
  script = installConceptStubs(t).script;
}, 60_000);
afterAll(() => t.close());

const sys = actors.system("scheduler");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 5_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`condition not met in ${ms} ms: ${JSON.stringify(v)}`);
    await sleep(10);
  }
}

const makeTask = (e: OrchestrationEngine, scope: { novelId: string }) =>
  t.platform.uow.run((tx) => e.createTask(tx, scope, { kind: "revise_episode", targetType: "episode", targetId: `epi_${Math.random()}`, input: {}, createdBy: sys }));

const runsOf = (taskId: string) =>
  t.testDb.query<{ id: string; status: string; stop_reason: string | null; rerun_of_run_id: string | null }>(`SELECT id, status, stop_reason, rerun_of_run_id FROM runs WHERE task_id='${taskId}' ORDER BY created_at`);
const taskRow = async (taskId: string) =>
  (await t.testDb.query<{ status: string; attempt_count: number; input: Record<string, unknown>; lease_run_id: string | null }>(`SELECT status, attempt_count, input, lease_run_id FROM tasks WHERE id='${taskId}'`))[0]!;
const reclaimAudit = async (novelId: string, taskId: string) =>
  (await t.modules.audit.service.list({ novelId }, { targetIds: [taskId] })).items.filter((x) => x.action === "task.lease_reclaimed" || (x.action === "task.status_changed" && (x.details as any)?.cause));

/** "process 1": claims the task and runs `execute` until the test lets it go */
async function startRun(impl: Partial<TaskKindHandler<{ n?: number }>>, opts: { maxInterruptions?: number } = {}) {
  const { scope } = await novelWithGoal(t);
  const e = makeEngine(t, { renewIntervalMs: 60_000, ...opts });
  const started = deferred();
  const release = deferred();
  e.registerTaskKind(
    handler("revise_episode", "writer", {
      async execute(ctx) {
        started.resolve();
        await release.promise;
        return impl.execute ? impl.execute(ctx) : {};
      },
      ...(impl.commit ? { commit: impl.commit } : {}),
    }),
  );
  const { taskId } = await makeTask(e, scope);
  const outer = new AbortController();
  await e.tick(outer.signal, { ignoreCoalesceWindow: true });
  await started.promise;
  return { e, scope, taskId, outer, release };
}

describe("server stop mid-run", () => {
  it("graceful stop: interrupted (not cancelled), re-queued without an attempt, rerun by the next process", async () => {
    const { scope, taskId, outer, release } = await startRun({
      async execute(ctx) {
        await ctx.run.checkpoint(); // next safe point after the in-flight work
        return {};
      },
    });
    outer.abort(); // runtime.stop()
    release.resolve();
    const [run] = await until(() => runsOf(taskId), (r) => r[0]?.status !== "running");
    expect(run).toMatchObject({ status: "interrupted", stop_reason: "lease_lost" });
    const task = await taskRow(taskId);
    expect(task).toMatchObject({ status: "ready", attempt_count: 0, lease_run_id: null });
    expect(task.input.interrupted_runs).toBe(1);
    const audits = await reclaimAudit(scope.novelId, taskId);
    expect(audits.map((a) => (a.details as any).cause)).toEqual(["shutdown"]);
    expect(audits[0]!.reason).toContain("시도 횟수 미사용");
    const wakes = await t.testDb.query<{ reason: string; status: string }>(`SELECT reason, status FROM wake_requests WHERE task_id='${taskId}' AND reason='reclaim'`);
    expect(wakes).toEqual([{ reason: "reclaim", status: "pending" }]);

    // "process 2" boots and reruns it
    const e2 = makeEngine(t);
    let attempt = 0;
    e2.registerTaskKind(
      handler("revise_episode", "writer", {
        async execute(ctx) {
          attempt = ctx.run.attempt;
          return {};
        },
      }),
    );
    expect(await e2.reclaimOrphans({ startup: true })).toBe(0); // nothing left running
    expect(await e2.runOnce()).toBe(1);
    expect((await taskRow(taskId)).status).toBe("done");
    expect(attempt).toBe(1);
    const runs = await runsOf(taskId);
    expect(runs[1]).toMatchObject({ status: "succeeded", rerun_of_run_id: runs[0]!.id });
  });

  it("an error while stopping (aborted call, closing pool) is an interruption, not a failed attempt", async () => {
    const { taskId, outer, release } = await startRun({
      async execute() {
        throw new Error("Cannot use a pool after calling end on the pool");
      },
    });
    outer.abort();
    release.resolve();
    const [run] = await until(() => runsOf(taskId), (r) => r[0]?.status !== "running");
    expect(run).toMatchObject({ status: "interrupted", stop_reason: "lease_lost" });
    expect(await taskRow(taskId)).toMatchObject({ status: "ready", attempt_count: 0 });
  });

  it("a classified failure answered during the grace period still uses an attempt (not an interruption)", async () => {
    const { taskId, outer, release } = await startRun({
      async execute() {
        throw new TaskFailure("rate_limited", "provider said 429", true);
      },
    });
    outer.abort();
    release.resolve();
    const [run] = await until(() => runsOf(taskId), (r) => r[0]?.status !== "running");
    expect(run).toMatchObject({ status: "failed" });
    expect(await taskRow(taskId)).toMatchObject({ status: "ready", attempt_count: 1 });
  });

  it("hard deadline (abortAll): the aborted call's error re-queues the task without an attempt", async () => {
    const { e, taskId, release } = await startRun({
      async execute(ctx) {
        if (!ctx.run.signal.aborted) await new Promise((r) => ctx.run.signal.addEventListener("abort", r, { once: true }));
        const err = new Error("This operation was aborted");
        err.name = "AbortError";
        throw err;
      },
    });
    release.resolve();
    e.abortAll();
    const [run] = await until(() => runsOf(taskId), (r) => r[0]?.status !== "running");
    expect(run).toMatchObject({ status: "interrupted", stop_reason: "lease_lost" });
    expect(await taskRow(taskId)).toMatchObject({ status: "ready", attempt_count: 0 });
  });

  it("a proposal that finished during the grace period is still committed", async () => {
    const committed: string[] = [];
    const { taskId, outer, release } = await startRun({
      async commit(_tx, ctx) {
        committed.push(ctx.task.id); // (re-queued tasks of earlier tests may run on this engine too)
        return { kind: "done", outputRefs: [] };
      },
    });
    outer.abort();
    release.resolve();
    await until(() => taskRow(taskId), (x) => x.status === "done");
    expect(committed.filter((id) => id === taskId)).toHaveLength(1);
    expect((await runsOf(taskId))[0]).toMatchObject({ status: "succeeded" });
  });
});

describe("crash loop guard (task.max_interruptions)", () => {
  it("re-queues up to the cap without attempts, then fails; [다시 시도] resets the count", async () => {
    const { scope, taskId } = await startRun({}, { maxInterruptions: 2 }); // process 1 "dies" mid-run (never released)
    const boot = () => makeEngine(t, { maxInterruptions: 2, renewIntervalMs: 60_000 });
    for (let i = 1; i <= 3; i++) {
      expect(await boot().reclaimOrphans({ startup: true })).toBe(1);
      const task = await taskRow(taskId);
      if (i <= 2) {
        expect(task).toMatchObject({ status: "ready", attempt_count: 0 });
        expect(task.input.interrupted_runs).toBe(i);
        // next boot claims it and dies mid-run again
        const e = boot();
        const started = deferred();
        e.registerTaskKind(
          handler("revise_episode", "writer", {
            async execute() {
              started.resolve();
              await new Promise(() => {});
              return {};
            },
          }),
        );
        await e.tick(new AbortController().signal, { ignoreCoalesceWindow: true });
        await started.promise;
      } else {
        expect(task).toMatchObject({ status: "failed", attempt_count: 0 });
      }
    }
    const audits = await reclaimAudit(scope.novelId, taskId);
    audits.reverse(); // newest first
    expect(audits.map((a) => (a.details as any).interruptions)).toEqual([1, 2, 3]);
    expect(audits[2]!.reason).toContain("3회 연속");
    expect((await runsOf(taskId)).every((r) => r.status === "interrupted")).toBe(true);

    const retried = await t.modules.orchestration.service.retryTask(scope, taskId, t.owner);
    expect(retried.status).toBe("ready");
    expect((await taskRow(taskId)).input.interrupted_runs).toBeUndefined();
  });
});

describe("concept turn interrupted by a restart", () => {
  it("is reclaimed and answered by the next process; the session is not left in flight", async () => {
    const novel = await t.modules.novel.service.createNovel({ title: "재시작 테스트" }, t.owner);
    const h = await conceptHarness(t, novel.id, script);
    const inCall = deferred();
    script.push(async () => {
      inCall.resolve();
      return new Promise(() => {}); // provider call in flight when the server dies
    });
    const { taskId } = await h.say("회귀한 짐꾼이 S급 배신자에게 복수");
    expect(taskId).toBeTruthy();
    await t.testDb.exec(`UPDATE tasks SET not_before_at = NULL WHERE novel_id = '${novel.id}'`);
    const p1 = t.modules.orchestration.service as OrchestrationEngine;
    await p1.tick(new AbortController().signal, { ignoreCoalesceWindow: true });
    await inCall.promise;
    expect((await h.session()).inFlightTaskId).toBe(taskId);

    // process 2: same handlers, empty active registry
    const p2 = makeEngine(t);
    p2.registerTaskKind(p1.getTaskKind("concept_turn")!);
    expect(await p2.reclaimOrphans({ startup: true })).toBeGreaterThanOrEqual(1);
    expect(await taskRow(taskId!)).toMatchObject({ status: "ready", attempt_count: 0 });
    expect(await p2.runOnce()).toBe(1); // script empty → deterministic concept reply
    expect(await taskRow(taskId!)).toMatchObject({ status: "done" });
    const s = await h.session();
    expect(s.inFlightTaskId).toBeNull();
    expect(s.agentTurnCount).toBe(1);
    expect((await h.lastAgent()).askedFieldPaths).toEqual(["category.genre_label"]);
  });
});
