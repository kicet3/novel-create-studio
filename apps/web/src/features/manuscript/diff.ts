/**
 * Tiny LCS diff for the manuscript viewer (08 §9.4 "나란히·통합 보기, 문자 diff").
 * Line diff first; changed line pairs get an intra-line character diff.
 * No dependencies; quadratic, guarded by size limits (episodes are ~100–300 lines).
 */

export type DiffOp = "equal" | "delete" | "insert";

export interface LineDiff {
  op: DiffOp;
  text: string;
  /** 1-based line number in the old text (equal/delete). */
  oldNo?: number;
  /** 1-based line number in the new text (equal/insert). */
  newNo?: number;
}

export interface CharSegment {
  op: DiffOp;
  text: string;
}

/** Above this many LCS cells we fall back to a coarse prefix/suffix diff. */
const MAX_LINE_CELLS = 4_000_000;
const MAX_CHAR_CELLS = 250_000;

/** Generic LCS diff over two arrays. Returns ops in order. */
export function diffSequence<T>(a: readonly T[], b: readonly T[], eq: (x: T, y: T) => boolean = Object.is, maxCells = MAX_LINE_CELLS): Array<{ op: DiffOp; a?: number; b?: number }> {
  // common prefix / suffix trimming keeps the table small for typical edits
  let start = 0;
  while (start < a.length && start < b.length && eq(a[start] as T, b[start] as T)) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && eq(a[endA - 1] as T, b[endB - 1] as T)) {
    endA--;
    endB--;
  }
  const out: Array<{ op: DiffOp; a?: number; b?: number }> = [];
  for (let i = 0; i < start; i++) out.push({ op: "equal", a: i, b: i });

  const n = endA - start;
  const m = endB - start;
  if (n > 0 || m > 0) {
    if (n === 0 || m === 0 || n * m > maxCells) {
      for (let i = start; i < endA; i++) out.push({ op: "delete", a: i });
      for (let j = start; j < endB; j++) out.push({ op: "insert", b: j });
    } else {
      // dp[i][j] = LCS length of a[start+i..endA) and b[start+j..endB)
      const w = m + 1;
      const dp = new Uint32Array((n + 1) * w);
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          dp[i * w + j] = eq(a[start + i] as T, b[start + j] as T)
            ? (dp[(i + 1) * w + j + 1] as number) + 1
            : Math.max(dp[(i + 1) * w + j] as number, dp[i * w + j + 1] as number);
        }
      }
      let i = 0;
      let j = 0;
      while (i < n && j < m) {
        if (eq(a[start + i] as T, b[start + j] as T)) {
          out.push({ op: "equal", a: start + i, b: start + j });
          i++;
          j++;
        } else if ((dp[(i + 1) * w + j] as number) >= (dp[i * w + j + 1] as number)) {
          out.push({ op: "delete", a: start + i });
          i++;
        } else {
          out.push({ op: "insert", b: start + j });
          j++;
        }
      }
      for (; i < n; i++) out.push({ op: "delete", a: start + i });
      for (; j < m; j++) out.push({ op: "insert", b: start + j });
    }
  }
  for (let k = 0; k < a.length - endA; k++) out.push({ op: "equal", a: endA + k, b: endB + k });
  return out;
}

export function splitLines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n");
}

export function diffLines(oldText: string, newText: string): LineDiff[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  return diffSequence(a, b, (x, y) => x === y).map((o) => {
    if (o.op === "equal") return { op: "equal", text: b[o.b as number] as string, oldNo: (o.a as number) + 1, newNo: (o.b as number) + 1 };
    if (o.op === "delete") return { op: "delete", text: a[o.a as number] as string, oldNo: (o.a as number) + 1 };
    return { op: "insert", text: b[o.b as number] as string, newNo: (o.b as number) + 1 };
  });
}

