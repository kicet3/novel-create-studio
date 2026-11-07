/**
 * 읽기(reader) — pure viewer math: page geometry, page index / ratio, scroll anchors,
 * tap zones, swipes and keyboard mapping. No DOM access: callers pass measured numbers.
 */
import { clamp01, type ReaderView, type ReadingAnchor } from "./reader-model.js";

// ── page geometry ───────────────────────────────────────────────────────
export interface PageGeometry {
  /** text box of one page (px, integers: fractional column widths drift over many pages) */
  width: number;
  height: number;
  /** hidden gap between pages (columns) */
  gap: number;
  /** offset of the page box inside the viewport */
  left: number;
  top: number;
}

export interface PageGeometryInput {
  viewportWidth: number;
  viewportHeight: number;
  fontPx: number;
  /** max line length in em (좌우 여백 on wide screens) */
  maxEm: number;
  /** side padding in px (좌우 여백 on phones) */
  sidePad: number;
  /** room for the faint running header / page number */
  topPad?: number;
  bottomPad?: number;
}

export function pageGeometry({ viewportWidth, viewportHeight, fontPx, maxEm, sidePad, topPad = 44, bottomPad = 44 }: PageGeometryInput): PageGeometry {
  const width = Math.max(120, Math.floor(Math.min(viewportWidth - 2 * sidePad, maxEm * fontPx)));
  const height = Math.max(120, Math.floor(viewportHeight - topPad - bottomPad));
  return { width, height, gap: Math.max(32, 2 * sidePad), left: Math.max(0, Math.floor((viewportWidth - width) / 2)), top: topPad };
}

export const clampPage = (page: number, count: number) => Math.min(Math.max(0, count - 1), Math.max(0, Math.round(Number.isFinite(page) ? page : 0)));

/** 0..1 for the slider / resume; a single page counts as fully read */
export const pageRatio = (page: number, count: number) => (count <= 1 ? 1 : clamp01(page / (count - 1)));
export const pageForRatio = (ratio: number, count: number) => clampPage(clamp01(ratio) * (count - 1), count);
export const percentLabel = (ratio: number) => `${Math.round(clamp01(ratio) * 100)}%`;

/** the last page is the end card: reaching it (or the last text page before it) finishes the episode */
export const pageFinished = (page: number, count: number) => page >= Math.max(0, count - 2);

/** what 이전/다음 페이지 does at the edges: turn the page, or leave the episode */
export function pageStep(page: number, count: number, dir: "prev" | "next"): { page: number } | { episode: "prev" | "next" } {
  if (dir === "next") return page >= count - 1 ? { episode: "next" } : { page: page + 1 };
  return page <= 0 ? { episode: "prev" } : { page: page - 1 };
}

// ── anchors (scroll view; 페이지 넘김 maps anchors in reader-pages.ts) ──────
/**
 * Index of the first item for which `isAfter(i)` is true, assuming it is monotonic (false…false, true…true);
 * `count` when none is. Used to find the first block that reaches a page / the viewport top in O(log n) measurements.
 */
export function firstIndex(count: number, isAfter: (i: number) => boolean): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (isAfter(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** scroll view: the paragraph crossing `y` (top of the reading area) and how far into it `y` is */
export function scrollAnchorAt(blocks: ReadonlyArray<{ top: number; height: number }>, y: number): ReadingAnchor {
  if (!blocks.length || y <= blocks[0]!.top) return { para: 0, offset: 0 };
  const i = Math.max(0, firstIndex(blocks.length, (k) => blocks[k]!.top + blocks[k]!.height > y));
  const b = blocks[Math.min(i, blocks.length - 1)]!;
  return { para: Math.min(i, blocks.length - 1), offset: b.height > 0 ? clamp01((y - b.top) / b.height) : 0 };
}

export const scrollYForAnchor = (block: { top: number; height: number }, offset: number) => Math.round(block.top + clamp01(offset) * block.height);

// ── input ───────────────────────────────────────────────────────────────
export type TapAction = "prev" | "next" | "menu";

/** page view: left / right third = 이전 / 다음 페이지, center = 메뉴; scroll view: everywhere = 메뉴 */
export function tapZone(x: number, width: number, view: ReaderView, edge = 1 / 3): TapAction {
  if (view === "scroll" || width <= 0) return "menu";
  const e = Math.min(0.45, Math.max(0.1, edge));
  if (x < width * e) return "prev";
  if (x > width * (1 - e)) return "next";
  return "menu";
}

/** a horizontal drag ends as a page turn when it is long enough or quick enough (flick) */
export function swipeAction(dx: number, dy: number, dtMs: number, width: number): "prev" | "next" | null {
  const ax = Math.abs(dx);
  if (ax < 12 || Math.abs(dy) > ax) return null;
  const far = ax >= Math.min(90, Math.max(40, width * 0.18));
  const flick = ax >= 24 && dtMs > 0 && ax / dtMs > 0.35;
  if (!far && !flick) return null;
  return dx < 0 ? "next" : "prev";
}

/** drag offset applied while dragging: rubber-band at the first / last page */
export const dragOffset = (dx: number, page: number, count: number) => ((dx > 0 && page <= 0) || (dx < 0 && page >= count - 1) ? dx * 0.35 : dx);

export type KeyAction = "prevPage" | "nextPage" | "prevEpisode" | "nextEpisode" | "escape" | "menu";

/** keyboard: page view turns pages (←/→, PageUp/PageDown, Space / Shift+Space); scroll view keeps native scrolling and uses ←/→ for 이전화/다음화 */
/** Enter / M toggle the bars (keyboard and screen-reader users have no center tap) */
export function keyAction(key: string, shift: boolean, view: ReaderView): KeyAction | null {
  if (key === "Escape") return "escape";
  if (!shift && (key === "Enter" || key === "m" || key === "M" || key === "ㅡ")) return "menu";
  if (view === "page") {
    if (key === "ArrowLeft" || key === "PageUp") return "prevPage";
    if (key === "ArrowRight" || key === "PageDown") return "nextPage";
    if (key === " " || key === "Spacebar") return shift ? "prevPage" : "nextPage";
    return null;
  }
  if (shift) return null;
  if (key === "ArrowLeft") return "prevEpisode";
  if (key === "ArrowRight") return "nextEpisode";
  return null;
}
