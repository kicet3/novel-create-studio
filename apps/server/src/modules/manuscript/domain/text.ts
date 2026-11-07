/**
 * Character counting (FR-MAN-02) — the single implementation used by manuscript and export (07 §3.8).
 * Counts Unicode code points of the NFC-normalized body. `without_spaces` drops every whitespace char.
 */
import { EPISODE_HARD_MIN_CHARS, type CountBasis } from "@ncs/shared";

export function normalizeText(text: string): string {
  return text.normalize("NFC").replace(/\r\n?/g, "\n");
}

export function countChars(text: string, basis: CountBasis): number {
  const t = normalizeText(text);
  const s = basis === "without_spaces" ? t.replace(/\s+/gu, "") : t;
  let n = 0;
  for (const _ of s) n++;
  return n;
}

export interface LengthCheck {
  basis: CountBasis;
  count: number;
  minChars: number;
  maxChars: number;
  /** null = within the profile; warning only (FR-MAN-02, never blocks) */
  deviation: "short" | "long" | null;
  /** absolute floor of one episode (설계 추가 0008: 3,000자, same count basis) */
  hardMinChars: number;
  /** below the floor: no auto-approval / auto-publish, "분량 미달" notice */
  belowFloor: boolean;
}

export function checkLength(text: string, profile: { minChars: number; maxChars: number; countBasis: CountBasis }): LengthCheck {
  const count = countChars(text, profile.countBasis);
  const deviation = count < profile.minChars ? "short" : count > profile.maxChars ? "long" : null;
  return { basis: profile.countBasis, count, minChars: profile.minChars, maxChars: profile.maxChars, deviation, hardMinChars: EPISODE_HARD_MIN_CHARS, belowFloor: count < EPISODE_HARD_MIN_CHARS };
}

/** below the floor by a stored version's counts (no text needed) */
export function belowFloorByCounts(v: { charCountWithSpaces: number; charCountWithoutSpaces: number }, basis: CountBasis): boolean {
  return (basis === "without_spaces" ? v.charCountWithoutSpaces : v.charCountWithSpaces) < EPISODE_HARD_MIN_CHARS;
}

/**
 * draft continuation (설계 추가): keep asking for more text while the draft is under the profile minimum, the attempt
 * budget is left and the previous continuation actually grew the text (`lastGrowth` null = no attempt yet).
 */
export function continuationNeeded(count: number, minChars: number, attempt: number, maxAttempts: number, lastGrowth: number | null, minGrowth: number): boolean {
  if (count >= minChars || attempt >= maxAttempts) return false;
  return lastGrowth === null || lastGrowth >= minGrowth;
}

/**
 * polish / revise floor guard per scene: a rewritten scene that is shorter than the original is rejected when the
 * episode would end up under the floor with it (the original scene is kept).
 */
export function guardSceneLength(i: { originalSceneCount: number; newSceneCount: number; projectedTotal: number; floor: number }): "keep_new" | "keep_original" {
  return i.projectedTotal < i.floor && i.newSceneCount < i.originalSceneCount ? "keep_original" : "keep_new";
}

/**
 * 설계 추가 0017 — length adjustment. A count is accepted in [minChars, floor(maxChars × (1 + tolerance))]; outside it
 * a trim / expand pass runs (bounded rounds). The midpoint of the profile is the goal of a pass.
 */
export function acceptedMaxChars(maxChars: number, tolerance: number): number {
  return Math.floor(maxChars * (1 + Math.max(0, tolerance)));
}

export function lengthAdjustmentOf(count: number, profile: { minChars: number; maxChars: number }, tolerance: number): "trim" | "expand" | null {
  if (count < profile.minChars) return "expand";
  if (count > acceptedMaxChars(profile.maxChars, tolerance)) return "trim";
  return null;
}

/** chars outside the accepted range (0 = inside) */
export function lengthDistance(count: number, profile: { minChars: number; maxChars: number }, tolerance: number): number {
  const hi = acceptedMaxChars(profile.maxChars, tolerance);
  return count < profile.minChars ? profile.minChars - count : count > hi ? count - hi : 0;
}

export function lengthGoal(profile: { minChars: number; maxChars: number }): number {
  return Math.round((profile.minChars + profile.maxChars) / 2);
}

/**
 * per-scene targets that bring the episode total to `goal`: editable scenes scale by one ratio, fixed scenes (user
 * text) keep their count. The ratio is bounded so one pass never asks for a rewrite into a fragment or a 3× scene.
 */
export function sceneTargets(counts: readonly number[], editable: readonly boolean[], goal: number): number[] {
  const fixed = counts.reduce((n, c, i) => (editable[i] ? n : n + c), 0);
  const ed = counts.reduce((n, c, i) => (editable[i] ? n + c : n), 0);
  if (ed <= 0) return [...counts];
  const ratio = Math.min(3, Math.max(0.3, (goal - fixed) / ed));
  return counts.map((c, i) => (editable[i] ? Math.max(1, Math.round(c * ratio)) : c));
}

