/** 설계 추가 0008 — pure rules: cast completeness, structure normalization / ranges / transitions, length helpers. */
import { describe, expect, it } from "vitest";
import { castCompleteness, EMPTY_PROFILE, type CompletenessMember } from "../../src/modules/cast/domain/cast.js";
import {
  applyPartRangeEdit,
  assertStructureTransition,
  distribute,
  mergeAgentFields,
  normalizeStructure,
  structureCompleteness,
  validatePartRanges,
} from "../../src/modules/novel/domain/structure.js";
import { checkLength, continuationNeeded, guardSceneLength } from "../../src/modules/manuscript/domain/text.js";

const FULL = { age: "17", appearance: "a", personality: "p", desire: "d", motivation: "m", weakness: "w", background: "b", speechSample: "s", arcStart: "x", arcEnd: "y", storyRole: "" };
const member = (id: string, role: CompletenessMember["role"], over: Partial<CompletenessMember> = {}): CompletenessMember => ({
  ...EMPTY_PROFILE,
  ...FULL,
  id,
  role,
  name: id,
  status: "confirmed",
  proposed: false,
  introducedArcId: null,
  relationships: [],
  ...over,
});

describe("cast completeness", () => {
  it("lists missing protagonist fields with Korean labels and builds the gate message", () => {
    const r = castCompleteness([member("한결", "protagonist", { motivation: " ", speechSample: "" })], { scope: "initial" });
    expect(r.complete).toBe(false);
    expect(r.items[0]!.missing.map((m) => m.label)).toEqual(["동기", "말투 예시"]);
    expect(r.message).toBe("전체 구성을 만들기 전에 캐릭터 설정을 보완하세요. 한결: 동기, 말투 예시");
  });
  it("sub-protagonist needs a relation to the protagonist in either direction; supporting needs role/goal/relation", () => {
    const hero = member("한결", "protagonist");
    const sub = member("서린", "sub_protagonist");
    let r = castCompleteness([hero, sub], { scope: "initial" });
    expect(r.items.map((i) => [i.name, i.missing.map((m) => m.field)])).toEqual([["한결", ["relationships"]], ["서린", ["relationToProtagonist"]]]);
    r = castCompleteness([{ ...hero, relationships: [{ targetCharacterId: "서린" }] }, sub], { scope: "initial" });
    expect(r.complete).toBe(true);
    const side = member("도윤", "supporting", { storyRole: "", desire: "", relationships: [{ targetCharacterId: "한결" }] });
    r = castCompleteness([hero, side], { scope: "initial" });
    expect(r.items[0]!.missing.map((m) => m.field)).toEqual(["storyRole", "desire"]);
  });
  it("unconfirmed counts as incomplete; initial vs arc scope; no protagonist", () => {
    const hero = member("한결", "protagonist", { status: "draft" });
    expect(castCompleteness([hero], { scope: "initial" }).items[0]!.unconfirmed).toBe(true);
    const plot = member("도윤", "antagonist", { introducedArcId: "arc_1", proposed: true, status: "draft", storyRole: "악역", relationships: [{ targetCharacterId: "한결" }] });
    expect(castCompleteness([member("한결", "protagonist"), plot], { scope: "initial" }).complete).toBe(true);
    const arc = castCompleteness([member("한결", "protagonist"), plot], { scope: "arc", arcId: "arc_1" });
    expect(arc.items[0]).toMatchObject({ name: "도윤", unconfirmed: true, missing: [] });
    expect(castCompleteness([member("한결", "protagonist"), { ...plot, proposed: false }], { scope: "arc", arcId: "arc_1" }).complete).toBe(true);
    expect(castCompleteness([], { scope: "initial" }).message).toContain("주인공이 없습니다");
  });
});

