/**
 * 설계 추가 0014 — 플롯별 승인(arc_approval) made real: a plot longer than the reserve target used to deadlock (the
 * "every episode waits" condition never held). Now a full reserve with nothing of the plot in flight asks for a partial
 * batch; the last batch moves the plot to awaiting_approval (AR5) and its approval completes it (AR7).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { scriptPipeline } from "../support/pipeline-script.js";
import { approveStructure, bibleApproved, decideApproval, drain, planningNovel, type Scope } from "../structure/harness.js";

describe("arc_approval batches", () => {
  let t: TestCore;
  let scope: Scope;
  beforeAll(async () => {
    t = await createTestCore();
    t.claude.reply({ times: Infinity, when: { schemaHas: ["new_setups"] }, json: { new_setups: [], existing_setup_beats: [], rationale: "새 떡밥 없음" } });
    scriptPipeline(t.claude);
    ({ scope } = await planningNovel(t, { title: "플롯별 승인" })); // reserve target 2, plots of 3 episodes
    expect((await t.http("PUT", `/api/novels/${scope.novelId}/autonomy`, { autonomyLevel: "arc_approval" })).status).toBe(200);
    await bibleApproved(t, scope);
    await approveStructure(t, scope);
    await drain(t, scope, async () => (await t.modules.novel.service.listArcs(scope)).some((a) => a.status === "plan_awaiting_approval"));
    expect((await decideApproval(t, scope, "arc_plan", "approved")).status).toBeLessThan(300); // plot plans stay human
  }, 60_000);
  afterAll(() => t.close());

  const pendingArc = async () => (await t.modules.hitl.service.listApprovals(scope, { statuses: ["pending"], types: ["arc"] }))[0];
  const eps = async () => (await t.modules.manuscript.service.listEpisodes(scope)).sort((a, b) => a.episodeNo - b.episodeNo).slice(0, 3);

  it("a full reserve asks for a partial batch; the plot stays active", async () => {
    await drain(t, scope, async () => !!(await pendingArc()), 150);
    const a = (await pendingArc())!;
    const first = await eps();
    expect(first.map((e) => e.status)).toEqual(["awaiting_approval", "awaiting_approval", "planned"]);
    expect(a.payload).toMatchObject({ partial: true, episodeIds: [first[0]!.id, first[1]!.id], episodeNos: [1, 2] });
    const arc = await t.modules.novel.service.getArc(scope, a.subjectId);
    expect(arc.status).toBe("active");
    // no per-episode approval in arc_approval
    expect(await t.modules.hitl.service.listApprovals(scope, { statuses: ["pending"], types: ["episode"] })).toHaveLength(0);
    expect((await decideApproval(t, scope, "arc", "approved")).status).toBeLessThan(300);
    expect((await eps()).map((e) => e.status)).toEqual(["approved", "approved", "planned"]);
    expect((await t.modules.novel.service.getArc(scope, a.subjectId)).status).toBe("active");
  });

  it("after publishing, the last episode is written and the final batch completes the plot", async () => {
    for (const no of [1, 2]) expect((await t.http("POST", `/api/novels/${scope.novelId}/episodes/${no}/publish`)).status).toBe(200);
    await drain(t, scope, async () => !!(await pendingArc()), 150);
    const a = (await pendingArc())!;
    const [, , third] = await eps();
    expect(third!.status).toBe("awaiting_approval");
    expect(a.payload).toMatchObject({ partial: false, episodeIds: [third!.id] });
    expect((await t.modules.novel.service.getArc(scope, a.subjectId)).status).toBe("awaiting_approval"); // AR5
    expect((await decideApproval(t, scope, "arc", "approved")).status).toBeLessThan(300);
    expect((await eps()).map((e) => e.status)).toEqual(["published", "published", "approved"]);
    expect((await t.modules.novel.service.getArc(scope, a.subjectId)).status).toBe("completed"); // AR7
  });
});