/**
 * a rewritten scene that still contains the original verbatim plus a second full version ("원문 + 새 글") is an append,
 * not a rewrite: the original copy is dropped. A short addition to the original (a tail, under half of it) is an edit
 * and stays as written. Not for expand passes (they may keep the original and add to it).
 */
export function dedupeRewrite(original: string, rewritten: string): string {
  const o = normalizeText(original).trim();
  const b = normalizeText(rewritten).trim();
  if (o.length < 200 || b.length <= o.length) return b;
  const i = b.indexOf(o);
  if (i < 0) return b;
  const rest = `${b.slice(0, i).trim()}\n\n${b.slice(i + o.length).trim()}`.trim();
  return rest.length >= o.length * 0.5 ? rest : b;
}

/**
 * growth guard of a rewritten scene (설계 추가 0017): keep the original when the scene grows while the episode would
 * end above `ceiling`, or when it runs away (more than `maxGrowthRatio` × and 300+ chars longer — a spill into the
 * following scenes / a second copy).
 */
export function guardSceneGrowth(i: { originalSceneCount: number; newSceneCount: number; projectedTotal: number; ceiling?: number; maxGrowthRatio?: number }): "keep_new" | "keep_original" {
  if (i.newSceneCount <= i.originalSceneCount) return "keep_new";
  if (i.ceiling !== undefined && i.projectedTotal > i.ceiling) return "keep_original";
  if (i.maxGrowthRatio !== undefined && i.newSceneCount > i.originalSceneCount * i.maxGrowthRatio && i.newSceneCount - i.originalSceneCount > 300) return "keep_original";
  return "keep_new";
}

/** Korean label of the count basis ("공백 포함" / "공백 제외") */
export function countBasisLabel(basis: CountBasis): string {
  return basis === "without_spaces" ? "공백 제외" : "공백 포함";
}

/** first sentence-ish summary of a passage (≤ max chars) for scene summaries when no outline text exists */
export function firstSentence(text: string, max = 80): string {
  const t = normalizeText(text).replace(/^[\s*#·◇◆-]+/u, "").trim();
  const m = /^(.+?[.!?。…"”])(\s|$)/su.exec(t);
  const s = (m?.[1] ?? t).replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s || "(빈 씬)";
}

/** line used by the writer prompt and the deterministic segmenter to separate scenes */
export const SCENE_SEPARATOR = "* * *";
const SEPARATOR_LINE = /^[ \t]*(\*[ \t]*\*[ \t]*\*|-{3,}|◇+|◆+|#{3,})[ \t]*$/gmu;
/** trailing whitespace of a scene incl. a closing separator line (kept when the scene body is rewritten) */
export const SCENE_TAIL = /\s*(?:\n[ \t]*(?:\*[ \t]*\*[ \t]*\*|-{3,}|◇+|◆+|#{3,})[ \t]*)?\s*$/u;
/** a separator line closing a rewritten body (the scene tail already carries it) */
export const TRAILING_SEPARATOR = /\n[ \t]*(?:\*[ \t]*\*[ \t]*\*|-{3,}|◇+|◆+|#{3,})[ \t]*\s*$/u;

/** char offsets where scenes start, using explicit separator lines; [0] when none */
export function separatorSceneStarts(text: string): number[] {
  const starts = [0];
  for (const m of text.matchAll(SEPARATOR_LINE)) {
    const end = m.index + m[0].length;
    const next = end < text.length && text[end] === "\n" ? end + 1 : end;
    if (next > 0 && next < text.length) starts.push(next);
  }
  return [...new Set(starts)].sort((a, b) => a - b);
}

/** split into ~n parts at paragraph boundaries (deterministic fallback segmentation) */
export function paragraphSceneStarts(text: string, n: number): number[] {
  if (n <= 1 || !text.length) return [0];
  const paras: number[] = [0];
  for (const m of text.matchAll(/\n\s*\n/g)) {
    const p = m.index + m[0].length;
    if (p < text.length) paras.push(p);
  }
  if (paras.length <= n) return paras;
  const out = [0];
  for (let i = 1; i < n; i++) {
    const target = Math.round((text.length * i) / n);
    let best = paras[1]!;
    for (const p of paras) if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    if (best > out[out.length - 1]!) out.push(best);
  }
  return out;
}

/**
 * Fact-bearing signature of a text (07 §3.4 결정적 검사 (2) proxy): numerals and known entity surfaces with
 * their counts. Polishing that changes this signature is treated as a fact diff (E7). The full
 * re-extraction comparison needs synchronous P3b/P3c, which the linking module does not expose yet.
 */
export function factSignature(text: string, names: readonly string[]): Map<string, number> {
  const t = normalizeText(text);
  const sig = new Map<string, number>();
  for (const m of t.matchAll(/\d+(?:[.,]\d+)?/g)) sig.set(`#${m[0]}`, (sig.get(`#${m[0]}`) ?? 0) + 1);
  for (const name of names) {
    const n = name.normalize("NFC").trim();
    if (n.length < 2) continue;
    let count = 0;
    for (let i = t.indexOf(n); i >= 0; i = t.indexOf(n, i + n.length)) count++;
    if (count) sig.set(`@${n}`, count);
  }
  return sig;
}

export function signaturesEqual(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}
