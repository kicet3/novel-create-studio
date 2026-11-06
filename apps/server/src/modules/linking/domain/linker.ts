/**
 * Linker decision core (06 §3.7–3.10, L3 rule score, L4 vote aggregation, L5 NIL, L6 confidence, L7 decision,
 * L8 scene consistency). Pure: candidate generation and canon look-ups are done by the application layer.
 *
 * MVP-α scope (09 MA-3): `descriptive` mentions never auto-link (→ ambiguous), L4 uses 1 sample.
 */
import type { LinkStatus, MentionKind } from "@ncs/shared";

export const LINKER_VERSION = "linker@0.1.0+cal0";

export interface CandidateFeatures {
  /** L2 pass the candidate came from */
  matchKind: "exact" | "normalized" | "jamo" | "translit" | "trigram" | "title_holder" | "title_prev_holder" | "title_self" | "chain" | "scene" | "hint";
  nameId?: string | null;
  nameKind?: string | null;
  /** title resolution: the title entity the surface named (via_entity_id) */
  viaEntityId?: string | null;
  currentHolder?: boolean;
  prevHolder?: boolean;
  deadAtPoint?: boolean;
  nameOutOfRange?: boolean;
  nameNotUsable?: boolean;
  hiddenVariant?: boolean;
  confusable?: boolean;
  distinctPair?: boolean;
  noNameMatch?: boolean;
  writerHintMatch?: boolean;
  candidateEntityStatus?: "candidate" | "active";
  baseScore: number;
}

export interface LinkCandidate {
  entityId: string;
  /** display (prompt card) */
  label: string;
  features: CandidateFeatures;
  ruleScore: number;
}

export type Vote = { kind: "entity"; entityId: string } | { kind: "NIL" } | { kind: "NON_ENTITY" } | { kind: "UNSURE" };

export interface Thresholds {
  tauAuto: Record<MentionKind, number | null>;
  tauAsk: number;
  marginDelta: number;
  requireUnanimous: boolean;
  hiddenVariantCap: number;
  candidateTopK: number;
}

/** L3: penalties, never exclusion (06 §3.8) */
export function ruleScore(f: CandidateFeatures, cap: number): number {
  let s = f.baseScore;
  if (f.deadAtPoint) s -= 0.5;
  if (f.nameOutOfRange) s -= 0.3;
  if (f.nameNotUsable) s -= 0.3;
  if (f.prevHolder) s -= 0.2;
  if (f.matchKind === "title_self") s -= 0.3;
  if (f.noNameMatch) s = Math.min(s, 0.5);
  if (f.hiddenVariant) s = Math.min(s, cap);
  if (f.writerHintMatch) s += 0.05;
  return Math.max(0, Math.min(1, Math.round(s * 1000) / 1000));
}

/** candidate truncation: deterministic priority, then top-k (06 §3.8 "후보 자르기") */
export function truncateCandidates(cands: LinkCandidate[], k: number): { kept: LinkCandidate[]; truncated: boolean } {
  const pr = (c: LinkCandidate) =>
    (c.features.matchKind === "scene" ? 5 : 0) + (c.features.matchKind === "chain" ? 4 : 0) + (c.features.currentHolder ? 3 : 0) + (c.features.nameOutOfRange ? 0 : 1) + c.ruleScore;
  const sorted = [...cands].sort((a, b) => pr(b) - pr(a) || a.entityId.localeCompare(b.entityId));
  return { kept: sorted.slice(0, k), truncated: sorted.length > k };
}

/**
 * Deterministic L4 rule when no model run is available:
 * the unique current title holder, else the unique non-title candidate, else UNSURE.
 */
export function ruleJudge(cands: LinkCandidate[]): Vote {
  const holders = cands.filter((c) => c.features.currentHolder);
  if (holders.length === 1) return { kind: "entity", entityId: holders[0]!.entityId };
  const real = cands.filter((c) => c.features.matchKind !== "title_self" && !c.features.prevHolder);
  if (real.length === 1 && !real[0]!.features.noNameMatch) return { kind: "entity", entityId: real[0]!.entityId };
  if (cands.length === 0) return { kind: "NIL" };
  return { kind: "UNSURE" };
}

export interface LinkDecision {
  linkStatus: LinkStatus;
  linkedEntityId: string | null;
  viaEntityId: string | null;
  viaNameId: string | null;
  confidence: number;
  /** question = entity_disambiguation question; report = 리포트 보류 (no question); none */
  followUp: "none" | "question" | "report" | "new_entity" | "duplicate_question";
  rationale: string;
  scores: Array<{ entityId: string; score: number }>;
}

export interface DecideInput {
  mentionKind: MentionKind;
  sourceKind: "manuscript" | "answer" | "user_input" | "series_bible" | "import";
  candidates: LinkCandidate[];
  truncated: boolean;
  votes: Vote[];
}

