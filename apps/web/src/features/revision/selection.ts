/**
 * [이 부분 묻기]: the selected passage of the episode text as an anchor. The text pane renders the version content as
 * ONE text node, so DOM offsets equal JS string indices of the content (the server re-locates the quote anyway).
 */
export interface PassageAnchor {
  versionId: string;
  quote: string;
  start: number;
  end: number;
}

export const MAX_ANCHOR_CHARS = 3000;

/** trims whitespace at both ends of [start, end) and caps the length; null when nothing meaningful is selected */
export function anchorFromRange(content: string, versionId: string, start: number, end: number): PassageAnchor | null {
  let s = Math.max(0, Math.min(start, end));
  let e = Math.min(content.length, Math.max(start, end));
  while (s < e && /\s/u.test(content[s]!)) s++;
  while (e > s && /\s/u.test(content[e - 1]!)) e--;
  if (e - s < 2) return null;
  if (e - s > MAX_ANCHOR_CHARS) e = s + MAX_ANCHOR_CHARS;
  return { versionId, quote: content.slice(s, e), start: s, end: e };
}

/** offsets of the current selection inside `container` (null when the selection is elsewhere / collapsed) */
export function selectionOffsets(container: HTMLElement, sel: Selection | null): { start: number; end: number } | null {
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const r = sel.getRangeAt(0);
  if (!container.contains(r.startContainer) || !container.contains(r.endContainer)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(container);
  pre.setEnd(r.startContainer, r.startOffset);
  const start = pre.toString().length;
  return { start, end: start + r.toString().length };
}

export function clipQuote(q: string, n = 80): string {
  const one = q.replace(/\s+/gu, " ");
  return one.length > n ? `${one.slice(0, n)}…` : one;
}
