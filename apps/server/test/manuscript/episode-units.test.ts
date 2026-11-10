/**
 * 설계 추가 0023 — 에피소드 묶음 (pure): title formatting "제목 (n)" (bare for a single-화 묶음), the planner / retitle
 * output check (contiguous coverage, no gaps / overlaps), deterministic normalization and the before → after plan of a
 * 제목 정리 (published 화 keep their title unless the author includes them).
 */
import { describe, expect, it } from "vitest";
import { cleanUnitTitle, formatUnitEpisodeTitle } from "@ncs/shared";
import { assignStoryEpisodes, normalizeStoryEpisodes, pinnedGroupIssues, planRetitle, storyEpisodeIssues, titlesOfGroups } from "../../src/modules/manuscript/domain/episode-units.js";

const none = { titleOf: () => null, plotTitle: "플롯" };

describe("title formatting", () => {
  it("multi-part 묶음 → 「제목 (n)」, single-화 묶음 → bare title", () => {
    expect(formatUnitEpisodeTitle("칼 하나로 막을 수 없는 것", 1, 3)).toBe("칼 하나로 막을 수 없는 것 (1)");
    expect(formatUnitEpisodeTitle("칼 하나로 막을 수 없는 것", 3, 3)).toBe("칼 하나로 막을 수 없는 것 (3)");
    expect(formatUnitEpisodeTitle("F급의 검", 1, 1)).toBe("F급의 검");
  });

  it("strips part markers the model may add to a 묶음 title", () => {
    expect(cleanUnitTitle("강등된 방패 (2)")).toBe("강등된 방패");
    expect(cleanUnitTitle("「강등된 방패」")).toBe("강등된 방패");
    expect(cleanUnitTitle("강등된 방패 - 3화")).toBe("강등된 방패");
    expect(cleanUnitTitle("강등된 방패 제3화")).toBe("강등된 방패");
    expect(cleanUnitTitle("강등된 방패 - 2")).toBe("강등된 방패");
    expect(cleanUnitTitle("  ")).toBe("");
  });

  it("keeps quotes / brackets that do not wrap the whole title, and a bare 'N화' that is part of the title", () => {
    expect(cleanUnitTitle("「검」의 주인")).toBe("「검」의 주인");
    expect(cleanUnitTitle("주인의 「검」")).toBe("주인의 「검」");
    expect(cleanUnitTitle('"F급"의 검')).toBe('"F급"의 검');
    expect(cleanUnitTitle("『「검」의 주인』")).toBe("『「검」의 주인』");
    expect(cleanUnitTitle("“강등된 방패”")).toBe("강등된 방패");
    expect(cleanUnitTitle("회귀자 100화")).toBe("회귀자 100화");
    expect(formatUnitEpisodeTitle("강등된 방패 (1)", 2, 2)).toBe("강등된 방패 (2)");
  });
});

describe("planning output validation (contiguity)", () => {
  it("accepts a contiguous cover of the plot range", () => {
    expect(storyEpisodeIssues([{ title: "A", from: 6, to: 8 }, { title: "B", from: 9, to: 9 }, { title: "C", from: 10, to: 11 }], 6, 11)).toEqual([]);
  });

  it("reports gaps, overlaps, out-of-range, empty titles and an empty list", () => {
    const gap = storyEpisodeIssues([{ title: "A", from: 1, to: 2 }, { title: "B", from: 4, to: 5 }], 1, 5);
    expect(gap.map((i) => i.problem).join(" ")).toContain("3~3화가 어느 묶음에도 들어 있지 않습니다");
    const overlap = storyEpisodeIssues([{ title: "A", from: 1, to: 3 }, { title: "B", from: 3, to: 5 }], 1, 5);
    expect(overlap.map((i) => i.problem).join(" ")).toContain("겹칩니다");
    const outside = storyEpisodeIssues([{ title: "A", from: 1, to: 7 }], 1, 5);
    expect(outside.map((i) => i.problem).join(" ")).toContain("벗어납니다");
    const tail = storyEpisodeIssues([{ title: "A", from: 1, to: 3 }], 1, 5);
    expect(tail.map((i) => i.problem).join(" ")).toContain("4~5화");
    expect(storyEpisodeIssues([{ title: " ", from: 1, to: 5 }], 1, 5)[0]!.problem).toContain("제목이 비어");
    expect(storyEpisodeIssues([], 1, 5)).toHaveLength(1);
  });

  it("flags a fragmented grouping (every 화 its own 묶음 = the old per-화 titles)", () => {
    const singles = [1, 2, 3, 4, 5].map((n) => ({ title: `T${n}`, from: n, to: n }));
    expect(storyEpisodeIssues(singles, 1, 5).map((i) => i.problem).join(" ")).toContain("1화짜리 묶음이 너무 많습니다");
    expect(storyEpisodeIssues([{ title: "A", from: 1, to: 2 }, { title: "B", from: 3, to: 3 }, { title: "C", from: 4, to: 5 }], 1, 5)).toEqual([]);
    expect(storyEpisodeIssues([{ title: "A", from: 1, to: 1 }, { title: "B", from: 2, to: 2 }, { title: "C", from: 3, to: 3 }], 1, 3)).toEqual([]); // short plot
  });

  it("normalizes a broken answer into a valid cover (clip, cut overlaps, join gaps)", () => {
    const g = normalizeStoryEpisodes(
      [
        { title: "B (1)", from: 3, to: 6 },
        { title: "A", from: 0, to: 3 },
        { title: "C", from: 8, to: 12 },
      ],
      1,
      10,
      none,
    );
    expect(g).toEqual([
      { title: "A", from: 1, to: 3, ord: 1 },
      { title: "B", from: 4, to: 7, ord: 2 },
      { title: "C", from: 8, to: 10, ord: 3 },
    ]);
    expect(storyEpisodeIssues(g, 1, 10)).toEqual([]);
  });

  it("without usable groups: consecutive 화 with the same title form a 묶음, others stay single (old titles kept)", () => {
    const titles: Record<number, string> = { 1: "다시 뜬 눈", 2: "기록관", 3: "기록관" };
    const g = normalizeStoryEpisodes([], 1, 3, { titleOf: (n) => titles[n] ?? null, plotTitle: "1부" });
    expect(g.map((x) => [x.title, x.from, x.to])).toEqual([
      ["다시 뜬 눈", 1, 1],
      ["기록관", 2, 3],
    ]);
    const t = titlesOfGroups(g);
    expect([1, 2, 3].map((n) => t.get(n)!.title)).toEqual(["다시 뜬 눈", "기록관 (1)", "기록관 (2)"]);
  });
});

