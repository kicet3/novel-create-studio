/**
 * Pure helpers that turn a manuscript version (content + attribution spans + scenes + issue/beat
 * positions) into renderable lines with segments (08 §9.4).
 */

export interface SpanLike {
  start: number;
  end: number;
  actorType: string;
  actorId: string;
}

export interface MarkerLike {
  id: string;
  kind: "issue" | "beat" | "focus";
  start: number;
  end: number;
  /** tone hint: high/medium/low for issues, beat kind for beats */
  tone?: string;
  label?: string;
}

export interface SceneLike {
  id: string;
  ord: number;
  charStart: number;
  charEnd: number;
}

export type LineAuthor = "human" | "agent" | "system" | "mixed" | "none";

export interface Segment {
  start: number;
  end: number;
  text: string;
  /** actor type of the covering attribution span ("user" | "agent" | "system"), if any */
  actorType?: string;
  markers: MarkerLike[];
}

export interface RenderLine {
  no: number;
  start: number;
  end: number;
  text: string;
  author: LineAuthor;
  /** distinct actor ids on this line, e.g. ["writer"] or ["usr_…"] */
  actors: Array<{ actorType: string; actorId: string; chars: number }>;
  segments: Segment[];
  /** scenes whose boundary starts in this line */
  sceneStarts: SceneLike[];
  /** markers starting in this line (for anchors) */
  markerStarts: MarkerLike[];
}

/** Split into lines keeping char offsets (`\n` excluded from the line text). Offsets are UTF-16 indices. */
export function lineOffsets(content: string): Array<{ start: number; end: number; text: string }> {
  const out: Array<{ start: number; end: number; text: string }> = [];
  let pos = 0;
  for (const text of content.split("\n")) {
    out.push({ start: pos, end: pos + text.length, text });
    pos += text.length + 1;
  }
  return out;
}

function authorOf(actorType: string): LineAuthor {
  if (actorType === "user") return "human";
  if (actorType === "agent") return "agent";
  if (actorType === "system") return "system";
  return "none";
}

export function buildLines(content: string, spans: readonly SpanLike[], scenes: readonly SceneLike[], markers: readonly MarkerLike[]): RenderLine[] {
  const sortedSpans = [...spans].sort((a, b) => a.start - b.start);
  const sortedScenes = [...scenes].sort((a, b) => a.charStart - b.charStart || a.ord - b.ord);
  const placedScene = new Set<string>();
  const placedMarker = new Set<string>();
  const lines = lineOffsets(content);

  return lines.map((ln, idx) => {
    // a line owns offsets [previous line's newline, own newline): boundaries on a newline belong to the next line
    const lower = idx === 0 ? Number.NEGATIVE_INFINITY : (lines[idx - 1] as { end: number }).end;
    const upper = idx === lines.length - 1 ? Number.POSITIVE_INFINITY : ln.end;
    const owns = (offset: number) => offset >= lower && offset < upper;

    const sceneStarts = sortedScenes.filter((s) => !placedScene.has(s.id) && owns(s.charStart));
    for (const s of sceneStarts) placedScene.add(s.id);

    const overlapping = markers.filter((m) => owns(m.start) || (m.start < ln.end && m.end > ln.start));
    const markerStarts = overlapping.filter((m) => !placedMarker.has(m.id));
    for (const m of markerStarts) placedMarker.add(m.id);

    const lineSpans = sortedSpans.filter((s) => s.start < ln.end && s.end > ln.start);

    // breakpoints inside the line
    const cuts = new Set<number>([ln.start, ln.end]);
    for (const s of lineSpans) {
      if (s.start > ln.start && s.start < ln.end) cuts.add(s.start);
      if (s.end > ln.start && s.end < ln.end) cuts.add(s.end);
    }
    for (const m of overlapping) {
      if (m.start > ln.start && m.start < ln.end) cuts.add(m.start);
      if (m.end > ln.start && m.end < ln.end) cuts.add(m.end);
    }
    const points = [...cuts].sort((a, b) => a - b);
    const segments: Segment[] = [];
    for (let k = 0; k < points.length - 1; k++) {
      const a = points[k] as number;
      const b = points[k + 1] as number;
      if (b <= a) continue;
      const span = lineSpans.find((s) => s.start <= a && s.end >= b);
      segments.push({
        start: a,
        end: b,
        text: content.slice(a, b),
        actorType: span?.actorType,
        markers: overlapping.filter((m) => m.start <= a && m.end >= b),
      });
    }
    if (segments.length === 0) segments.push({ start: ln.start, end: ln.end, text: "", markers: overlapping.filter((m) => m.start <= ln.start && m.end >= ln.start) });

    const actorChars = new Map<string, { actorType: string; actorId: string; chars: number }>();
    for (const s of lineSpans) {
      const chars = Math.min(s.end, ln.end) - Math.max(s.start, ln.start);
      if (chars <= 0) continue;
      const key = `${s.actorType}:${s.actorId}`;
      const cur = actorChars.get(key);
      if (cur) cur.chars += chars;
      else actorChars.set(key, { actorType: s.actorType, actorId: s.actorId, chars });
    }
    const actors = [...actorChars.values()].sort((x, y) => y.chars - x.chars);
    const types = new Set(actors.map((a) => authorOf(a.actorType)));
    const author: LineAuthor = types.size === 0 ? "none" : types.size > 1 ? "mixed" : ([...types][0] as LineAuthor);

    return { no: idx + 1, start: ln.start, end: ln.end, text: ln.text, author, actors, segments, sceneStarts, markerStarts };
  });
}

/** Share of characters per actor type across the whole text (for the attribution legend). */
export function attributionShare(contentLength: number, spans: readonly SpanLike[]): Record<string, number> {
  const out: Record<string, number> = {};
  if (contentLength <= 0) return out;
  for (const s of spans) {
    const len = Math.max(0, Math.min(s.end, contentLength) - Math.max(0, s.start));
    out[s.actorType] = (out[s.actorType] ?? 0) + len;
  }
  for (const k of Object.keys(out)) out[k] = (out[k] as number) / contentLength;
  return out;
}

/** Locate a char offset: scene ord + paragraph index (1-based) within that scene, for "씬2, 2번째 문단". */
export function describeLocation(content: string, offset: number, scenes: readonly SceneLike[]): { sceneOrd: number | null; paragraph: number } {
  const scene = [...scenes].sort((a, b) => a.charStart - b.charStart).filter((s) => s.charStart <= offset).pop() ?? null;
  const from = scene ? Math.max(0, scene.charStart) : 0;
  const before = content.slice(from, Math.max(from, offset));
  const paragraph = before.split("\n").filter((l) => l.trim().length > 0).length || 1;
  return { sceneOrd: scene ? scene.ord : null, paragraph };
}
