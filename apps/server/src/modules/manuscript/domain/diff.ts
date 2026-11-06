/**
 * Character-position diff between two manuscript versions (07 §6.2 위치 사상). Pure.
 * Common prefix/suffix are trimmed, the middle is diffed at token level (whitespace runs, letter/digit
 * runs, single symbols) with Myers O(ND); when the edit distance exceeds `maxEdits` the middle is a
 * single replacement. Offsets are JS string indices (UTF-16), the same unit as `content.slice`.
 */
export interface DiffOp {
  type: "equal" | "insert" | "delete";
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

const TOKEN = /\s+|[\p{L}\p{N}]+|[\s\S]/gu;

function tokenize(s: string): { toks: string[]; offs: number[] } {
  const toks: string[] = [];
  const offs: number[] = [];
  for (const m of s.matchAll(TOKEN)) {
    toks.push(m[0]);
    offs.push(m.index);
  }
  offs.push(s.length);
  return { toks, offs };
}

type Step = { t: "eq" | "ins" | "del"; ai: number; bi: number };

/** Myers shortest edit script over token arrays; null when D > maxD. */
function myers(A: string[], B: string[], maxD: number): Step[] | null {
  const n = A.length;
  const m = B.length;
  const lim = Math.min(maxD, n + m);
  const OFF = lim + 2;
  const v = new Int32Array(2 * OFF + 3);
  v[OFF + 1] = 0;
  const trace: Array<{ base: number; snap: Int32Array }> = [];
  for (let d = 0; d <= lim; d++) {
    const base = -(d + 1);
    trace.push({ base, snap: v.slice(OFF + base, OFF + d + 2) });
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[OFF + k - 1]! < v[OFF + k + 1]!) ? v[OFF + k + 1]! : v[OFF + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) {
        x++;
        y++;
      }
      v[OFF + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m);
    }
  }
  return null;
}

function backtrack(trace: Array<{ base: number; snap: Int32Array }>, n: number, m: number): Step[] {
  const out: Step[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const { base, snap } = trace[d]!;
    const at = (k: number) => snap[k - base]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      out.push({ t: "eq", ai: x - 1, bi: y - 1 });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) out.push({ t: "ins", ai: x, bi: y - 1 });
      else out.push({ t: "del", ai: x - 1, bi: y });
    }
    x = prevX;
    y = prevY;
  }
  return out.reverse();
}

function push(ops: DiffOp[], op: DiffOp): void {
  if (op.aStart === op.aEnd && op.bStart === op.bEnd) return;
  const last = ops[ops.length - 1];
  if (last && last.type === op.type && last.aEnd === op.aStart && last.bEnd === op.bStart) {
    last.aEnd = op.aEnd;
    last.bEnd = op.bEnd;
    return;
  }
  ops.push({ ...op });
}

export function diffText(a: string, b: string, opts: { maxEdits?: number } = {}): DiffOp[] {
  const ops: DiffOp[] = [];
  if (a === b) {
    push(ops, { type: "equal", aStart: 0, aEnd: a.length, bStart: 0, bEnd: b.length });
    return ops;
  }
  let p = 0;
  const minLen = Math.min(a.length, b.length);
  while (p < minLen && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  let s = 0;
  while (s < minLen - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  push(ops, { type: "equal", aStart: 0, aEnd: p, bStart: 0, bEnd: p });
  const am = a.slice(p, a.length - s);
  const bm = b.slice(p, b.length - s);
  const ta = tokenize(am);
  const tb = tokenize(bm);
  const steps = myers(ta.toks, tb.toks, opts.maxEdits ?? 2000);
  if (!steps) {
    push(ops, { type: "delete", aStart: p, aEnd: p + am.length, bStart: p, bEnd: p });
    push(ops, { type: "insert", aStart: p + am.length, aEnd: p + am.length, bStart: p, bEnd: p + bm.length });
  } else {
    for (const st of steps) {
      if (st.t === "eq") {
        push(ops, { type: "equal", aStart: p + ta.offs[st.ai]!, aEnd: p + ta.offs[st.ai + 1]!, bStart: p + tb.offs[st.bi]!, bEnd: p + tb.offs[st.bi + 1]! });
      } else if (st.t === "del") {
        const bAt = p + tb.offs[st.bi]!;
        push(ops, { type: "delete", aStart: p + ta.offs[st.ai]!, aEnd: p + ta.offs[st.ai + 1]!, bStart: bAt, bEnd: bAt });
      } else {
        const aAt = p + ta.offs[st.ai]!;
        push(ops, { type: "insert", aStart: aAt, aEnd: aAt, bStart: p + tb.offs[st.bi]!, bEnd: p + tb.offs[st.bi + 1]! });
      }
    }
  }
  push(ops, { type: "equal", aStart: a.length - s, aEnd: a.length, bStart: b.length - s, bEnd: b.length });
  return ops;
}

/** unchanged chars of old range [aStart,aEnd) that land inside new range [bStart,bEnd) */
export function unchangedOverlap(ops: readonly DiffOp[], aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  let n = 0;
  for (const op of ops) {
    if (op.type !== "equal") continue;
    const s = Math.max(op.aStart, aStart);
    const e = Math.min(op.aEnd, aEnd);
    if (e <= s) continue;
    const ns = Math.max(op.bStart + (s - op.aStart), bStart);
    const ne = Math.min(op.bStart + (e - op.aStart), bEnd);
    if (ne > ns) n += ne - ns;
  }
  return n;
}

/** map an old position to the new text (deleted positions collapse to the deletion point) */
export function mapPosition(ops: readonly DiffOp[], pos: number): { pos: number; exact: boolean } {
  for (const op of ops) {
    if (op.type === "insert") continue;
    if (pos >= op.aStart && pos < op.aEnd) {
      return op.type === "equal" ? { pos: op.bStart + (pos - op.aStart), exact: true } : { pos: op.bStart, exact: false };
    }
  }
  const last = ops[ops.length - 1];
  return { pos: last ? last.bEnd : 0, exact: true };
}

/** total chars changed (inserted + deleted) */
export function changedChars(ops: readonly DiffOp[]): number {
  let n = 0;
  for (const op of ops) if (op.type !== "equal") n += op.aEnd - op.aStart + (op.bEnd - op.bStart);
  return n;
}