/** L5–L7 */
export function decide(input: DecideInput, th: Thresholds): LinkDecision {
  const { candidates, votes } = input;
  const n = Math.max(1, votes.length);
  const count = (pred: (v: Vote) => boolean) => votes.filter(pred).length;
  const nil = count((v) => v.kind === "NIL");
  const non = count((v) => v.kind === "NON_ENTITY");
  // L5 NIL / NON_ENTITY
  if (candidates.length === 0 || (nil > n / 2 && !input.truncated)) {
    if (non === n && input.mentionKind === "descriptive") {
      return { linkStatus: "rejected", linkedEntityId: null, viaEntityId: null, viaNameId: null, confidence: 1, followUp: "none", rationale: "L5: 비엔티티(만장일치)", scores: [] };
    }
    if (input.mentionKind === "named" && non === 0) {
      return { linkStatus: "new_entity_candidate", linkedEntityId: null, viaEntityId: null, viaNameId: null, confidence: 0.5, followUp: "new_entity", rationale: "L5: 후보 없음(NIL) → 신규 후보", scores: [] };
    }
    return { linkStatus: "ambiguous", linkedEntityId: null, viaEntityId: null, viaNameId: null, confidence: 0, followUp: input.mentionKind === "zero" ? "report" : "question", rationale: "L5: 후보 없음", scores: [] };
  }
  if (non > n / 2) {
    if (non === n && input.mentionKind === "descriptive") {
      return { linkStatus: "rejected", linkedEntityId: null, viaEntityId: null, viaNameId: null, confidence: 1, followUp: "none", rationale: "L5: 비엔티티(만장일치)", scores: [] };
    }
    return { linkStatus: "ambiguous", linkedEntityId: null, viaEntityId: null, viaNameId: null, confidence: 0, followUp: "question", rationale: "L5: 비엔티티 판정(비만장일치) → 판별 대기(G16)", scores: [] };
  }
  // L6 confidence
  const scored = candidates
    .map((c) => {
      const a = count((v) => v.kind === "entity" && v.entityId === c.entityId) / n;
      return { c, a, score: Math.round((0.6 * a + 0.4 * c.ruleScore) * 1000) / 1000 };
    })
    .sort((x, y) => y.score - x.score || x.c.entityId.localeCompare(y.c.entityId));
  const top = scored[0]!;
  const second = scored[1];
  const c1 = top.score;
  const margin = c1 - (second?.score ?? 0);
  const unanimous = top.a === 1;
  const tau = th.tauAuto[input.mentionKind];
  const f = top.c.features;
  const forbidden =
    tau === null ||
    input.mentionKind === "descriptive" || // MVP-α: descriptive → ambiguous
    f.confusable ||
    f.noNameMatch ||
    (input.sourceKind === "answer" && ["pronoun", "zero", "address", "descriptive"].includes(input.mentionKind));
  const base = {
    viaEntityId: f.viaEntityId ?? null,
    viaNameId: f.nameId ?? null,
    confidence: Math.max(0, Math.min(1, c1)),
    scores: scored.map((s) => ({ entityId: s.c.entityId, score: s.score })),
  };
  if (!forbidden && tau !== null && c1 >= tau && margin >= th.marginDelta && (!th.requireUnanimous || unanimous) && !input.truncated) {
    // linking to a still-candidate entity keeps the mention pending until EN3 (MN3)
    const status: LinkStatus = f.candidateEntityStatus === "candidate" ? "new_entity_candidate" : "auto_linked";
    return { ...base, linkStatus: status, linkedEntityId: top.c.entityId, followUp: "none", rationale: `L7 자동 확정 c=${c1} margin=${margin.toFixed(3)}` };
  }
  const contested = margin < th.marginDelta || !unanimous || input.truncated;
  if (input.mentionKind === "zero") {
    return { ...base, linkStatus: "ambiguous", linkedEntityId: null, followUp: "report", rationale: `영형 언급은 자동 확정하지 않습니다(c=${c1})` };
  }
  if (c1 >= th.tauAsk && !contested && !forbidden) {
    return { ...base, linkStatus: "ambiguous", linkedEntityId: null, followUp: "report", rationale: `리포트 보류 c=${c1}` };
  }
  return { ...base, linkStatus: "ambiguous", linkedEntityId: null, followUp: "question", rationale: `판별 필요 c=${c1} margin=${margin.toFixed(3)}${input.truncated ? " (후보 잘림)" : ""}` };
}

/** L8 (a): a chain whose mentions point at different entities is demoted to ambiguous */
export function sceneConsistency<T extends { chainKey?: string | null; sceneId?: string | null; decision: LinkDecision }>(items: T[]): T[] {
  const byChain = new Map<string, T[]>();
  for (const it of items) {
    if (!it.chainKey) continue;
    const k = `${it.sceneId ?? ""}|${it.chainKey}`;
    byChain.set(k, [...(byChain.get(k) ?? []), it]);
  }
  for (const list of byChain.values()) {
    const linked = new Set(list.map((x) => x.decision.linkedEntityId).filter(Boolean));
    if (linked.size > 1) {
      for (const x of list) {
        if (x.decision.linkStatus === "rejected") continue;
        x.decision = { ...x.decision, linkStatus: "ambiguous", linkedEntityId: null, followUp: "question", rationale: `${x.decision.rationale}; L8 체인 충돌` };
      }
    }
  }
  return items;
}

/** 06 §3.10 묶기 규칙: (scene, chain, key, candidate set); zero/pronoun/descriptive only with a chain */
export function questionGroupKey(m: { sceneId?: string | null; chainKey?: string | null; normalizedKey: string; mentionKind: MentionKind; candidateIds: string[]; index: number }): string {
  if (["zero", "pronoun", "descriptive"].includes(m.mentionKind) && !m.chainKey) return `single:${m.index}`;
  return `${m.sceneId ?? ""}|${m.chainKey ?? ""}|${m.normalizedKey}|${[...m.candidateIds].sort().join(",")}`;
}
