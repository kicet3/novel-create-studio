import { describe, expect, it } from "vitest";
import { READER_SCENE_BREAK, type ReaderTocDto, type ReaderTocEpisodeDto } from "@ncs/shared";
import { READER_SCENE_BREAK as CORE_SCENE_BREAK, groupToc, partLabel, readableEpisodes } from "./reader-model.js";
const ep = (episodeNo: number, arcId: string, o: Partial<ReaderTocEpisodeDto> = {}): ReaderTocEpisodeDto => ({
  episodeNo,
  title: `${episodeNo}화`,
  status: "approved",
  arcId,
  approved: { source: "approved", charCount: 5000 + episodeNo },
  draft: null,
  ...o,
});

describe("groupToc", () => {
  const parts = [
    { id: "p2", ord: 2, title: "2부 · 균열" },
    { id: "p1", ord: 1, title: "각성" },
  ];
  const plots = [
    { id: "a1", ord: 1, title: "시작", partId: "p1" },
    { id: "a2", ord: 2, title: "추적", partId: "p1" },
    { id: "a3", ord: 3, title: "균열", partId: "p2" },
  ];
  const episodes = [
    ep(3, "a2"),
    ep(1, "a1", { status: "published", approved: { source: "published", charCount: 4100 } }),
    ep(2, "a1", { status: "revising", draft: { charCount: 4500 } }),
    ep(4, "a3", { status: "drafting", approved: null, draft: { charCount: 3900 } }),
    ep(5, "a3", { status: "planned", approved: null }),
    ep(6, "zzz"),
  ];
  const toc: Pick<ReaderTocDto, "parts" | "plots" | "episodes"> = { parts, plots, episodes };

  it("groups 부 → 플롯 → 화 in order, approved-only by default", () => {
    const g = groupToc(toc, "approved");
    expect(g.map((x) => x.part?.id ?? null)).toEqual(["p1", null]); // p2 has nothing approved; orphans last
    expect(g[0]!.plots.map((p) => [p.plot?.id, p.rows.map((r) => r.episodeNo)])).toEqual([
      ["a1", [1, 2]],
      ["a2", [3]],
    ]);
    expect(g[0]!.plots[0]!.rows[0]).toMatchObject({ kind: "published", charCount: 4100 });
    expect(g[0]!.plots[0]!.rows[1]).toMatchObject({ kind: "approved", charCount: 5002 });
    expect(g[1]!.plots).toEqual([{ plot: null, rows: [expect.objectContaining({ episodeNo: 6 })] }]);
  });

  it("draft mode adds drafts (marked) and prefers the draft over the approved text", () => {
    const g = groupToc(toc, "draft");
    expect(g.map((x) => x.part?.id ?? null)).toEqual(["p1", "p2", null]);
    expect(g[0]!.plots[0]!.rows[1]).toMatchObject({ episodeNo: 2, kind: "draft", charCount: 4500 });
    expect(g[1]!.plots[0]!.rows.map((r) => [r.episodeNo, r.kind])).toEqual([[4, "draft"]]);
    expect(readableEpisodes(toc, "draft").map((r) => r.episodeNo)).toEqual([1, 2, 3, 4, 6]);
  });

  it("is flat without parts and with a single plot; plots are the top level without parts", () => {
    const flat = groupToc({ parts: [], plots: [plots[0]!], episodes: [ep(2, "a1"), ep(1, "a1")] }, "approved");
    expect(flat).toEqual([{ part: null, plots: [{ plot: null, rows: [expect.objectContaining({ episodeNo: 1 }), expect.objectContaining({ episodeNo: 2 })] }] }]);
    const byPlot = groupToc({ parts: [], plots, episodes: [ep(1, "a1"), ep(3, "a3")] }, "approved");
    expect(byPlot).toHaveLength(1);
    expect(byPlot[0]!.plots.map((p) => p.plot?.id)).toEqual(["a1", "a3"]);
    expect(groupToc({ parts, plots, episodes: [ep(9, "a1", { approved: null })] }, "approved")).toEqual([]);
  });

  it("labels parts without duplicating the number", () => {
    expect(partLabel({ ord: 1, title: "각성" })).toBe("1부 · 각성");
    expect(partLabel({ ord: 2, title: "2부 · 균열" })).toBe("2부 · 균열");
    expect(partLabel({ ord: 3, title: " " })).toBe("3부");
  });
});

describe("reader-core contract", () => {
  it("uses the same scene break line as the reader DTO", () => {
    expect(CORE_SCENE_BREAK).toBe(READER_SCENE_BREAK);
  });
});
