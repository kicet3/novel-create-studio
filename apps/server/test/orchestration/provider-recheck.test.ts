import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "@ncs/test-kit";
import { actors } from "../../src/platform/index.js";
import { createWorkerPool } from "../../src/runtime/worker-pool.js";
import { TaskFailure } from "../../src/modules/orchestration/index.js";
import { createOrchestrationEngine, PROVIDER_RECHECK_MS } from "../../src/modules/orchestration/application/engine.js";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { handler, novelWithGoal } from "./support.js";

let t: TestCore;
let clock: FakeClock;
beforeEach(async () => {
  clock = new FakeClock("2026-11-05T00:00:00.000Z");
  t = await createTestCore({ clock });
});
afterEach(() => t.close());

describe("provider_unavailable block is released when the connection check passes (02 §5.7)", () => {
  it("stays blocked while the provider is not connected, then runs again after it is", async () => {
    let connected = false;
    let checks = 0;
    const e = createOrchestrationEngine({
      platform: t.platform,
      audit: t.modules.audit.service,
      novel: t.modules.novel.service,
      budget: t.modules.budget.service,
      pool: createWorkerPool(4),
      llm: {
        isRoleProviderConnected: async () => {
          checks++;
          return connected;
        },
      },
    });
    let runs = 0;
    e.registerTaskKind(
      handler("dedupe_entities", "world_keeper", {
        async execute() {
          // auth_failed is not retryable → the task is blocked on its provider (T7)
          if (++runs === 1) throw new TaskFailure("auth_failed", "연결이 없습니다", false);
          return {};
        },
        async commit(_tx, ctx) {
          return { kind: "done", outputRefs: [{ refType: "novel", refId: ctx.scope.novelId }] };
        },
      }),
    );
    const { scope, novel } = await novelWithGoal(t);
    const { taskId } = await t.platform.uow.run((tx) =>
      t.modules.orchestration.service.createTask(tx, scope, { kind: "dedupe_entities", targetType: "novel", targetId: novel.id, input: {}, createdBy: actors.system("scheduler") }),
    );

    expect(await e.runOnce()).toBe(1);
    let task = await e.getTask(scope, taskId);
    expect(task).toMatchObject({ status: "blocked", blockReason: "provider_unavailable" });

    // too early: not even checked
    clock.advance(60_000);
    await e.runOnce();
    expect(checks).toBe(0);

    // due, but the provider is still not connected
    clock.advance(PROVIDER_RECHECK_MS);
    expect(await e.runOnce()).toBe(0);
    expect(checks).toBe(1);
    expect((await e.getTask(scope, taskId)).status).toBe("blocked");

    // the account is connected again → released (T9) and executed
    connected = true;
    clock.advance(60_000);
    await e.runOnce();
    await e.runOnce();
    task = await e.getTask(scope, taskId);
    expect(task.status).toBe("done");
    expect(task.blockReason).toBeNull();
    expect(runs).toBe(2);
  });
});
