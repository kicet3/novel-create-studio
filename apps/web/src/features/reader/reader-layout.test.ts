import { describe, expect, it } from "vitest";
import {
  clampPage,
  dragOffset,
  firstIndex,
  keyAction,
  pageFinished,
  pageForRatio,
  pageGeometry,
  pageRatio,
  pageStep,
  percentLabel,
  scrollAnchorAt,
  scrollYForAnchor,
  swipeAction,
  tapZone,
} from "./reader-layout.js";

describe("page geometry", () => {
  it("fits a phone edge to edge minus the side margin", () => {
    const g = pageGeometry({ viewportWidth: 390, viewportHeight: 844, fontPx: 18, maxEm: 35, sidePad: 22, topPad: 52, bottomPad: 52 });
    expect(g).toEqual({ width: 346, height: 740, gap: 44, left: 22, top: 52 });
  });

  it("caps the line length on wide screens and centers the page; widths are integers", () => {
    const g = pageGeometry({ viewportWidth: 1280, viewportHeight: 900, fontPx: 18.5, maxEm: 35, sidePad: 22 });
    expect(g.width).toBe(647); // floor(35 × 18.5)
    expect(Number.isInteger(g.width) && Number.isInteger(g.left)).toBe(true);
    expect(g.left).toBe(Math.floor((1280 - 647) / 2));
    expect(g.height).toBe(900 - 44 - 44);
    // a wider margin setting = narrower column
    expect(pageGeometry({ viewportWidth: 1280, viewportHeight: 900, fontPx: 18, maxEm: 29, sidePad: 34 }).width).toBeLessThan(g.width);
  });

  it("never collapses on tiny windows", () => {
    const g = pageGeometry({ viewportWidth: 100, viewportHeight: 90, fontPx: 18, maxEm: 35, sidePad: 34 });
    expect(g.width).toBeGreaterThanOrEqual(120);
    expect(g.height).toBeGreaterThanOrEqual(120);
  });
});

describe("pagination math", () => {
  it("converts between pages, ratios and labels", () => {
    expect(clampPage(-2, 48)).toBe(0);
    expect(clampPage(60, 48)).toBe(47);
    expect(clampPage(Number.NaN, 48)).toBe(0);
    expect(clampPage(3, 0)).toBe(0);
    expect(pageRatio(0, 48)).toBe(0);
    expect(pageRatio(47, 48)).toBe(1);
    expect(pageRatio(0, 1)).toBe(1);
    expect(pageForRatio(0.5, 49)).toBe(24);
    expect(pageForRatio(2, 48)).toBe(47);
    expect(percentLabel(0.374)).toBe("37%");
  });

  it("finishes at the last text page and leaves the episode past the edges", () => {
    expect(pageFinished(45, 48)).toBe(false);
    expect(pageFinished(46, 48)).toBe(true);
    expect(pageFinished(0, 1)).toBe(true);
    expect(pageStep(3, 48, "next")).toEqual({ page: 4 });
    expect(pageStep(3, 48, "prev")).toEqual({ page: 2 });
    expect(pageStep(47, 48, "next")).toEqual({ episode: "next" });
    expect(pageStep(0, 48, "prev")).toEqual({ episode: "prev" });
  });
});

