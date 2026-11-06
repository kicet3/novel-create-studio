/**
 * 설계 추가 0008 리뷰 수정 회귀 테스트 (PGlite, scripted model):
 *  - 부 범위 확장·축소 후 재승인 → 플롯이 범위를 빈틈없이 덮고, 밀려난 계획 화는 덮는 플롯으로 옮겨진다 (H1)
 *  - 승인된 결말을 고친 뒤 재승인 전에는 아웃라인·초고가 막힌다 (H2)
 *  - 승인 요청의 revision이 바뀐 구성은 그 요청으로 승인되지 않는다 (M1)
 *  - AI 재생성은 진행 중 플롯의 범위 잠금을 지키고, 바뀐 게 없으면 승인 상태를 유지한다 (M2, L3)
 *  - 진행 중 플롯의 재계획안은 승인 뒤에 반영된다 (M4)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as dto from "@ncs/shared";
import { stripPartOrdinal } from "../../src/modules/manuscript/application/structure.js";
import { splitRelationText } from "../../src/modules/cast/domain/cast.js";
import { scriptPipeline } from "../support/pipeline-script.js";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { approveStructure, bibleApproved, decideApproval, drain, planningNovel, structureAwaiting, type Scope } from "./harness.js";

let t: TestCore;
beforeAll(async () => {
  t = await createTestCore();
  scriptPipeline(t.claude);
});
afterAll(() => t.close());

const nv = () => t.modules.novel.service;
const ms = () => t.modules.manuscript.service;
const tasksOf = (scope: Scope, kind: dto.TaskKind) => t.modules.orchestration.service.listTasks(scope, { kinds: [kind], includeCancelled: true, limit: 100 });
const livePlots = async (scope: Scope) => (await nv().listArcs(scope)).filter((a) => a.status !== "cancelled").sort((a, b) => a.plannedEpisodeFrom - b.plannedEpisodeFrom);
/** every episode number 1..total belongs to exactly one live plot */
const expectCovered = async (scope: Scope, total: number) => {
  const plots = await livePlots(scope);
  const owners = Array.from({ length: total }, (_, i) => plots.filter((a) => a.plannedEpisodeFrom <= i + 1 && i + 1 <= a.plannedEpisodeTo).length);
  expect(owners, JSON.stringify(plots.map((a) => [a.plannedEpisodeFrom, a.plannedEpisodeTo, a.status]))).toEqual(Array(total).fill(1));
};
const editPart = async (scope: Scope, ord: number, body: Record<string, unknown>) => {
  const s = (await nv().getStructure(scope))!;
  const part = s.parts.find((p) => p.ord === ord)!;
  const r = await t.http("PATCH", `/api/novels/${scope.novelId}/structure/parts/${part.id}`, { expectedRevision: s.revision, ...body });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
const reapprove = async (scope: Scope) => {
  const s = (await nv().getStructure(scope))!;
  const r = await t.http("POST", `/api/novels/${scope.novelId}/structure/decision`, { decision: "approved", expectedRevision: s.revision });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};

describe("domain helpers", () => {
  it("strips an ordinal the model put in a part title", () => {
    expect(stripPartOrdinal("1부 — 다시 뜬 달")).toBe("다시 뜬 달");
    expect(stripPartOrdinal("제3부: 배신의 밤")).toBe("배신의 밤");
    expect(stripPartOrdinal("흉터의 기억")).toBe("흉터의 기억");
    expect(stripPartOrdinal("2부")).toBe("2부");
  });
  it("splits a relation sentence into a short kind and a description", () => {
    expect(splitRelationText("스승. 회귀 전 서월을 벤 배신자이고, 서월이 이번 생에서 가장 의심하는 사람")).toEqual({
      kind: "스승",
      description: "스승. 회귀 전 서월을 벤 배신자이고, 서월이 이번 생에서 가장 의심하는 사람",
    });
    expect(splitRelationText("라이벌")).toEqual({ kind: "라이벌", description: "" });
  });
});

describe("part range changes after approval keep every episode in a plot (H1)", () => {
  let scope: Scope;
  it("extending part 1 creates a plot for the new episodes instead of leaving a gap", async () => {
    ({ scope } = await planningNovel(t, { title: "범위 작품" }));
    await bibleApproved(t, scope);
    await approveStructure(t, scope);
    await drain(t, scope, async () => (await nv().listArcs(scope)).some((a) => a.status === "plan_awaiting_approval"));
    const first = (await livePlots(scope))[0]!;
    expect((await ms().listEpisodes(scope, { arcId: first.id })).map((e) => e.episodeNo)).toEqual([1, 2, 3]);
    await editPart(scope, 1, { plannedEpisodeTo: 5 });
    await reapprove(scope);
    await expectCovered(scope, 12);
    const s = (await nv().getStructure(scope))!;
    const part1 = s.parts.find((p) => p.ord === 1)!;
    const inPart1 = (await livePlots(scope)).filter((a) => a.partId === part1.id);
    expect(inPart1.map((a) => [a.plannedEpisodeFrom, a.plannedEpisodeTo])).toEqual([[1, 3], [4, 5]]);
  });

  it("shrinking part 1 clips the unstarted plot; its planned episode moves to the plot that now covers it", async () => {
    await editPart(scope, 1, { plannedEpisodeTo: 2 });
    await reapprove(scope);
    await expectCovered(scope, 12);
    const plots = await livePlots(scope);
    expect(plots[0]!.plannedEpisodeTo).toBe(2);
    const ep3 = await ms().getEpisodeByNo(scope, 3);
    const owner = plots.find((a) => a.plannedEpisodeFrom <= 3 && 3 <= a.plannedEpisodeTo)!;
    expect(ep3.arcId).toBe(owner.id); // no episode outside its plot
    for (const e of await ms().listEpisodes(scope)) {
      const a = plots.find((x) => x.id === e.arcId)!;
      expect(e.episodeNo >= a.plannedEpisodeFrom && e.episodeNo <= a.plannedEpisodeTo, `${e.episodeNo}화`).toBe(true);
    }
    expect((await tasksOf(scope, "plan_arc")).some((x) => x.targetId === owner.id && x.status !== "done")).toBe(true); // the adopting plot is planned
  });
});

describe("edited structure gates writing until re-approval; regeneration and replans need approval", () => {
  let scope: Scope;
  let arcId: string;
  it("an ending edit blocks new outlines / drafts (outline gate + scheduler) until the structure is approved again (H2)", async () => {
    ({ scope } = await planningNovel(t, { title: "게이트 작품" }));
    await bibleApproved(t, scope);
    await approveStructure(t, scope);
    await drain(t, scope, async () => (await nv().listArcs(scope)).some((a) => a.status === "plan_awaiting_approval"));
    expect((await decideApproval(t, scope, "arc_plan", "approved")).status).toBeLessThan(300);
    arcId = (await livePlots(scope))[0]!.id;
    expect((await nv().getArc(scope, arcId)).status).toBe("active");
    const ep1 = await ms().getEpisodeByNo(scope, 1);
    const gate = t.modules.orchestration.service.getTaskKind("outline_episode")!.gate!;
    expect(await gate(scope, { input: { episode_id: ep1.id } } as never)).toMatchObject({ ok: true });

    const s = (await nv().getStructure(scope))!;
    const r = await t.http("PATCH", `/api/novels/${scope.novelId}/structure/ending`, { expectedRevision: s.revision, ending: { conflictResolution: "한결은 계약을 이어받는다." } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await gate(scope, { input: { episode_id: ep1.id } } as never)).toMatchObject({ ok: false, blockReason: "approval", blockedRef: { refType: "novel", refId: scope.novelId } });
    expect(await t.modules.orchestration.service.getTaskKind("draft_episode")!.gate!(scope, { input: { episode_id: ep1.id } } as never)).toMatchObject({ ok: false });
    const before = (await tasksOf(scope, "outline_episode")).length;
    await ms().schedule(scope);
    expect((await tasksOf(scope, "outline_episode")).length).toBe(before);

    await reapprove(scope);
    expect(await gate(scope, { input: { episode_id: ep1.id } } as never)).toMatchObject({ ok: true });
    expect((await nv().getArc(scope, arcId)).planFlags).toEqual(["ending_changed"]);
    expect((await t.http("POST", `/api/novels/${scope.novelId}/arcs/${arcId}/acknowledge-flags`)).status).toBe(200);
  });

  it("a story_structure request whose revision no longer matches is not decided (M1)", async () => {
    await editPart(scope, 4, { title: "끝의 계약" });
    const stale = await t.http("POST", `/api/novels/${scope.novelId}/structure/decision`, { decision: "approved", expectedRevision: (await nv().getStructure(scope))!.revision - 1 });
    expect(stale.status).toBe(409);
    // an inbox request for revision R must not approve revision R+1 (a change committed in between)
    expect((await t.http("POST", `/api/novels/${scope.novelId}/structure/generate`, { scope: "parts" })).status).toBe(202);
    const s = await structureAwaiting(t, scope);
    await t.testDb.exec(`UPDATE story_structures SET revision = revision + 1 WHERE novel_id = '${scope.novelId}'`);
    const r = await decideApproval(t, scope, "story_structure", "approved");
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.error.code).toBe("revision_conflict");
    expect((await nv().getStructure(scope))!.status).toBe("awaiting_approval");
    await t.testDb.exec(`UPDATE story_structures SET revision = ${s.revision} WHERE novel_id = '${scope.novelId}'`);
    expect((await decideApproval(t, scope, "story_structure", "approved")).status).toBeLessThan(300);
    expect((await nv().getStructure(scope))!.status).toBe("approved");
  });

  it("AI regeneration keeps the ranges of a running plot's part and, with nothing changed, keeps the approval (M2, L3)", async () => {
    const s = (await nv().getStructure(scope))!;
    const parts = [...s.parts].sort((a, b) => a.ord - b.ord);
    const shifted: Parameters<ReturnType<typeof nv>["saveStructureProposal"]>[2]["parts"] = parts.map((p) => ({
      ord: p.ord,
      title: p.title,
      goalText: p.goalText,
      turningPoints: p.turningPoints ?? [],
      // part 1 (running plot 1~3) would end at 2 — the lock keeps every range
      plannedEpisodeFrom: p.ord === 1 ? 1 : p.plannedEpisodeFrom - 1,
      plannedEpisodeTo: p.ord === 4 ? p.plannedEpisodeTo : p.plannedEpisodeTo - 1,
      characterStates: p.characterStates ?? [],
      plotOutline: p.plotOutline ?? [],
    }));
    const agent = { type: "agent", id: "planner", runId: "run_test" } as never;
    const after = await t.platform.uow.run((tx) => nv().saveStructureProposal(tx, scope, { ending: s.ending ?? {}, parts: shifted, firstAppearances: [], scope: "parts" }, agent));
    expect(after.parts.map((p) => [p.plannedEpisodeFrom, p.plannedEpisodeTo])).toEqual(parts.map((p) => [p.plannedEpisodeFrom, p.plannedEpisodeTo]));
    expect(after.status).toBe("approved"); // nothing the agent may change differs → no ST4
    expect(after.revision).toBe(s.revision);
  });

  it("a re-plan of the running plot waits for approval (M4)", async () => {
    const rp = await t.http("POST", `/api/novels/${scope.novelId}/arcs/${arcId}/replan`, { note: "중반 긴장을 높여 주세요" });
    expect(rp.status, JSON.stringify(rp.body)).toBe(202);
    const pendingReplan = async () =>
      (await t.modules.hitl.service.listApprovals(scope, { statuses: ["pending"], types: ["arc_plan"] })).find((a) => (a.payload as { replan?: unknown })?.replan) ?? null;
    await drain(t, scope, async () => !!(await pendingReplan()));
    const approval = (await pendingReplan())!;
    const view = dto.structureViewSchema.parse((await t.http("GET", `/api/novels/${scope.novelId}/structure`)).body);
    expect(view.plots.find((p) => p.id === arcId)!.replanApprovalId).toBe(approval.id);
    const updatesBefore = (await t.modules.audit.service.list(scope, { actionPrefix: "arc.updated" })).items.filter((e) => e.targetId === arcId).length;
    const ok = await t.http("POST", `/api/novels/${scope.novelId}/approvals/${approval.id}/decision`, { decision: "approved" });
    expect(ok.status, JSON.stringify(ok.body)).toBeLessThan(300);
    expect(ok.body.approval.status).toBe("approved");
    expect((await nv().getArc(scope, arcId)).status).toBe("active");
    // the scripted plan equals the current one, so applying it records no field diff — and nothing was applied before
    expect((await t.modules.audit.service.list(scope, { actionPrefix: "arc.updated" })).items.filter((e) => e.targetId === arcId).length).toBe(updatesBefore);
  });
});
