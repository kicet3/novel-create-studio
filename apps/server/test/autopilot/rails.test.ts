/**
 * 설계 추가 0014 — safety rails of the autopilot: daily budget throttle (until local midnight), monthly budget warning
 * → kill switch, and the daily episode cap in the scheduler.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as dto from "@ncs/shared";
import { actors, type NovelScope } from "../../src/platform/index.js";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { planningNovel } from "../structure/harness.js";
import { auditActions, enableFullAuto } from "./harness.js";

const SYS = actors.system("orchestrator");
let t: TestCore;
beforeAll(async () => {
  t = await createTestCore();
});
afterAll(() => t.close());

async function spend(scope: NovelScope, micros: number, key: string) {
  const [p] = await t.testDb.query<{ id: string; version_no: number }>("SELECT id, version_no FROM provider_profiles ORDER BY created_at LIMIT 1");
  await t.platform.uow.run((tx) =>
    t.modules.budget.service.recordDirectCost(tx, scope, {
      idempotencyKey: key,
      category: "image",
      provider: "openai",
      modelId: "gpt-image-1",
      providerProfileId: p!.id,
      providerProfileVersion: p!.version_no,
      basis: "measured",
      amountMicros: micros,
      reservedMicros: micros,
    }),
  );
}

async function bibleAwaiting(scope: NovelScope) {
  return t.platform.uow.run(async (tx) => {
    const n = await t.modules.novel.service.getNovel(scope, tx);
    const bible = await t.modules.novel.service.createBibleVersion(tx, scope, { logline: "로그라인", synopsis: "시놉시스", content: {}, contentMd: "# 기획서", conceptBriefId: n.approvedConceptBriefId! }, SYS);
    const req = await t.modules.hitl.service.requestApproval(tx, scope, {
      approvalType: "series_bible",
      target: { type: "series_bible", id: bible.id },
      question: { title: "기획서 승인 요청", body: "기획서", links: [{ type: "series_bible", id: bible.id }] },
      requestedBy: SYS,
    });
    await t.modules.novel.service.transitionBible(tx, scope, bible.id, "awaiting_approval", SYS, { approvalId: req.approvalId });
    return req;
  });
}

describe("budget rails", () => {
  it("daily budget cap: throttle until the next local midnight — no auto decision, no new episode", async () => {
    const { scope } = await planningNovel(t, { title: "하루 예산" });
    await enableFullAuto(t, scope, { dailyBudgetUsd: 0.5, haltOnBudgetWarning: false });
    const req = await bibleAwaiting(scope);
    await spend(scope, 600_000, "img:daily-1");
    const r = await t.modules.autopilot.service.tick(scope);
    expect(r.skipped).toBe("throttled");
    expect(r.decided).toEqual([]);
    expect((await t.modules.hitl.service.getApproval(scope, req.approvalId)).status).toBe("pending");
    const v = dto.autopilotViewSchema.parse((await t.http("GET", `/api/novels/${scope.novelId}/autopilot`)).body);
    expect(v.phase).toBe("throttled");
    expect(v.throttle?.reason).toBe("daily_budget");
    const until = new Date(v.throttle!.until);
    expect(until.getTime()).toBeGreaterThan(Date.now());
    expect(until.getTime() - Date.now()).toBeLessThanOrEqual(24 * 3600_000);
    expect(dto.wallParts(until, "Asia/Seoul")).toMatchObject({ hour: 0, minute: 0 });
    expect(v.today.spentMicros).toBe(600_000);
    expect(await auditActions(t, scope, "autopilot.throttled")).toHaveLength(1);
    // the scheduler reads the throttle from the novel row
    const sched = await t.modules.manuscript.service.schedule(scope);
    expect(sched.notes.some((n) => n === "autopilot:daily_budget" || n.startsWith("no_"))).toBe(true);
    // raising the cap lifts the throttle on the next pass
    expect((await t.http("PATCH", `/api/novels/${scope.novelId}/autopilot/settings`, { dailyBudgetUsd: 5 })).status).toBe(200);
    const again = await t.modules.autopilot.service.tick(scope);
    expect(again.skipped).toBeNull();
    expect(again.decided).toEqual([`series_bible:${req.approvalId}`]);
  });

  it("monthly budget warning halts the autopilot (kill switch reason budget_warning)", async () => {
    const { scope } = await planningNovel(t, { title: "월 예산 경고" });
    await enableFullAuto(t, scope, {});
    await t.modules.budget.service.updatePolicy(scope, "all", { hardLimitMicros: 1_000_000, softWarnRatio: 0.5 }, t.owner);
    await spend(scope, 600_000, "img:month-1");
    expect((await t.modules.budget.service.status(scope)).some((b) => b.status === "warning")).toBe(true);
    const r = await t.modules.autopilot.service.tick(scope);
    expect(r.skipped).toBe("halted");
    const n = await t.modules.novel.service.getNovel(scope);
    expect(n.autopilotHaltReason).toBe("budget_warning");
    expect((await auditActions(t, scope, "autopilot.halted"))[0]!.after).toMatchObject({ reason: "budget_warning" });
    expect((await auditActions(t, scope, "autopilot.gate_hit")).length).toBe(1);
  });
});
