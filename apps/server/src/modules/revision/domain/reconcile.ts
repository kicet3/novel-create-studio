/**
 * 설계 추가(수정 반영): pure planning of how the facts extracted from an episode follow an edit of its text.
 *
 * A fact of an earlier version is "still supported" when the sentence its evidence mention sits in still occurs in the
 * new text (an extraction that merely missed it changes nothing), or when it is grounded in another episode too. A fact
 * the new text no longer supports is retired; when the same extraction wrote exactly one new fact for the same subject +
 * predicate (or a new fact conflicts with it on the same single-valued slot) the new fact supersedes it. No relation or
 * predicate list is hard-coded here: pairing only compares the subject / predicate the schema already gave the facts.
 */
import { normalizeText } from "./patch.js";

/** sentence boundaries (Korean prose: 。 . ! ? … quotes and line breaks) */
const BOUNDARY = /[.!?。…\n"“”'‘’]/u;

/** the sentence of `text` that contains [start, end) (trimmed; ±24 chars when the sentence is too short to be telling) */
export function evidenceSentence(text: string, start: number, end: number): string {
  const t = text;
  if (start < 0 || end > t.length || end <= start) return "";
  let a = start;
  while (a > 0 && !BOUNDARY.test(t[a - 1]!)) a--;
  let b = end;
  while (b < t.length && !BOUNDARY.test(t[b]!)) b++;
  const s = t.slice(a, b).trim();
  if (s.length >= 6) return s;
  return t.slice(Math.max(0, start - 24), Math.min(t.length, end + 24)).trim();
}

/** whitespace-insensitive containment (NFC / LF normalized) */
export function squash(text: string): string {
  return normalizeText(text).replace(/\s+/g, "");
}

export interface OldFactInput {
  factId: string;
  canonStatus: string;
  subjectEntityId: string;
  predicate: string;
  /** evidence sentences from the earlier versions of this episode */
  sentences: string[];
  /** grounded in another episode / source too (never retired by this episode's edit) */
  groundedElsewhere: boolean;
  /** a held successor of a pending text-edit change: never paired as the replaced fact (it is itself replaced) */
  heldSuccessor?: boolean;
}

export interface NewFactInput {
  factId: string;
  subjectEntityId: string;
  predicate: string;
  conflictWith: string | null;
}

export interface ReconcilePlan {
  /** earlier facts still supported by the new text */
  kept: string[];
  /** earlier facts the new text no longer supports (successor = the new fact that replaces it) */
  retire: Array<{ factId: string; canonStatus: string; successor: string | null }>;
}

export function planReconcile(oldFacts: readonly OldFactInput[], created: readonly NewFactInput[], newText: string): ReconcilePlan {
  const text = squash(newText);
  const kept: string[] = [];
  const gone: OldFactInput[] = [];
  for (const f of oldFacts) {
    // nothing to judge by (no evidence in an earlier text of this episode) or grounded elsewhere → keep
    if (f.groundedElsewhere || f.sentences.length === 0 || f.sentences.some((s) => squash(s).length > 0 && text.includes(squash(s)))) kept.push(f.factId);
    else gone.push(f);
  }
  const successor = new Map<string, string>();
  const taken = new Set<string>();
  // (1) the extraction already classified the new fact as a conflict on the old fact's single-valued slot
  for (const n of created) {
    if (!n.conflictWith || taken.has(n.factId)) continue;
    const o = gone.find((g) => g.factId === n.conflictWith && !successor.has(g.factId));
    if (!o) continue;
    successor.set(o.factId, n.factId);
    taken.add(n.factId);
  }
  // (2) same subject + predicate, exactly one lost and one gained → the new one replaces the old one
  const key = (s: string, p: string) => `${s}\u0000${p}`;
  const lost = new Map<string, OldFactInput[]>();
  for (const g of gone) if (!successor.has(g.factId) && !g.heldSuccessor) lost.set(key(g.subjectEntityId, g.predicate), [...(lost.get(key(g.subjectEntityId, g.predicate)) ?? []), g]);
  const gained = new Map<string, NewFactInput[]>();
  for (const n of created) if (!taken.has(n.factId)) gained.set(key(n.subjectEntityId, n.predicate), [...(gained.get(key(n.subjectEntityId, n.predicate)) ?? []), n]);
  for (const [k, olds] of lost) {
    const news = gained.get(k) ?? [];
    if (olds.length === 1 && news.length === 1) {
      successor.set(olds[0]!.factId, news[0]!.factId);
      taken.add(news[0]!.factId);
    }
  }
  return { kept, retire: gone.map((g) => ({ factId: g.factId, canonStatus: g.canonStatus, successor: successor.get(g.factId) ?? null })) };
}

export type FactEffectKind = "keep" | "change" | "retract";

export interface FactEffectInput {
  factId: string;
  canonStatus: string;
  text: string;
  /** value text of an attribute fact (null for relations) */
  valueText: string | null;
  /** surfaces of the subject in the evidence (e.g. "서율") */
  surfaces: string[];
  sentences: string[];
}

export interface FactEffect {
  factId: string;
  canonStatus: string;
  text: string;
  effect: FactEffectKind;
  /** false = 예상 (heuristic over the patched passage; the extraction after applying decides) */
  certain: boolean;
  /** approved canon expected to change / retract: applied only when the author confirms it here (and the extraction
   * after applying agrees with the shown effect), otherwise a canon_change approval. Never for "keep". */
  needsConfirm: boolean;
}

/**
 * dry run for a text patch proposal: facts whose evidence sentence is in the current text but not in the patched text.
 * Judged on the replacement of the patch that covers the sentence: keep = it still carries the value; change = the
 * subject is still talked about there; retract otherwise.
 */
export function previewFactEffects(
  facts: readonly FactEffectInput[],
  current: string,
  patched: string,
  patches: ReadonlyArray<{ start: number; end: number; replacement: string }>,
): FactEffect[] {
  const curText = normalizeText(current);
  const cur = squash(current);
  const next = squash(patched);
  const out: FactEffect[] = [];
  for (const f of facts) {
    const raw = f.sentences.filter((s) => squash(s).length > 0);
    const ss = raw.map(squash);
    if (!ss.length || !ss.some((s) => cur.includes(s)) || ss.some((s) => next.includes(s))) continue;
    const spans = raw.map((s) => ({ at: curText.indexOf(normalizeText(s)), len: normalizeText(s).length })).filter((x) => x.at >= 0);
    const own = patches.filter((p) => spans.some((x) => x.at < p.end && x.at + x.len > p.start));
    const added = squash((own.length ? own : patches).map((p) => p.replacement).join("\n"));
    const v = f.valueText ? squash(f.valueText) : "";
    const effect: FactEffectKind = v.length >= 2 && added.includes(v) ? "keep" : f.surfaces.some((x) => squash(x).length > 0 && added.includes(squash(x))) ? "change" : "retract";
    out.push({ factId: f.factId, canonStatus: f.canonStatus, text: f.text, effect, certain: false, needsConfirm: f.canonStatus === "approved" && effect !== "keep" });
  }
  return out;
}
