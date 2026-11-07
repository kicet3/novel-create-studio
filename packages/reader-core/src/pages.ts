/**
 * 읽기(reader) — 페이지 넘김 pagination by character count. Pure: the screen check is an injected `fits`
 * callback (the viewer measures with a hidden element; tests pass fakes).
 *
 * A page holds about `maxChars` characters. Pages end at paragraph boundaries when the page is already
 * reasonably full; otherwise a paragraph is split at a sentence end (then at a space, never inside a word).
 * Illustrations (`image` blocks) get a page of their own; scene breaks never end a page.
 */
import { clamp01, type ReadingAnchor, type ReadingBlock } from "./model.js";

export type PageItem =
  /** a whole paragraph or a piece of one: characters [start, end) of the paragraph text (`len` = its length) */
  | { type: "text"; block: number; para: number; start: number; end: number; len: number; text: string }
  | { type: "break"; block: number }
  | { type: "image"; block: number };

export interface ReaderPage {
  items: PageItem[];
  /** text characters on the page */
  chars: number;
}

export interface PaginateOptions {
  /** target characters per page */
  maxChars: number;
  /** does the page (as it would render, `pageIndex` 0 also shows the episode title) fit the screen? default: yes */
  fits?: (items: readonly PageItem[], pageIndex: number) => boolean;
  /** a page at least this full (0..1) ends before a paragraph that does not fit instead of splitting it */
  paragraphSlack?: number;
}

const SENTENCE_END = /[.!?…。？！‼⁉]+[”’"'」』)\]〉》]*(?=\s|$)|[”"」』](?=\s)/g;

/** offsets right after each sentence end (trailing spaces included), ascending, excluding text.length */
export function sentenceBoundaries(text: string): number[] {
  const out: number[] = [];
  SENTENCE_END.lastIndex = 0;
  for (let m = SENTENCE_END.exec(text); m; m = SENTENCE_END.exec(text)) {
    let end = m.index + m[0].length;
    while (end < text.length && /\s/.test(text[end]!)) end++;
    if (end > 0 && end < text.length && out[out.length - 1] !== end) out.push(end);
  }
  return out;
}

/** offsets right after each run of spaces (word starts), ascending, excluding 0 and text.length */
export function wordBoundaries(text: string): number[] {
  const out: number[] = [];
  const re = /\s+/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const end = m.index + m[0].length;
    if (m.index > 0 && end < text.length) out.push(end);
  }
  return out;
}

export function paginateBlocks(blocks: readonly ReadingBlock[], { maxChars, fits = () => true, paragraphSlack = 0.6 }: PaginateOptions): ReaderPage[] {
  const max = Math.max(1, Math.floor(maxChars));
  const pages: ReaderPage[] = [];
  let cur: PageItem[] = [];
  let chars = 0;

  /** close the page; a trailing scene break moves to the top of the next page */
  const flush = (carryBreak = true) => {
    if (!cur.length) return;
    const last = cur[cur.length - 1]!;
    const carry = carryBreak && cur.length > 1 && last.type === "break" ? cur.pop()! : null;
    pages.push({ items: cur, chars });
    cur = carry ? [carry] : [];
    chars = 0;
  };
  /** could `item` (n chars) join the current page? */
  const canAdd = (item: PageItem, n: number) => chars + n <= max && fits([...cur, item], pages.length);
  const add = (item: PageItem, n: number) => {
    cur.push(item);
    chars += n;
  };

  let para = 0;
  blocks.forEach((b, block) => {
    if (b.type === "image") {
      flush(false);
      pages.push({ items: [{ type: "image", block }], chars: 0 });
      return;
    }
    if (b.type === "break") {
      const item: PageItem = { type: "break", block };
      if (!cur.length || !canAdd(item, 0)) flush();
      add(item, 0);
      return;
    }
    const text = b.text;
    const len = text.length;
    const p = para++;
    const piece = (start: number, end: number): PageItem => ({ type: "text", block, para: p, start, end, len, text: text.slice(start, end).trim() });
    const sentences = sentenceBoundaries(text);
    let words: number[] | null = null;
    let pos = 0;
    let guard = 0;
    while (pos < len && guard++ < 100_000) {
      const rest = piece(pos, len);
      if (canAdd(rest, len - pos)) {
        add(rest, len - pos);
        pos = len;
        break;
      }
      // the page is full enough: start the paragraph (or its rest) on a fresh page
      if (cur.some((i) => i.type === "text") && chars >= paragraphSlack * max) {
        flush();
        continue;
      }
      // the longest run of whole sentences that still fits
      let end = largestFitting(sentences, pos, (e) => canAdd(piece(pos, e), e - pos));
      if (end === null && !cur.some((i) => i.type === "text")) {
        // a single sentence longer than a page: split between words, else (no spaces at all) between characters
        words ??= wordBoundaries(text);
        end = largestFitting(words, pos, (e) => canAdd(piece(pos, e), e - pos));
        if (end === null) end = hardCut(pos, len, max, (e) => canAdd(piece(pos, e), e - pos));
      }
      if (end === null) {
        flush();
        continue;
      }
      add(piece(pos, end), end - pos);
      pos = end;
      flush();
    }
  });
  flush(false);
  return pages;
}

