/**
 * Structured LLM output contracts (design/11 §2.7 ConceptTurnProposal + import/check outputs).
 * Every field has a default so a minimal/empty model object still validates;
 * the deterministic commit fills the gaps (3.5: code decides which slot to ask).
 */
import { z } from "zod";
import { ENUMS } from "@ncs/shared/enums";

const str = (max: number) => z.string().max(max * 4).transform((s) => s.slice(0, max));

export const turnOptionSchema = z.object({
  label: str(80),
  value: z.string().max(400),
  is_recommended: z.boolean().default(false),
  rationale: z.string().max(400).default(""),
  risk: z.string().max(200).default(""),
  is_common_choice: z.boolean().default(false),
});

export const turnQuestionSchema = z.object({
  slot_key: z.string(),
  ask_text: str(300),
  options: z.array(turnOptionSchema).max(3).default([]),
  allow_free_text: z.boolean().default(true),
  allow_recommend: z.boolean().default(true),
  allow_defer: z.boolean().default(false),
});

export const slotUpdateClaimSchema = z.object({
  field_path: z.string(),
  new_value: z.unknown(),
  origin_claim: z.enum(["user_stated", "agent_proposed_accepted", "agent_proposed_modified", "agent_delegated"]).default("user_stated"),
  evidence_message_id: z.string().nullable().default(null),
  evidence_quote: z.string().default(""),
  key_phrase: z.string().default(""),
});
export type SlotUpdateClaim = z.infer<typeof slotUpdateClaimSchema>;

/** 설계 추가: 추천 제목 1개 (제목 + 한 줄 이유). 정리·중복 제거는 domain/title.ts가 합니다. */
export const titleSuggestionSchema = z.object({
  title: z.string().max(200),
  reason: z.string().max(800).default("").transform((s) => s.slice(0, 200)),
});
export type TitleSuggestionClaim = z.infer<typeof titleSuggestionSchema>;

export const conceptTurnProposalSchema = z.object({
  reply_text: z.string().max(4000).default(""),
  questions: z.array(turnQuestionSchema).max(2).default([]),
  user_intent: z.enum(ENUMS.concept_user_intent).default("other"),
  slot_updates: z.array(slotUpdateClaimSchema).max(40).default([]),
  change_proposals: z.array(z.object({ field_path: z.string(), new_value: z.unknown(), reason: z.string().default("") })).max(10).default([]),
  /**
   * 설계 추가: the user's answer in the chat to a pending change proposal (S1 '대기 중인 변경 제안').
   * Applied only when evidence_quote is the user's own words from a handled message (INV-CON-03).
   */
  proposal_decisions: z
    .array(
      z.object({
        proposal_id: z.string(),
        decision: z.enum(["accepted", "rejected"]),
        evidence_message_id: z.string().nullable().default(null),
        evidence_quote: z.string().default(""),
      }),
    )
    .max(10)
    .default([])
    .catch([]),
  weakness_notes: z.array(z.string().max(400)).max(4).default([]),
  safety_flags: z
    .array(
      z.object({
        field_path: z.string().nullable().default(null),
        message_id: z.string().nullable().default(null),
        kind: z.enum(["over_age_rating", "minor_sexual", "real_person"]),
        note: z.string().default(""),
      }),
    )
    .max(10)
    .default([]),
  copy_request_detected: z.object({ work_title: z.string(), quote: z.string().default(""), message_id: z.string().nullable().default(null) }).nullable().default(null),
  stage_signal: z.enum(ENUMS.concept_stage).nullable().default(null),
  /** confirming stage: 3 logline candidates (CQ-21) */
  logline_options: z.array(z.string().max(300)).max(3).default([]),
  /** delegated values the model recommends per field path (3.5 위임) */
  delegate_values: z.record(z.string(), z.unknown()).default({}),
  /**
   * 설계 추가: 지금까지의 대화를 반영한 작품 가제. null = 아직 정보 부족/사용자가 제목을 정함.
   * 브리프 슬롯이 아니라 작품 제목(title_source=auto)으로만 반영됩니다 — 비추측 규칙(INV-CON-03)과 무관.
   */
  working_title: z
    .object({ title: z.string().max(200), reason: z.string().max(400).default("") })
    .nullable()
    .default(null)
    .catch(null),
  /**
   * 설계 추가: 추천 제목 3~5개. 빈 배열 = 아직 내용이 부족하거나 기존 추천이 여전히 알맞음.
   * 세션 meta.title_suggestions에만 저장하고, 사용자가 고를 때까지 작품 제목을 확정하지 않습니다.
   */
  title_suggestions: z.array(titleSuggestionSchema).max(8).default([]).catch([]),
});
export type ConceptTurnProposal = z.infer<typeof conceptTurnProposalSchema>;

/** "다른 추천 받기" (concept_turn, input.titles=true) 출력 */
export const titleSuggestionsProposalSchema = z.object({
  suggestions: z.array(titleSuggestionSchema).min(1).max(8),
});
export type TitleSuggestionsProposal = z.infer<typeof titleSuggestionsProposalSchema>;

export const importProposalSchema = z.object({
  slot_updates: z.array(z.object({ field_path: z.string(), new_value: z.unknown() })).max(60).default([]),
  source_kind: z.enum(["synopsis", "bible", "notes"]).default("synopsis"),
  reply_text: z.string().max(4000).default(""),
});
export type ImportProposal = z.infer<typeof importProposalSchema>;

export const briefCheckProposalSchema = z.object({
  llm_overlap_signals: z.array(z.object({ work_title: z.string(), note: z.string().default("") })).max(10).default([]),
  safety_flags: z
    .array(z.object({ field_path: z.string().nullable().default(null), kind: z.enum(["over_age_rating", "minor_sexual", "real_person"]), note: z.string().default(""), name: z.string().default("") }))
    .max(10)
    .default([]),
  notes: z.array(z.string()).max(10).default([]),
});
export type BriefCheckProposal = z.infer<typeof briefCheckProposalSchema>;

export const EMPTY_TURN_PROPOSAL: ConceptTurnProposal = conceptTurnProposalSchema.parse({});