describe("anchors (resume across views / re-pagination)", () => {
  it("an anchor taken in scroll view is the paragraph + share of it at the reading line", () => {
    const blocks = Array.from({ length: 12 }, (_, i) => ({ top: 100 + i * 200, height: 200 }));
    const a = scrollAnchorAt(blocks, 100 + 7 * 200 + 150);
    expect(a).toEqual({ para: 7, offset: 0.75 });
    expect(scrollYForAnchor(blocks[7]!, a.offset)).toBe(100 + 7 * 200 + 150);
  });

  it("finds the paragraph at the reading line in O(log n)", () => {
    const blocks = [
      { top: 50, height: 100 },
      { top: 150, height: 20 },
      { top: 170, height: 300 },
    ];
    expect(scrollAnchorAt(blocks, 0)).toEqual({ para: 0, offset: 0 }); // above the text = start
    expect(scrollAnchorAt(blocks, 150)).toEqual({ para: 1, offset: 0 });
    expect(scrollAnchorAt(blocks, 9999)).toEqual({ para: 2, offset: 1 });
    expect(scrollAnchorAt([], 10)).toEqual({ para: 0, offset: 0 });
    let calls = 0;
    const n = 1000;
    expect(firstIndex(n, (i) => (calls++, i >= 637))).toBe(637);
    expect(calls).toBeLessThanOrEqual(11);
    expect(firstIndex(5, () => false)).toBe(5);
    expect(firstIndex(0, () => true)).toBe(0);
  });
});

describe("tap zones, swipes and keys", () => {
  it("page view: left / center / right thirds; scroll view: menu everywhere", () => {
    expect(tapZone(20, 390, "page")).toBe("prev");
    expect(tapZone(116, 390, "page")).toBe("prev");
    expect(tapZone(195, 390, "page")).toBe("menu");
    expect(tapZone(370, 390, "page")).toBe("next");
    // desktop: the edges of the window still turn pages
    expect(tapZone(100, 1280, "page")).toBe("prev");
    expect(tapZone(1200, 1280, "page")).toBe("next");
    expect(tapZone(640, 1280, "page")).toBe("menu");
    expect(tapZone(20, 390, "scroll")).toBe("menu");
    expect(tapZone(20, 0, "page")).toBe("menu");
    expect(tapZone(50, 100, "page", 0.9)).toBe("menu"); // edge clamped to 45%
  });

  it("swipes turn pages when long or quick enough; vertical drags do not", () => {
    expect(swipeAction(-120, 10, 300, 346)).toBe("next");
    expect(swipeAction(120, 10, 300, 346)).toBe("prev");
    expect(swipeAction(-30, 0, 60, 346)).toBe("next"); // flick
    expect(swipeAction(-30, 0, 400, 346)).toBeNull(); // slow + short
    expect(swipeAction(-80, 120, 200, 346)).toBeNull(); // mostly vertical
    expect(swipeAction(-8, 0, 10, 346)).toBeNull();
    expect(dragOffset(50, 0, 10)).toBe(17.5); // rubber band at the first page
    expect(dragOffset(-50, 9, 10)).toBe(-17.5);
    expect(dragOffset(-50, 3, 10)).toBe(-50);
  });

  it("maps keys per view", () => {
    expect(keyAction("ArrowRight", false, "page")).toBe("nextPage");
    expect(keyAction("ArrowLeft", false, "page")).toBe("prevPage");
    expect(keyAction(" ", false, "page")).toBe("nextPage");
    expect(keyAction(" ", true, "page")).toBe("prevPage");
    expect(keyAction("PageDown", false, "page")).toBe("nextPage");
    expect(keyAction("ArrowRight", false, "scroll")).toBe("nextEpisode");
    expect(keyAction("ArrowLeft", false, "scroll")).toBe("prevEpisode");
    expect(keyAction(" ", false, "scroll")).toBeNull(); // native scrolling
    expect(keyAction("ArrowRight", true, "scroll")).toBeNull();
    expect(keyAction("Escape", false, "scroll")).toBe("escape");
    expect(keyAction("a", false, "page")).toBeNull();
    // keyboard / screen reader: open and close the bars without a center tap
    expect(keyAction("Enter", false, "page")).toBe("menu");
    expect(keyAction("Enter", false, "scroll")).toBe("menu");
    expect(keyAction("m", false, "scroll")).toBe("menu");
    expect(keyAction("ㅡ", false, "page")).toBe("menu"); // M on a Korean keyboard layout
    expect(keyAction("Enter", true, "page")).toBeNull();
  });
});
