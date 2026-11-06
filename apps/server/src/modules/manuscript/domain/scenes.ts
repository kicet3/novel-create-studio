/**
 * Scene boundaries and scene-ID retention (07 §6, INV-SC-01/02). Pure.
 */
import { mapPosition, unchangedOverlap, type DiffOp } from "./diff.js";
import { paragraphSceneStarts, separatorSceneStarts } from "./text.js";

export interface Range {
  start: number;
  end: number;
}

/** starts → contiguous ranges covering [0, length) (INV-SC-02) */
export function rangesFromStarts(starts: readonly number[], length: number): Range[] {
  const s = [...new Set(starts.filter((x) => x >= 0 && x < Math.max(length, 1)))].sort((a, b) => a - b);
  if (s[0] !== 0) s.unshift(0);
  return s.map((start, i) => ({ start, end: i + 1 < s.length ? s[i + 1]! : length }));
}

export function coversContiguously(ranges: readonly Range[], length: number): boolean {
  let pos = 0;
  for (const r of ranges) {
    if (r.start !== pos || r.end < r.start) return false;
    pos = r.end;
  }
  return pos === length && ranges.length > 0;
}

/**
 * Writer `scene_breaks` → ranges. Valid only when they cover the outline scene keys in order,
 * start at 0 and are strictly increasing (07 §3.2 결정적 검사 (2), §6.1).
 */
export function rangesFromSceneBreaks(
  breaks: ReadonlyArray<{ outline_scene_key: string; char_start: number }>,
  outlineKeys: readonly string[],
  length: number,
): Range[] | null {
  if (!breaks.length) return null;
  if (outlineKeys.length && breaks.map((b) => b.outline_scene_key).join("\u0000") !== outlineKeys.join("\u0000")) return null;
  const starts = breaks.map((b) => b.char_start);
  if (starts[0] !== 0) return null;
  for (let i = 1; i < starts.length; i++) if (!(starts[i]! > starts[i - 1]!) || starts[i]! >= length) return null;
  return rangesFromStarts(starts, length);
}

/** deterministic fallback: explicit separators, else paragraph split into `expected` parts */
export function deterministicRanges(text: string, expected: number): Range[] {
  const sep = separatorSceneStarts(text);
  if (sep.length > 1) return rangesFromStarts(sep, text.length);
  return rangesFromStarts(paragraphSceneStarts(text, Math.max(1, expected)), text.length);
}

/**
 * Old boundaries moved through the diff (07 §6.1 다듬기·자동 수정·사람 편집). Returns null when a boundary
 * falls in a deleted region, a scene collapses to 0 chars, or a large insert (> 50% of the average scene
 * length) suggests re-estimation.
 */
export function mapRanges(old: readonly Range[], ops: readonly DiffOp[], newLength: number): Range[] | null {
  if (!old.length) return null;
  const starts: number[] = [];
  for (const [i, r] of old.entries()) {
    if (i === 0) {
      starts.push(0);
      continue;
    }
    const m = mapPosition(ops, r.start);
    if (!m.exact) return null;
    starts.push(m.pos);
  }
  for (let i = 1; i < starts.length; i++) if (starts[i]! <= starts[i - 1]!) return null;
  if (starts[starts.length - 1]! >= newLength && newLength > 0) return null;
  const avg = old.reduce((n, r) => n + (r.end - r.start), 0) / old.length;
  const maxInsert = ops.reduce((n, o) => (o.type === "insert" ? Math.max(n, o.bEnd - o.bStart) : n), 0);
  if (maxInsert > avg * 0.5) return null;
  return rangesFromStarts(starts, newLength);
}

export interface RetentionInput {
  old: ReadonlyArray<Range & { id: string }>;
  fresh: readonly Range[];
  ops: readonly DiffOp[];
  minOverlap: number;
  /** full texts enable move detection (07 §6.3 "씬 순서 교환: 두 씬 모두 ID 유지"), which an LCS diff alone misses */
  oldText?: string;
  newText?: string;
}

/** 07 §6.3 — returns the retained old id per fresh range (or null) and the retired old ids */
export function retainSceneIds({ old, fresh, ops, minOverlap, oldText, newText }: RetentionInput): { assigned: Array<string | null>; retired: string[]; overlaps: number[] } {
  const pairs: Array<{ o: number; n: number; ov: number }> = [];
  for (const [oi, o] of old.entries()) {
    const len = o.end - o.start;
    if (len <= 0) continue;
    for (const [ni, n] of fresh.entries()) {
      let ov = unchangedOverlap(ops, o.start, o.end, n.start, n.end) / len;
      if (ov < minOverlap && oldText !== undefined && newText !== undefined) {
        const body = oldText.slice(o.start, o.end).replace(/^[\s*◇◆#-]+|[\s*◇◆#-]+$/gu, "");
        if (body.length && newText.slice(n.start, n.end).includes(body)) ov = Math.max(ov, body.length / len);
      }
      if (ov >= minOverlap) pairs.push({ o: oi, n: ni, ov });
    }
  }
  pairs.sort((a, b) => b.ov - a.ov || a.n - b.n);
  const assigned: Array<string | null> = fresh.map(() => null);
  const overlaps: number[] = fresh.map(() => 0);
  const usedOld = new Set<number>();
  for (const p of pairs) {
    if (usedOld.has(p.o) || assigned[p.n] !== null) continue;
    assigned[p.n] = old[p.o]!.id;
    overlaps[p.n] = p.ov;
    usedOld.add(p.o);
  }
  const retired = old.filter((_, i) => !usedOld.has(i)).map((o) => o.id);
  return { assigned, retired, overlaps };
}

/** 00 §5.5: story_point = episode_no × 1000 + ord */
export const storyPoint = (episodeNo: number, ord: number) => episodeNo * 1000 + ord;