/** Character diff of two strings, merged into runs. */
export function diffChars(oldText: string, newText: string): CharSegment[] {
  const a = Array.from(oldText);
  const b = Array.from(newText);
  const ops = diffSequence(a, b, (x, y) => x === y, MAX_CHAR_CELLS);
  const out: CharSegment[] = [];
  for (const o of ops) {
    const ch = o.op === "insert" ? (b[o.b as number] as string) : (a[o.a as number] as string);
    const last = out[out.length - 1];
    if (last && last.op === o.op) last.text += ch;
    else out.push({ op: o.op, text: ch });
  }
  return out;
}

/** Old side of a char diff (equal + delete). */
export function oldSide(segs: readonly CharSegment[]): CharSegment[] {
  return segs.filter((s) => s.op !== "insert");
}
/** New side of a char diff (equal + insert). */
export function newSide(segs: readonly CharSegment[]): CharSegment[] {
  return segs.filter((s) => s.op !== "delete");
}

export interface SideBySideRow {
  kind: "equal" | "change" | "delete" | "insert";
  left?: { no: number; text: string; segments?: CharSegment[] };
  right?: { no: number; text: string; segments?: CharSegment[] };
}

/**
 * Pair a line diff into side-by-side rows: a run of deletes followed by inserts is zipped row by row
 * (with an intra-line char diff), leftovers become one-sided rows.
 */
export function toSideBySide(lines: readonly LineDiff[]): SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i] as LineDiff;
    if (l.op === "equal") {
      rows.push({ kind: "equal", left: { no: l.oldNo as number, text: l.text }, right: { no: l.newNo as number, text: l.text } });
      i++;
      continue;
    }
    const dels: LineDiff[] = [];
    const ins: LineDiff[] = [];
    while (i < lines.length && (lines[i] as LineDiff).op === "delete") dels.push(lines[i++] as LineDiff);
    while (i < lines.length && (lines[i] as LineDiff).op === "insert") ins.push(lines[i++] as LineDiff);
    const k = Math.max(dels.length, ins.length);
    for (let r = 0; r < k; r++) {
      const d = dels[r];
      const n = ins[r];
      if (d && n) {
        const segs = diffChars(d.text, n.text);
        rows.push({
          kind: "change",
          left: { no: d.oldNo as number, text: d.text, segments: oldSide(segs) },
          right: { no: n.newNo as number, text: n.text, segments: newSide(segs) },
        });
      } else if (d) rows.push({ kind: "delete", left: { no: d.oldNo as number, text: d.text } });
      else if (n) rows.push({ kind: "insert", right: { no: n.newNo as number, text: n.text } });
    }
  }
  return rows;
}

export interface DiffStats {
  added: number;
  removed: number;
  unchanged: number;
}

export function diffStats(lines: readonly LineDiff[]): DiffStats {
  const s: DiffStats = { added: 0, removed: 0, unchanged: 0 };
  for (const l of lines) {
    if (l.op === "insert") s.added++;
    else if (l.op === "delete") s.removed++;
    else s.unchanged++;
  }
  return s;
}

/**
 * Collapse long runs of unchanged lines in a unified diff, keeping `context` lines around changes.
 * Returns items that are either a line or a `{ skipped: n }` marker.
 */
export function withContext<T extends { op?: DiffOp; kind?: string }>(rows: readonly T[], context = 3): Array<T | { skipped: number }> {
  const isEqual = (r: T) => r.op === "equal" || r.kind === "equal";
  const keep = new Array<boolean>(rows.length).fill(false);
  rows.forEach((r, idx) => {
    if (!isEqual(r)) for (let k = Math.max(0, idx - context); k <= Math.min(rows.length - 1, idx + context); k++) keep[k] = true;
  });
  const out: Array<T | { skipped: number }> = [];
  let skipped = 0;
  rows.forEach((r, idx) => {
    if (keep[idx]) {
      if (skipped) out.push({ skipped });
      skipped = 0;
      out.push(r);
    } else skipped++;
  });
  if (skipped) out.push({ skipped });
  return out;
}