/** largest boundary after `pos` that passes `ok` (assumed monotonic: once one fails, longer ones fail too) */
function largestFitting(bounds: readonly number[], pos: number, ok: (end: number) => boolean): number | null {
  let best: number | null = null;
  for (const e of bounds) {
    if (e <= pos) continue;
    if (!ok(e)) break;
    best = e;
  }
  return best;
}

/** last resort for text without spaces: as many characters as fit (at least one) */
function hardCut(pos: number, len: number, max: number, ok: (end: number) => boolean): number {
  let lo = pos + 1;
  let hi = Math.min(len - 1, pos + max);
  if (hi < lo) return Math.min(len, pos + 1);
  if (!ok(lo)) return lo;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ok(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// ── anchors ↔ pages ─────────────────────────────────────────────────────
type TextItem = Extract<PageItem, { type: "text" }>;
const textItems = (page: ReaderPage | undefined) => (page?.items.filter((i): i is TextItem => i.type === "text") ?? []);

/**
 * reading position at the top of a page: the first paragraph piece on it (offset = share of the paragraph's
 * characters before it). A page without text (illustration) takes the next text, or the end of the previous one.
 */
export function anchorForPage(pages: readonly ReaderPage[], page: number): ReadingAnchor {
  if (!pages.length || page <= 0) return { para: 0, offset: 0 };
  const p = Math.min(page, pages.length - 1);
  for (let i = p; i < pages.length; i++) {
    const t = textItems(pages[i])[0];
    if (t) return { para: t.para, offset: t.len > 0 ? t.start / t.len : 0 };
  }
  for (let i = p - 1; i >= 0; i--) {
    const ts = textItems(pages[i]);
    const t = ts[ts.length - 1];
    if (t) return { para: t.para, offset: 1 };
  }
  return { para: 0, offset: 0 };
}

/** page holding an anchor (offset = share of the paragraph's characters, ≈ share of its height in 스크롤 보기) */
export function pageForAnchor(pages: readonly ReaderPage[], anchor: ReadingAnchor): number {
  if (!pages.length || (anchor.para <= 0 && anchor.offset <= 0)) return 0;
  let lastBefore = 0;
  for (let i = 0; i < pages.length; i++) {
    for (const t of textItems(pages[i])) {
      if (t.para < anchor.para) {
        lastBefore = i;
        continue;
      }
      if (t.para > anchor.para) return lastBefore;
      const at = Math.round(clamp01(anchor.offset) * t.len);
      if (at < t.end || t.end >= t.len) return i;
      lastBefore = i;
    }
  }
  return lastBefore;
}

// ── page counter / episode edges ────────────────────────────────────────
/** "3 / 12" over the text pages; the extra last page (end card) reads "끝" */
export function pageCounter(page: number, countWithEnd: number): string {
  const text = Math.max(1, countWithEnd - 1);
  return page >= text ? "끝" : `${Math.max(0, page) + 1} / ${text}`;
}

/** what turning past the first page / the end card opens: the previous episode at its last page, the next one at page 1 */
export function leaveTarget(
  dir: "prev" | "next",
  ep: { prev?: { episodeNo: number } | null; next?: { episodeNo: number } | null } | null | undefined,
): { episodeNo: number; at: "start" | "end" } | null {
  const t = dir === "next" ? ep?.next : ep?.prev;
  return t ? { episodeNo: t.episodeNo, at: dir === "next" ? "start" : "end" } : null;
}

/** conservative characters-per-screen estimate (no DOM): used before / without measuring */
export function estimatePageChars({ width, height, fontPx, lineHeight, paraSpacingEm = 0.9 }: { width: number; height: number; fontPx: number; lineHeight: number; paraSpacingEm?: number }): number {
  const perLine = Math.max(1, Math.floor(width / (fontPx * 1.02)));
  const lines = Math.max(1, Math.floor(height / (fontPx * lineHeight)));
  // ~ one paragraph gap per 3 lines and ragged line ends cost about a fifth
  const gapLines = (lines / 3) * (paraSpacingEm / lineHeight);
  return Math.max(40, Math.floor(perLine * Math.max(1, lines - gapLines) * 0.8));
}
