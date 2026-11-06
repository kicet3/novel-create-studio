import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actors } from "../src/platform/index.js";
import type { ActivityEvent } from "../src/modules/audit/index.js";
import { createTestCore, type TestCore } from "./support/test-core.js";

let t: TestCore;
let novelId: string;
beforeAll(async () => {
  t = await createTestCore();
  novelId = (await t.modules.novel.service.createNovel({ title: "감사 테스트" }, t.owner)).id;
});
afterAll(() => t.close());

describe("audit", () => {
  it("records inside the transaction, assigns increasing seq and publishes only after commit", async () => {
    const { uow } = t.platform;
    const audit = t.modules.audit.service;
    const seen: ActivityEvent[] = [];
    const off = audit.subscribe((e) => seen.push(e));
    let insideSeen = -1;
    const [e1, e2] = await uow.run(async (tx) => {
      const a = await audit.record(tx, { novelId, actor: t.owner, action: "novel.settings_changed", target: { type: "novel", id: novelId }, after: { x: 1 } });
      const b = await audit.record(tx, { novelId, actor: actors.system("scheduler"), action: "task.created", target: { type: "task", id: "tsk_X" } });
      insideSeen = seen.length;
      return [a, b];
    });
    expect(insideSeen).toBe(0);
    expect(seen.map((e) => e.seq)).toEqual([e1!.seq, e2!.seq]);
    expect(e2!.seq).toBeGreaterThan(e1!.seq);

    // rollback → no row, no publish
    const before = seen.length;
    await expect(
      uow.run(async (tx) => {
        await audit.record(tx, { novelId, actor: t.owner, action: "goal.updated", target: { type: "goal", id: "gol_X" } });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(seen.length).toBe(before);
    expect((await audit.list({ novelId }, { actionPrefix: "goal." })).items).toHaveLength(0);
    off();
  });

  it("masks secret-looking keys but keeps token counts", async () => {
    const e = await t.platform.uow.run((tx) =>
      t.modules.audit.service.record(tx, {
        novelId: null,
        actor: t.owner,
        action: "settings.changed",
        target: { type: "settings", id: "llm" },
        before: { apiKey: "sk-123", nested: { bot_token: "123:abc" } },
        after: { maxOutputTokens: 1000, inputTokens: 5 },
      }),
    );
    expect(e.before).toEqual({ apiKey: "[redacted]", nested: { bot_token: "[redacted]" } });
    expect(e.after).toEqual({ maxOutputTokens: 1000, inputTokens: 5 });
  });

  it("rejects unknown actions and agent actors without run id", async () => {
    const audit = t.modules.audit.service;
    await expect(
      t.platform.uow.run((tx) => audit.record(tx, { novelId, actor: t.owner, action: "nope.never" as never, target: { type: "novel", id: novelId } })),
    ).rejects.toThrow(/unknown audit action/);
    await expect(
      t.platform.uow.run((tx) =>
        audit.record(tx, { novelId, actor: { type: "agent", id: "writer", runId: "" }, action: "episode.created", target: { type: "episode", id: "epi_X" } }),
      ),
    ).rejects.toThrow(/runId/);
  });

  it("lists a novel timeline newest-first with filters and cursor paging", async () => {
    const audit = t.modules.audit.service;
    await t.platform.uow.run(async (tx) => {
      for (let i = 0; i < 5; i++) {
        await audit.record(tx, { novelId, actor: actors.system("orchestrator"), action: "run.started", target: { type: "run", id: `run_${i}` } });
      }
    });
    const p1 = await audit.list({ novelId }, { actionPrefix: "run.", limit: 2 });
    expect(p1.items).toHaveLength(2);
    expect(p1.items[0]!.seq).toBeGreaterThan(p1.items[1]!.seq);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await audit.list({ novelId }, { actionPrefix: "run.", limit: 2, beforeSeq: Number(p1.nextCursor) });
    expect(p2.items[0]!.seq).toBeLessThan(p1.items[1]!.seq);
    const one = await audit.list({ novelId }, { targetType: "run", targetIds: ["run_3", "run_4"] });
    expect(one.items.map((e) => e.targetId).sort()).toEqual(["run_3", "run_4"]);
    const newer = await audit.list({ novelId }, { afterSeq: p1.items[0]!.seq });
    expect(newer.items).toHaveLength(0);
    // install-level scope does not leak novel events
    expect((await audit.list(null, { actionPrefix: "run." })).items).toHaveLength(0);
  });

  it("serves GET /api/novels/:novelId/activity and 404s other novels", async () => {
    const r = await t.http("GET", `/api/novels/${novelId}/activity?actionPrefix=novel.&limit=10`);
    expect(r.status).toBe(200);
    expect(r.body.items.some((e: { action: string }) => e.action === "novel.created")).toBe(true);
    expect(r.body.latestSeq).toBeGreaterThan(0);
    const missing = await t.http("GET", `/api/novels/nov_00000000000000000000000000/activity`);
    expect(missing.status).toBe(404);
    const bad = await t.http("GET", `/api/novels/${novelId}/activity?limit=0`);
    expect(bad.status).toBe(400);
  });
});
