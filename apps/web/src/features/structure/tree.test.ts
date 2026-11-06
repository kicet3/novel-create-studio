import { describe, expect, it } from "vitest";
import type { StoryPartDto, StoryStructureDto, StructureEpisodeDto, StructurePlotDto, StructureView } from "@ncs/shared";
import { buildTree, displayStatus, outlineSumMismatch, partTitle, pendingChangeLines, structureStep } from "./tree.js";

const T = "2026-11-01T00:00:00.000Z";
const part = (ord: number, from: number, to: number): StoryPartDto => ({
  id: `spt_${ord}`, ord, title: `${ord}부`, goalText: "", turningPoints: [], plannedEpisodeFrom: from, plannedEpisodeTo: to,
  characterStates: [], plotOutline: [], fieldOrigins: {}, updatedAt: T,
});
const structure = (over: Partial<StoryStructureDto> = {}): StoryStructureDto => ({
  id: "sst_1", novelId: "nov_1", status: "approved", revision: 2, approvedRevision: 2,
  ending: { worldState: "", conflictResolution: "", characterFinalStates: [], protagonistChange: { from: "", to: "" }, foreshadowPayoffs: [] },
  endingFieldOrigins: {}, firstAppearances: [], parts: [part(2, 6, 10), part(1, 1, 5), part(3, 11, 15), part(4, 16, 20)],
  pendingChanges: {}, approvalId: null, approvedAt: T, updatedAt: T, ...over,
});
const plot = (id: string, ord: number, partId: string | null, over: Partial<StructurePlotDto> = {}): StructurePlotDto => ({
  id, novelId: "nov_1", ord, title: id, goalText: "", conflictText: "", endCondition: "", plannedEpisodeFrom: 1, plannedEpisodeTo: 2,
  status: "planned", planApprovalId: null, arcApprovalId: null, pausedAt: null, partId, coreEvent: "", involvedCharacterIds: [], changeText: "",
  setupPlan: { plant: [], payoff: [] }, planFlags: [], createdAt: T, updatedAt: T, episodeCount: 0, planningStage: "outline", castGaps: null, replanApprovalId: null, ...over,
});
const ep = (arcId: string, episodeNo: number, lengthBelowFloor = false): StructureEpisodeDto => ({
  id: `epi_${episodeNo}`, arcId, episodeNo, title: null, status: "planned", planSummary: "", plannedSceneCount: 4, targetChars: 5000, lengthBelowFloor,
});
const view = (over: Partial<StructureView> = {}): StructureView => ({
  structure: structure(),
  gate: { canGenerate: true, reasons: [], codes: [], cast: { complete: true, items: [], message: "" } },
  task: null, lastError: null, plots: [], episodes: [], goal: null, ...over,
});

describe("buildTree (부 → 플롯 → 화)", () => {
  it("groups plots under parts by ord and episodes under plots by number", () => {
    const tree = buildTree(
      view({
        plots: [plot("arc_b", 2, "spt_1", { planFlags: ["ending_changed"] }), plot("arc_a", 1, "spt_1"), plot("arc_c", 3, "spt_2"), plot("arc_x", 4, null), plot("arc_gone", 5, "spt_1", { status: "cancelled" })],
        episodes: [ep("arc_a", 2), ep("arc_a", 1, true), ep("arc_c", 6)],
      }),
    );
    expect(tree.parts.map((p) => p.part.ord)).toEqual([1, 2, 3, 4]);
    const p1 = tree.parts[0]!;
    expect(p1.plots.map((n) => n.plot.id)).toEqual(["arc_a", "arc_b"]);
    expect(p1.plots[0]!.episodes.map((e) => e.episodeNo)).toEqual([1, 2]);
    expect(p1.plots[0]!.belowFloorCount).toBe(1);
    expect(p1.plots[1]!.flagged).toBe(true);
    expect(p1.flaggedPlots).toBe(1);
    expect(p1.plannedEpisodes).toBe(2);
    expect(tree.parts[1]!.plots.map((n) => n.plot.id)).toEqual(["arc_c"]);
    expect(tree.unassigned.map((n) => n.plot.id)).toEqual(["arc_x"]);
    expect(tree.cancelled.map((n) => n.plot.id)).toEqual(["arc_gone"]);
  });
  it("without a structure every live plot is unassigned", () => {
    const tree = buildTree(view({ structure: null, plots: [plot("arc_a", 1, null)] }));
    expect(tree.parts).toEqual([]);
    expect(tree.unassigned).toHaveLength(1);
  });
});

describe("status and step", () => {
  it("re-opened after approval = 재승인 필요", () => {
    expect(displayStatus(null)).toBe("none");
    expect(displayStatus(structure())).toBe("approved");
    expect(displayStatus(structure({ status: "awaiting_approval", approvedRevision: null }))).toBe("awaiting_approval");
    expect(displayStatus(structure({ status: "draft", approvedRevision: 1 }))).toBe("reapproval");
  });
  it("step card: cast gate first, then create / generating", () => {
    const incomplete = { complete: false, items: [], message: "x" };
    expect(structureStep(view({ structure: null, gate: { canGenerate: false, reasons: ["x"], codes: ["cast_incomplete"], cast: incomplete } }))).toBe("cast_incomplete");
    expect(structureStep(view({ structure: null, gate: { canGenerate: false, reasons: ["기획서"], codes: ["bible_not_approved"], cast: { complete: true, items: [], message: "" } } }))).toBe("blocked");
    expect(structureStep(view({ structure: null, gate: { canGenerate: false, reasons: ["컨셉", "x"], codes: ["concept_not_approved", "cast_incomplete"], cast: incomplete } }))).toBe("blocked");
    expect(structureStep(view({ structure: null }))).toBe("create");
    expect(structureStep(view({ structure: null, task: { id: "tsk_1", status: "running" } }))).toBe("generating");
  });
  it("pending change lines name the changed part", () => {
    const s = structure({ status: "draft", pendingChanges: { ending: true, partIds: ["spt_2"], goalEndingChanged: true } });
    expect(pendingChangeLines(s)).toEqual(["결말이 바뀌었습니다.", "2부가 바뀌었습니다.", "연재 목표의 결말 방향이 바뀌었습니다."]);
  });
  it("outline sum vs part range", () => {
    expect(outlineSumMismatch(1, 5, [{ episodeCount: 2 }, { episodeCount: 3 }])).toBeNull();
    expect(outlineSumMismatch(1, 5, [{ episodeCount: 2 }])).toContain("2화");
    expect(outlineSumMismatch(1, 5, [])).toBeNull();
  });
});

describe("partTitle", () => {
  it("drops an ordinal the model put in the title", () => {
    expect(partTitle("1부 — 다시 뜬 달")).toBe("다시 뜬 달");
    expect(partTitle("제2부: 계약자")).toBe("계약자");
    expect(partTitle("다시 뜬 달")).toBe("다시 뜬 달");
    expect(partTitle("1부")).toBe("1부");
  });
});
