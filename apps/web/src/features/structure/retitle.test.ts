import { describe, expect, it } from "vitest";
import type { RetitleItem } from "@ncs/shared";
import { retitleNeedsConfirm, retitlePreview, retitleSplitWarnings, retitleSummary } from "./RetitleDialog.js";

const item = (episodeNo: number, over: Partial<RetitleItem> = {}): RetitleItem => ({
  episodeNo,
  status: "planned",
  before: `${episodeNo}화 제목`,
  after: `묶음 (${episodeNo})`,
  unitTitle: "묶음",
  unitPartNo: episodeNo,
  unitPartCount: 3,
  published: false,
  willRename: true,
  unchanged: false,
  excluded: false,
  ...over,
});

describe("제목 정리 dialog model", () => {
  const units = [{ title: "묶음", from: 1, to: 3 }];
  const items = [item(1, { status: "published", published: true, before: "다시 뜬 눈" }), item(2), item(3, { before: "묶음 (3)" })];

  it("a kept published 화 leaves the 묶음, which restarts at (1); ticking it renumbers the rest", () => {
    const kept = retitlePreview(units, items, new Set());
    expect(kept.map((i) => [i.episodeNo, i.after, i.willRename, i.excluded])).toEqual([
      [1, "묶음 (1)", false, true],
      [2, "묶음 (1)", true, false],
      [3, "묶음 (2)", true, false],
    ]);
    expect(retitleSummary(kept)).toEqual({ rename: 2, keptPublished: 1, unchanged: 0 });
    expect(retitleSplitWarnings(kept)[0]).toContain("2화부터 (1)");

    const all = retitlePreview(units, items, new Set([1]));
    expect(all.map((i) => [i.episodeNo, i.after, i.willRename])).toEqual([
      [1, "묶음 (1)", true],
      [2, "묶음 (2)", true],
      [3, "묶음 (3)", false],
    ]);
    expect(retitleSummary(all)).toEqual({ rename: 2, keptPublished: 0, unchanged: 1 });
    expect(retitleSplitWarnings(all)).toEqual([]);
  });

  it("a published 화 whose title is the 묶음 title stays its first part", () => {
    const fit = retitlePreview([{ title: "다시 뜬 눈", from: 1, to: 3 }], items, new Set());
    expect(fit.map((i) => i.after)).toEqual(["다시 뜬 눈", "다시 뜬 눈 (2)", "다시 뜬 눈 (3)"]);
    expect(fit[0]).toMatchObject({ excluded: false, unchanged: true, unitPartNo: 1 });
  });

  it("ticking a published 화 needs the confirmation", () => {
    expect(retitleNeedsConfirm(new Set())).toBe(false);
    expect(retitleNeedsConfirm(new Set([1]))).toBe(true);
  });
});
