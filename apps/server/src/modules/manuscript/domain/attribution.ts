/**
 * attribution_spans (07 §7.2, INV-MV-02/03). Pure.
 *   1. diff parent → new  2. unchanged ranges inherit the parent span  3. inserted ranges get the new
 *   author + origin = new version  4. merge neighbours, check full coverage  6. detect changed user spans.
 */
import type { AttributionSpan } from "../index.js";
import type { DiffOp } from "./diff.js";

export interface SpanAuthor {
  actorType: AttributionSpan["actorType"];
  actorId: string;
}

export function mergeSpans(spans: AttributionSpan[]): AttributionSpan[] {
  const out: AttributionSpan[] = [];
  for (const s of spans) {
    if (s.end <= s.start) continue;
    const last = out[out.length - 1];
    if (last && last.end === s.start && last.actorType === s.actorType && last.actorId === s.actorId && last.originVersionId === s.originVersionId) {
      last.end = s.end;
    } else out.push({ ...s });
  }
  return out;
}

/** INV-MV-02: spans cover [0, length) without gaps or overlaps */
export function coversExactly(spans: readonly AttributionSpan[], length: number): boolean {
  if (length === 0) return spans.length === 0;
  let pos = 0;
  for (const s of spans) {
    if (s.start !== pos || s.end <= s.start) return false;
    pos = s.end;
  }
  return pos === length;
}

export function initialSpans(length: number, author: SpanAuthor, versionId: string): AttributionSpan[] {
  return length > 0 ? [{ start: 0, end: length, actorType: author.actorType, actorId: author.actorId, originVersionId: versionId }] : [];
}

/** parent spans clipped to [s,e) */
function slice(parent: readonly AttributionSpan[], s: number, e: number): AttributionSpan[] {
  const out: AttributionSpan[] = [];
  for (const p of parent) {
    const a = Math.max(p.start, s);
    const b = Math.min(p.end, e);
    if (b > a) out.push({ ...p, start: a, end: b });
  }
  return out;
}

export function computeSpans(
  parent: readonly AttributionSpan[] | null,
  ops: readonly DiffOp[] | null,
  newLength: number,
  author: SpanAuthor,
  newVersionId: string,
): { spans: AttributionSpan[]; humanSpansChanged: boolean } {
  if (!parent || !ops || !coversExactly(parent, ops.reduce((n, o) => Math.max(n, o.aEnd), 0))) {
    return { spans: initialSpans(newLength, author, newVersionId), humanSpansChanged: false };
  }
  const out: AttributionSpan[] = [];
  let humanSpansChanged = false;
  for (const op of ops) {
    if (op.type === "equal") {
      for (const p of slice(parent, op.aStart, op.aEnd)) {
        out.push({ ...p, start: op.bStart + (p.start - op.aStart), end: op.bStart + (p.end - op.aStart) });
      }
    } else if (op.type === "insert") {
      out.push({ start: op.bStart, end: op.bEnd, actorType: author.actorType, actorId: author.actorId, originVersionId: newVersionId });
      // inserting strictly inside a user span modifies it
      if (author.actorType !== "user" && parent.some((p) => p.actorType === "user" && p.start < op.aStart && op.aStart < p.end)) humanSpansChanged = true;
    } else if (author.actorType !== "user" && slice(parent, op.aStart, op.aEnd).some((p) => p.actorType === "user")) {
      humanSpansChanged = true;
    }
  }
  const spans = mergeSpans(out.sort((x, y) => x.start - y.start));
  return { spans, humanSpansChanged };
}

/** per-line attribution for display (07 §7.2 step 5) */
export function lineAttribution(content: string, spans: readonly AttributionSpan[]): Array<{ line: number; actors: Array<{ actorType: string; actorId: string; ratio: number }> }> {
  const lines: Array<{ line: number; actors: Array<{ actorType: string; actorId: string; ratio: number }> }> = [];
  let start = 0;
  let no = 1;
  for (const text of content.split("\n")) {
    const end = start + text.length;
    const counts = new Map<string, number>();
    for (const s of spans) {
      const n = Math.min(s.end, end) - Math.max(s.start, start);
      if (n > 0) counts.set(`${s.actorType}:${s.actorId}`, (counts.get(`${s.actorType}:${s.actorId}`) ?? 0) + n);
    }
    const total = [...counts.values()].reduce((a, b) => a + b, 0) || 1;
    lines.push({
      line: no++,
      actors: [...counts].map(([k, n]) => {
        const i = k.indexOf(":");
        return { actorType: k.slice(0, i), actorId: k.slice(i + 1), ratio: Math.round((n / total) * 1000) / 1000 };
      }),
    });
    start = end + 1;
  }
  return lines;
}

/** ranges written by a user (for "do not touch" checks, PR-08) */
export function userRanges(spans: readonly AttributionSpan[]): Array<{ start: number; end: number }> {
  return spans.filter((s) => s.actorType === "user").map((s) => ({ start: s.start, end: s.end }));
}
