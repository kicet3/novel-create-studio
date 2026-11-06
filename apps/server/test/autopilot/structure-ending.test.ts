/**
 * 설계 추가 0014 — "구성·결말도 자동 승인" opt-in: the first structure is approved automatically, but a structure
 * reopened by an ending change (결말 방향 변경 after approval) always waits for the author; the ending_change approval
 * itself is always human.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as dto from "@ncs/shared";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { scriptPipeline } from "../support/pipeline-script.js";
import { decideApproval, drain, planningNovel, type Scope } from "../structure/harness.js";
import { enableFullAuto } from "./harness.js";

describe("structure opt-in and ending changes", () => {
  let t: TestCore;
  let scope: Scope;
  beforeAll(async () => {
    t = await createTestCore();
    t.claude.reply({ times: Infinity, when: { schemaHas: ["new_setups"] }, json: { new_setups: [], existing_setup_beats: [], rationale: "새 떡밥 없음" } });
    scriptPipeline(t.claude);
    ({ scope } = await planningNovel(t, { title: "결말 변경" }));
    await enableFullAuto(t, scope, { autoApproveStructure: true });
  });
  afterAll(() => t.close());

  it("bible and the first structure are approved automatically", async () => {
    await drain(t, scope, async () => (await t.modules.novel.service.getStructure(scope))?.status === "approved", 60);
    const types = (await t.modules.hitl.service.listApprovals(scope, { statuses: ["approved"] })).filter((a) => a.autoDecided).map((a) => a.approvalType);
    expect(types).toEqual(expect.arrayContaining(["series_bible", "story_structure"]));
  });

  it("an ending change waits for the author; the reopened structure is never auto-approved", async () => {
    const goal = (await t.modules.novel.service.getGoal(scope))!;
    const r = await t.http("PUT", `/api/novels/${scope.novelId}/goal`, { totalEpisodesMin: goal.totalEpisodesMin, totalEpisodesMax: goal.totalEpisodesMax, cadenceEpisodesPerWeek: goal.cadenceEpisodesPerWeek, reserveTargetEpisodes: goal.reserveTargetEpisodes, endingDirection: "흉터의 비밀을 밝히지만 회귀는 계속된다", notes: null });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await t.modules.autopilot.service.tick(scope);
    const ending = (await t.modules.hitl.service.listApprovals(scope, { types: ["ending_change"] }))[0]!;
    expect(ending.status).toBe("pending"); // always human
    expect((await decideApproval(t, scope, "ending_change", "approved")).status).toBeLessThan(300);
    const s = (await t.modules.novel.service.getStructure(scope))!;
    expect(s.status).toBe("draft");
    expect(s.pendingChanges.goalEndingChanged).toBe(true);
    await drain(t, scope, async () => false, 8).catch(() => undefined);
    expect((await t.modules.novel.service.getStructure(scope))!.status).not.toBe("approved");
    const v = dto.autopilotViewSchema.parse((await t.http("GET", `/api/novels/${scope.novelId}/autopilot`)).body);
    expect(v.waitingHuman.map((w) => w.kind)).toContain("structure_review");
    // the author re-approves it from the structure page (decideStructure stays user-only)
    const cur = (await t.modules.novel.service.getStructure(scope))!;
    const d = await t.http("POST", `/api/novels/${scope.novelId}/structure/decision`, { decision: "approved", expectedRevision: cur.revision });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    const last = (await t.modules.hitl.service.listApprovals(scope, { types: ["story_structure"] })).find((a) => a.status === "approved" && !a.autoDecided);
    expect(last?.decidedByUserId).toBe(t.ownerId);
  });
});
