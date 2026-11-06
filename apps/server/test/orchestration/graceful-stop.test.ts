/**
 * Review regressions (02 §7.3, 04 §5.2/§8.3, 03 cost_events.is_rerun):
 *  - graceful stop / outside block lets the in-flight provider call finish and be saved (no unknown cost,
 *    no attempt used, run not failed); only the hard deadline (abortAll) aborts the call
 *  - is_rerun marks the reclaimed rerun's cost, not an ordinary retry
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actors } from "../../src/platform/index.js";
import { createOrchestrationEngine } from "../../src/modules/orchestration/application/engine.js";
import { createWorkerPool } from "../../src/runtime/worker-pool.js";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { handler, novelWithGoal } from "./support.js";

let t: TestCore;
beforeAll(async () => {
  t = await createTestCore();
  // every call of these tests: the (mock) Claude API answers after 600 ms, so a stop can land while it is in flight
  t.claude.reply({ when: { prompt: "hello" }, times: Infinity, delayMs: 600, text: "안녕하세요." });
}, 60_000);
afterAll(() => t.close());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const engineOf = () => {
  const e = createOrchestrationEngine({ platform: t.platform, audit: t.modules.audit.service, novel: t.modules.novel.service, budget: t.modules.budget.service, pool: createWorkerPool(8), llm: t.modules.llm.service as never });
  e.registerTaskKind(
    handler("dedupe_entities", "world_keeper", {
      promptTemplateVersion: "world_keeper.dedupe@0",
      execute: async (ctx) => {
        await t.modules.llm.service.modelCalls.call({ run: ctx.run, purpose: "x", system: "s", messages: [{ role: "user", content: "hello" }], output: { kind: "text" }, maxOutputTokens: 1000 });
        await ctx.run.checkpoint();
        return {};
      },
    }),
  );
  return e;
};

async function startInFlight() {
  const { scope } = await novelWithGoal(t);
  const e = engineOf();
  const { taskId } = await t.platform.uow.run((tx) => e.createTask(tx, scope, { kind: "dedupe_entities", targetType: "novel", targetId: scope.novelId, input: {}, createdBy: actors.system("orchestrator") }));
  const outer = new AbortController();
  await e.tick(outer.signal, { ignoreCoalesceWindow: true });
  for (let i = 0; i < 200; i++) {
    const r = await t.testDb.query<{ status: string }>(`SELECT status FROM provider_calls WHERE novel_id='${scope.novelId}'`);
    if (r.some((x) => x.status === "sent")) break;
    await sleep(10);
  }
  return { e, scope, taskId, outer };
}

async function stateOf(novelId: string, taskId: string) {
  const calls = await t.testDb.query<{ status: string }>(`SELECT status FROM provider_calls WHERE novel_id='${novelId}'`);
  const cost = await t.testDb.query<{ cost_basis: string }>(`SELECT cost_basis FROM cost_events WHERE novel_id='${novelId}'`);
  const [task] = await t.testDb.query<{ status: string; attempt_count: number }>(`SELECT status, attempt_count FROM tasks WHERE id='${taskId}'`);
  const runs = await t.testDb.query<{ status: string; stop_reason: string | null }>(`SELECT status, stop_reason FROM runs WHERE task_id='${taskId}'`);
  return { calls, cost, task: task!, runs };
}

describe("graceful stop keeps the in-flight call", () => {
  it("shutdown signal: call responded and settled measured, run stops (paused), no attempt used", async () => {
    const { e, scope, taskId, outer } = await startInFlight();
    outer.abort();
    await sleep(1500);
    const s = await stateOf(scope.novelId, taskId);
    expect(s.calls.map((c) => c.status)).toEqual(["responded"]);
    expect(s.cost.map((c) => c.cost_basis)).toEqual(["measured"]);
    expect(s.runs[0]).toMatchObject({ status: "cancelled", stop_reason: "paused" });
    expect(s.task.attempt_count).toBe(0);
    expect(s.task.status).not.toBe("failed");
    e.abortAll();
  });

  it("blockTask from outside: call responded, run fenced out without a failure", async () => {
    const { e, scope, taskId } = await startInFlight();
    await t.platform.uow.run((tx) => e.blockTask(tx, scope, taskId, "question", null, t.owner));
    await sleep(1500);
    const s = await stateOf(scope.novelId, taskId);
    expect(s.calls.map((c) => c.status)).toEqual(["responded"]);
    expect(s.cost.map((c) => c.cost_basis)).toEqual(["measured"]);
    expect(s.runs[0]!.status).not.toBe("failed");
    expect(s.task.attempt_count).toBe(0);
  });

  it("hard deadline (abortAll): the call closes unknown, but the run is a stop (no attempt, not failed)", async () => {
    const { e, scope, taskId } = await startInFlight();
    e.abortAll();
    await sleep(1000);
    const s = await stateOf(scope.novelId, taskId);
    expect(s.calls.map((c) => c.status)).toEqual(["unknown"]);
    expect(s.runs[0]).toMatchObject({ status: "cancelled", stop_reason: "paused" });
    expect(s.task.attempt_count).toBe(0);
  });
});

describe("cost_events.is_rerun", () => {
  it("is true for the reclaimed rerun's call and false for the first run", async () => {
    const { scope, taskId } = await startInFlight();
    // "process restart": a fresh engine (empty active registry) reclaims, then reruns the task
    const b = engineOf();
    await b.reclaimOrphans({ startup: true });
    await b.runOnce();
    await sleep(1500);
    const rows = await t.testDb.query<{ rerun_of_run_id: string | null; cost_basis: string; is_rerun: boolean }>(
      `SELECT r.rerun_of_run_id, c.cost_basis, c.is_rerun FROM runs r JOIN cost_events c ON c.run_id = r.id WHERE r.task_id='${taskId}' AND c.adjusts_cost_event_id IS NULL ORDER BY c.created_at`,
    );
    const first = rows.find((r) => r.rerun_of_run_id === null);
    const rerun = rows.find((r) => r.rerun_of_run_id !== null);
    expect(first?.is_rerun).toBe(false);
    expect(rerun).toBeDefined();
    expect(rerun!.is_rerun).toBe(true);
    void scope;
  });
});
