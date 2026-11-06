/** 04 §9.5 section ranks + token budgeting. Pure. */
import type { AgentRole } from "@ncs/shared";
import { DEFAULTS } from "@ncs/shared";
import type { ContextSectionKind } from "../index.js";

export const SECTION_RANK: Readonly<Record<ContextSectionKind, number>> = {
  instruction: 1,
  constraints: 2,
  assigned_beats: 2,
  outline: 2,
  entity_cards: 3,
  pov_names: 3,
  knowledge: 3,
  canon_1hop: 4,
  glossary: 5,
  canon_2hop: 6,
  candidates: 6,
  unresolved_surfaces: 6,
  recent_text: 7,
  cast: 3,
  story_plan: 2,
  world: 3,
};

export const SECTION_TITLE: Readonly<Record<ContextSectionKind, string>> = {
  instruction: "작업 지시",
  constraints: "제약 (반드시 지킴)",
  assigned_beats: "배정된 떡밥 비트",
  outline: "아웃라인",
  entity_cards: "엔티티 카드",
  pov_names: "서술·대사에 쓰면 안 되는 표기",
  knowledge: "인물 지식",
  canon_1hop: "캐논 사실",
  glossary: "용어집",
  canon_2hop: "관련 사실(2홉)",
  candidates: "미확정 사실 (확정 아님)",
  unresolved_surfaces: "미해결 표기 (후보 카드)",
  recent_text: "직전 내용",
  cast: "캐릭터 설정 (확정)",
  story_plan: "작품 구성 (결말·부·플롯·이번 화 계획)",
  world: "세계관 온톨로지 (승인된 설정 + 미확정 후보 표시)",
};

/** only ranks 4–7 may be dropped (04 §9.5) */
export const isDroppable = (s: ContextSectionKind) => SECTION_RANK[s] >= 4;

export function maxInputTokensFor(role: AgentRole): number {
  if (role === "writer") return DEFAULTS["context.max_input_tokens.writer"];
  if (role === "concept_partner") return DEFAULTS["context.max_input_tokens.concept_partner"];
  return DEFAULTS["context.max_input_tokens.default"];
}

export interface BudgetItem {
  section: ContextSectionKind;
  tokenEstimate: number;
}

export type BudgetDecision<T extends BudgetItem> = { ok: true; kept: T[]; dropped: ContextSectionKind[]; total: number } | { ok: false; required: number; max: number };

/**
 * Keep everything if it fits; otherwise drop droppable sections from the lowest priority (rank 7 → 4),
 * larger sections first within a rank. Ranks 1–3 alone over the limit → not ok (FR-AGT-10: never cut silently).
 */
export function fitSections<T extends BudgetItem>(items: T[], headerTokens: number, max: number): BudgetDecision<T> {
  let total = headerTokens + items.reduce((s, i) => s + i.tokenEstimate, 0);
  if (total <= max) return { ok: true, kept: items, dropped: [], total };
  const order = items
    .map((it, idx) => ({ it, idx }))
    .filter(({ it }) => isDroppable(it.section))
    .sort((a, b) => SECTION_RANK[b.it.section] - SECTION_RANK[a.it.section] || b.it.tokenEstimate - a.it.tokenEstimate);
  const droppedIdx = new Set<number>();
  for (const { it, idx } of order) {
    if (total <= max) break;
    droppedIdx.add(idx);
    total -= it.tokenEstimate;
  }
  if (total > max) return { ok: false, required: total, max };
  const dropped = [...new Set(items.filter((_, i) => droppedIdx.has(i)).map((i) => i.section))];
  return { ok: true, kept: items.filter((_, i) => !droppedIdx.has(i)), dropped, total };
}

/** same estimator as llm (Hangul ≈ 1 token/char, other ≈ 1/4) */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0xac00 && c <= 0xd7a3) || (c >= 0x3130 && c <= 0x318f) || (c >= 0x4e00 && c <= 0x9fff)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 4);
}

/** 9.6 handles: E<n> = 1-based position in snapshot entity_ids */
export function entityHandle(index: number): string {
  return `E${index + 1}`;
}

export function parseHandle(h: string): { kind: "E" | "N"; index: number } | null {
  const m = /^([EN])(\d{1,4})$/.exec(h.trim());
  if (!m) return null;
  const n = Number(m[2]);
  return n >= 1 ? { kind: m[1] as "E" | "N", index: n - 1 } : null;
}