describe("제목 정리 plan (mixed states)", () => {
  const groups = [
    { title: "회귀의 아침", from: 1, to: 2, ord: 1 },
    { title: "칼 하나로 막을 수 없는 것", from: 3, to: 5, ord: 2 },
  ];
  const eps = [
    { episodeNo: 1, status: "published" as const, title: "다시 뜬 눈" },
    { episodeNo: 2, status: "approved" as const, title: "기록관" },
    { episodeNo: 3, status: "drafting" as const, title: "칼 하나로 막을 수 없는 것" },
    { episodeNo: 4, status: "drafting" as const, title: "F급의 검과 강등된 방패" },
    { episodeNo: 5, status: "planned" as const, title: "칼 하나로 막을 수 없는 것 (3)" },
  ];

  it("renames only unpublished 화 by default; a kept published 화 leaves the 묶음, which restarts at (1)", () => {
    const items = planRetitle(groups, eps);
    expect(items.map((i) => [i.episodeNo, i.after, i.willRename, i.unchanged, i.excluded])).toEqual([
      [1, "회귀의 아침 (1)", false, false, true],
      [2, "회귀의 아침", true, false, false],
      [3, "칼 하나로 막을 수 없는 것 (1)", true, false, false],
      [4, "칼 하나로 막을 수 없는 것 (2)", true, false, false],
      [5, "칼 하나로 막을 수 없는 것 (3)", false, true, false],
    ]);
    expect(items[0]).toMatchObject({ published: true, unitTitle: null, unitPartNo: null });
    expect(items[1]).toMatchObject({ unitTitle: "회귀의 아침", unitPartNo: 1, unitPartCount: 1 });
  });

  it("a published 화 whose title is the 묶음 title stays its first part (「X」「X (2)」)", () => {
    const items = planRetitle([{ title: "다시 뜬 눈", from: 1, to: 2 }], eps.slice(0, 2));
    expect(items.map((i) => [i.after, i.willRename, i.excluded, i.unitPartNo])).toEqual([
      ["다시 뜬 눈", false, false, 1],
      ["다시 뜬 눈 (2)", true, false, 2],
    ]);
  });

  it("a published 화 the author includes is renamed", () => {
    const items = planRetitle(groups, eps, new Set([1]));
    expect(items.slice(0, 2).map((i) => [i.after, i.willRename])).toEqual([
      ["회귀의 아침 (1)", true],
      ["회귀의 아침 (2)", true],
    ]);
  });
});

describe("re-plan: written 화 keep their 묶음", () => {
  it("a written 화 that fits its place stays in the 묶음; one that does not is pinned and the 묶음 restarts after it", () => {
    const written = [
      { episodeNo: 6, title: "A (1)", renameable: false },
      { episodeNo: 7, title: "A (2)", renameable: false },
      { episodeNo: 8, title: "A (3)", renameable: true },
      { episodeNo: 9, title: "B", renameable: true },
    ];
    // same 묶음 kept and extended with the planned tail
    const same = assignStoryEpisodes([{ title: "A", from: 6, to: 9 }], written);
    expect([6, 7, 8, 9].map((n) => same.slots.get(n))).toMatchObject([
      { kind: "member", title: "A (1)", partNo: 1, rename: false },
      { kind: "member", title: "A (2)", partNo: 2, rename: false },
      { kind: "member", title: "A (3)", partNo: 3, rename: false },
      { kind: "member", title: "A (4)", partNo: 4, rename: true },
    ]);
    // the planner moved 7화 into 「B」: 7화 is pinned (keeps 「A (2)」), 8~9 form 「B」 from (1)
    const moved = assignStoryEpisodes([{ title: "A", from: 6, to: 6 }, { title: "B", from: 7, to: 9 }], written);
    expect(moved.slots.get(7)).toEqual({ kind: "pinned" });
    expect([8, 9].map((n) => moved.slots.get(n))).toMatchObject([
      { kind: "member", title: "B (1)", unitTitle: "B", partNo: 1, partCount: 2 },
      { kind: "member", title: "B (2)", partNo: 2, partCount: 2 },
    ]);
    expect(moved.segments.map((x) => [x.title, x.episodeNos])).toEqual([
      ["A", [6]],
      ["B", [8, 9]],
    ]);
  });

  it("the validator asks the planner to keep written 화 in place", () => {
    const w = [{ episodeNo: 7, title: "A (2)" }];
    expect(pinnedGroupIssues([{ title: "A", from: 6, to: 9 }], w)).toEqual([]);
    expect(pinnedGroupIssues([{ title: "B", from: 7, to: 9 }], w)[0]!.problem).toContain("7화는 이미 쓴 화라");
    expect(pinnedGroupIssues([{ title: "A", from: 7, to: 9 }], w)).toHaveLength(1); // 「A」 part 1 ≠ "A (2)"
  });
});