describe("story structure rules", () => {
  const part = (ord: number, from: number, to: number, plots = [{ title: `p${ord}`, coreEvent: "", episodeCount: to - from + 1 }]) => ({
    ord,
    title: `${ord}부`,
    goalText: "목표",
    turningPoints: [],
    plannedEpisodeFrom: from,
    plannedEpisodeTo: to,
    characterStates: [],
    plotOutline: plots,
  });
  it("normalizeStructure: 4 contiguous parts, plot counts sum to the part, unknown ids dropped, too short refused", () => {
    const n = normalizeStructure(
      {
        ending: { characterFinalStates: [{ characterId: "chr_ok", finalState: "끝" }, { characterId: "chr_bad", finalState: "x" }] },
        parts: [part(2, 0, 0), part(1, 1, 5, [{ title: "a", coreEvent: "", episodeCount: 1 }, { title: "b", coreEvent: "", episodeCount: 3 }])],
        firstAppearances: [{ characterId: "chr_ok", episodeNo: 3 }, { characterId: "chr_bad", episodeNo: 1 }, { characterId: "chr_ok", episodeNo: 99 }],
      },
      { total: 12, characterIds: ["chr_ok"] },
    );
    expect(n.parts.map((p) => [p.ord, p.plannedEpisodeFrom, p.plannedEpisodeTo])).toEqual([[1, 1, 5], [2, 6, 6], [3, 7, 9], [4, 10, 12]]);
    expect(n.parts[0]!.plotOutline.map((p) => p.episodeCount)).toEqual([2, 3]);
    expect(n.parts.every((p) => p.plotOutline.reduce((s, x) => s + x.episodeCount, 0) === p.plannedEpisodeTo - p.plannedEpisodeFrom + 1)).toBe(true);
    expect(n.ending.characterFinalStates).toHaveLength(1);
    expect(n.firstAppearances).toEqual([{ characterId: "chr_ok", episodeNo: 3 }]);
    expect(() => normalizeStructure({ ending: {}, parts: [], firstAppearances: [] }, { total: 3, characterIds: [] })).toThrow(/4화 이상/);
  });
  it("distribute keeps ≥1 per plot and the exact sum", () => {
    expect(distribute(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(distribute(2, [5, 5, 5])).toEqual([1, 1]);
  });
  it("validatePartRanges / applyPartRangeEdit move the neighbour boundary and reject gaps", () => {
    const ranges = [1, 2, 3, 4].map((ord) => ({ id: `p${ord}`, ord, plannedEpisodeFrom: (ord - 1) * 3 + 1, plannedEpisodeTo: ord * 3 }));
    expect(validatePartRanges(ranges)).toBeNull();
    expect(validatePartRanges([{ ...ranges[0]!, plannedEpisodeFrom: 2 }, ...ranges.slice(1)])).toMatch(/이어져야/);
    const moved = applyPartRangeEdit(ranges, "p1", { to: 4 });
    expect(moved.map((r) => [r.plannedEpisodeFrom, r.plannedEpisodeTo])).toEqual([[1, 4], [5, 6], [7, 9], [10, 12]]);
    expect(() => applyPartRangeEdit(ranges, "p2", { to: 2 })).toThrow(/이어져야/);
  });
  it("structureCompleteness reports Korean reasons; ST1–ST5 and an illegal transition (409)", () => {
    const reasons = structureCompleteness(
      { ending: {}, parts: [part(1, 1, 3), part(2, 4, 6), part(3, 7, 9), { ...part(4, 10, 12), title: "" }] },
      { mainCharacters: [{ id: "chr_a", name: "한결" }], totalMin: 12, totalMax: 12 },
    );
    expect(reasons).toEqual(expect.arrayContaining(["4부 제목이 비어 있습니다.", "결말: 한결의 최종 상태가 없습니다.", "결말: 세계·갈등의 최종 상태가 비어 있습니다."]));
    expect(assertStructureTransition("draft", "awaiting_approval").id).toBe("ST1");
    expect(assertStructureTransition("awaiting_approval", "approved").id).toBe("ST2");
    expect(assertStructureTransition("awaiting_approval", "draft").id).toBe("ST3");
    expect(assertStructureTransition("approved", "draft").id).toBe("ST4");
    expect(assertStructureTransition("awaiting_approval", "draft", "ST5").id).toBe("ST5");
    expect(() => assertStructureTransition("draft", "approved")).toThrow(expect.objectContaining({ status: 409 }));
  });
  it("mergeAgentFields keeps non-empty user fields", () => {
    const m = mergeAgentFields({ title: "작가 제목", goalText: "" }, { title: "user", goalText: "user" }, { title: "AI 제목", goalText: "AI 목표" });
    expect(m.values).toEqual({ title: "작가 제목", goalText: "AI 목표" });
    expect(m.skipped).toEqual(["title"]);
    expect(m.origins.goalText).toBe("agent");
  });
});

describe("length floor helpers", () => {
  it("checkLength.belowFloor by count basis", () => {
    const text = "가 ".repeat(1600); // 3200 with spaces, 1600 without
    expect(checkLength(text, { minChars: 3000, maxChars: 5500, countBasis: "with_spaces" })).toMatchObject({ belowFloor: false, hardMinChars: 3000 });
    expect(checkLength(text, { minChars: 3000, maxChars: 5500, countBasis: "without_spaces" })).toMatchObject({ belowFloor: true, deviation: "short", count: 1600 });
  });
  it("continuationNeeded stops at the minimum, the attempt cap and small growth", () => {
    expect(continuationNeeded(4000, 5000, 0, 2, null, 200)).toBe(true);
    expect(continuationNeeded(5000, 5000, 0, 2, null, 200)).toBe(false);
    expect(continuationNeeded(4000, 5000, 2, 2, 500, 200)).toBe(false);
    expect(continuationNeeded(4000, 5000, 1, 2, 199, 200)).toBe(false);
    expect(continuationNeeded(4000, 5000, 1, 2, 200, 200)).toBe(true);
  });
  it("guardSceneLength keeps the original only when a shorter scene would break the floor", () => {
    expect(guardSceneLength({ originalSceneCount: 1500, newSceneCount: 100, projectedTotal: 2900, floor: 3000 })).toBe("keep_original");
    expect(guardSceneLength({ originalSceneCount: 1500, newSceneCount: 1400, projectedTotal: 5000, floor: 3000 })).toBe("keep_new");
    expect(guardSceneLength({ originalSceneCount: 100, newSceneCount: 200, projectedTotal: 2000, floor: 3000 })).toBe("keep_new");
  });
});
