/**
 * Review fixes (컨셉 답변 스트리밍 리뷰):
 *  - a cancel that lands after the last safe point but before the commit transaction still wins (no commit)
 *  - `onUncommitted` runs after a run that ended without its commit, with the proposal execute returned
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actors } from "../../src/platform/index.js";
import type { RunHandle } from "../../src/modules/orchestration/index.js";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { deferred, handler, makeEngine, novelWithGoal } from "./support.js";

let t: TestCore;
beforeAll(async () => {
  t = await createTestCore();
}, 60_000);
afterAll(() => t.close());

type Seen = { outcome: string; reason: string; proposal: unknown; taskStatus: string };

describe("runs that end without their commit", () => {
  it("cancel after the last checkpoint, before the commit: nothing is committed, onUncommitted gets the proposal", async () => {
    const { scope } = await novelWithGoal(t);
    const e = makeEngine(t);
    let committed = 0;
    const seen: Seen[] = [];
    let taskId = "";
    e.registerTaskKind(
      handler<{ cost: number }>("dedupe_entities", "world_keeper", {
        execute: async (ctx) => {
          // the engine's own final checkpoint passes, then the cancel arrives (window before the commit tx)
          const run = ctx.run as { -readonly [K in keyof RunHandle]: RunHandle[K] };
          const orig = run.checkpoint.bind(run);
          run.checkpoint = async () => {
            await orig();
            await t.platform.uow.run((tx) => e.cancelTask(tx, scope, taskId, t.owner));
          };
          return { cost: 7 };
        },
        commit: async () => {
          committed++;
          return { kind: "done", outputRefs: [] };
        },
        onUncommitted: async (tx, ctx, info) => {
          const task = await e.getTask(scope, ctx.task.id, tx);
          seen.push({ outcome: info.outcome, reason: info.reason, proposal: info.proposal, taskStatus: task.status });
        },
      }),
    );
    ({ taskId } = await t.platform.uow.run((tx) => e.createTask(tx, scope, { kind: "dedupe_entities", targetType: "novel", targetId: scope.novelId, input: {}, createdBy: actors.system("orchestrator") })));
    expect(await e.runOnce()).toBe(1);
    expect(committed).toBe(0);
    expect((await e.getTask(scope, taskId)).status).toBe("cancelled");
    expect(seen).toEqual([{ outcome: "stopped", reason: "cancelled_by_user", proposal: { cost: 7 }, taskStatus: "cancelled" }]);
  });

  it("a committed run never calls onUncommitted; a stop during execute calls it without a proposal", async () => {
    const { scope } = await novelWithGoal(t);
    const e = makeEngine(t);
    const seen: Seen[] = [];
    const gate = deferred();
    e.registerTaskKind(
      handler("dedupe_entities", "world_keeper", {
        execute: async (ctx) => {
          if ((ctx.input as { n?: number }).n === 2) {
            await gate.promise;
            await ctx.run.checkpoint(); // cancelled meanwhile → RunStop inside execute
          }
          return {};
        },
        onUncommitted: async (tx, ctx, info) => {
          seen.push({ outcome: info.outcome, reason: info.reason, proposal: info.proposal, taskStatus: (await e.getTask(scope, ctx.task.id, tx)).status });
        },
      }),
    );
    const mk = (n: number) => t.platform.uow.run((tx) => e.createTask(tx, scope, { kind: "dedupe_entities", targetType: "novel", targetId: scope.novelId, input: { n }, createdBy: actors.system("orchestrator") }));
    await mk(1);
    expect(await e.runOnce()).toBe(1);
    expect(seen).toEqual([]);

    const { taskId } = await mk(2);
    const running = e.runOnce();
    for (let i = 0; i < 200 && (await e.getTask(scope, taskId)).status !== "running"; i++) await new Promise((r) => setTimeout(r, 10));
    await t.platform.uow.run((tx) => e.cancelTask(tx, scope, taskId, t.owner));
    gate.resolve();
    await running;
    expect(seen).toEqual([{ outcome: "stopped", reason: "cancelled_by_user", proposal: undefined, taskStatus: "cancelled" }]);
  });
});
