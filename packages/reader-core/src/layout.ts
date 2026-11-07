/**
 * 읽기(reader) — pure viewer math: page geometry, page index / ratio, scroll anchors,
 * tap zones, swipes and keyboard mapping. No DOM access: callers pass measured numbers.
 */
import { clamp01, type ReaderView, type ReadingAnchor } from "./model.js";

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

// ── single page vs. book spread (foldables, tablets) ─────────────────────
/** one display region from the Viewport Segments API (`window.viewport.segments`, CSS px) */
export interface ViewportSegment {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SpreadInput {
  viewportWidth: number;
  viewportHeight: number;
  /** `window.viewport?.segments` when available (null / undefined / one segment = a flat screen) */
  segments?: readonly ViewportSegment[] | null;
  /** minimum viewport width for two pages side by side (default 600, e.g. Galaxy Z Fold inner screen) */
  minSpreadWidth?: number;
  /** minimum width / height for two pages (default 0.75: near-square or landscape; tall phones stay single) */
  minSpreadAspect?: number;
}

export interface SpreadLayout {
  /** "spread" = two pages side by side (book), "single" = one page */
  mode: "single" | "spread";
  /** region the pages may use (px, viewport coordinates): the whole screen, or the top segment on a horizontal fold */
  area: { left: number; top: number; width: number; height: number };
  /** gap between the two pages of a spread (px) — the hinge width when the screen is folded side by side */
  gap: number;
  /** a physical fold runs through the screen (content and tap zones avoid it) */
  folded: "none" | "vertical-hinge" | "horizontal-hinge";
}

/**
 * Where pages go. Side-by-side segments (Fold half-open / dual screen) → one page per segment, the hinge as the gap.
 * Stacked segments (Flip half-folded "flex mode") → a single page in the top segment. Otherwise a spread when the
 * screen is wide and not tall (Fold inner screen, tablets, desktops), else a single page (phones, cover screens).
 */
export function spreadLayout({ viewportWidth, viewportHeight, segments, minSpreadWidth = 600, minSpreadAspect = 0.75 }: SpreadInput): SpreadLayout {
  const w = Math.max(0, viewportWidth);
  const h = Math.max(0, viewportHeight);
  const full = { left: 0, top: 0, width: w, height: h };
  const segs = (segments ?? []).filter((s) => s && s.width > 0 && s.height > 0);
  if (segs.length === 2) {
    const [a, b] = [...segs].sort((p, q) => p.x - q.x || p.y - q.y) as [ViewportSegment, ViewportSegment];
    if (Math.abs(a.y - b.y) < 1 && b.x > a.x) {
      return { mode: "spread", area: full, gap: Math.max(0, Math.round(b.x - (a.x + a.width))), folded: "vertical-hinge" };
    }
    const top = a.y <= b.y ? a : b;
    return { mode: "single", area: { left: top.x, top: top.y, width: top.width, height: top.height }, gap: 0, folded: "horizontal-hinge" };
  }
  const spread = w >= minSpreadWidth && h > 0 && w / h >= minSpreadAspect;
  return { mode: spread ? "spread" : "single", area: full, gap: spread ? Math.max(32, Math.round(w * 0.06)) : 0, folded: "none" };
}

/** first page shown on screen: a spread shows pages (2k, 2k+1) */
export const spreadStart = (page: number, spread: boolean) => (spread ? Math.max(0, page - (page % 2)) : Math.max(0, page));

/** pages moved by 이전/다음: two in a spread */
export const screenStep = (spread: boolean) => (spread ? 2 : 1);
