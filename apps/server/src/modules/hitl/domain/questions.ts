/**
 * QuestionDraft validation (05 §2.3), recommendation jsonb (05 §4.3), option value schemas (05 §3.4),
 * answer normalization / CAS comparison (05 §6.2) and interpretation output (05 §7). Pure.
 */
import { z } from "zod";
import { ENUMS, type QuestionTopic, type QuestionType, type ReworkFrom } from "@ncs/shared";
import { DomainValidationError } from "../../../platform/errors.js";
import { gradeHintsSchema, HOLD_TOPICS, TOPIC_RULES } from "./grading.js";

const refSchema = z.object({ type: z.enum(ENUMS.ref_type), id: z.string().min(1) });

export const previewExcerptSchema = z.object({
  label: z.string().max(80),
  text: z.string().max(400),
  ref: z.object({ refType: z.string(), refId: z.string() }).optional(),
});

export const questionRecommendationSchema = z.object({
  optionValue: z.unknown(),
  defaultAction: z.enum(["apply", "hold"]),
  rationale: z.string().max(1000),
});

/** 05 §3.4 option values (all carry ids, never labels) */
const choiceValue = z.object({ kind: z.literal("choice"), key: z.string().min(1) }).passthrough();
export const OPTION_VALUE_SCHEMAS: Partial<Record<QuestionTopic, z.ZodType>> = {
  entity_disambiguation: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("entity"), entity_id: z.string(), matched_name_id: z.string().optional(), holder_basis: z.unknown().optional() }),
    z.object({ kind: z.literal("title_itself"), entity_id: z.string() }),
    z.object({ kind: z.literal("new_entity") }),
    z.object({ kind: z.literal("not_entity") }),
    z.object({ kind: z.literal("hold") }),
  ]),
  duplicate_entity: z.object({ kind: z.enum(["same", "distinct", "hold"]) }),
  identity_change: z.union([
    z.object({ kind: z.enum(["apply", "reject"]), identity_decision_id: z.string() }),
    choiceValue,
    z.object({ maps_to: z.enum(["approved", "rejected"]), variant: z.string() }),
  ]),
  setup_due: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("extend"), to_due_episode_no: z.number().int().positive() }),
    z.object({ kind: z.literal("assign"), episode_no: z.number().int().positive() }),
    z.object({ kind: z.literal("abandon") }),
  ]),
  rewrite_limit: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("human_edit") }),
    z.object({ kind: z.literal("hold") }),
    z.object({ kind: z.literal("waive_issue"), continuity_issue_ids: z.array(z.string()).min(1) }),
    z.object({ kind: z.literal("replan_from_outline") }),
    z.object({ kind: z.literal("replan") }),
  ]),
};
/** approve_reject idx ≥ 2: alternative decision */
const alternativeDecision = z.object({ maps_to: z.enum(["approved", "rejected"]), variant: z.string() }).passthrough();

export const questionDraftSchema = z
  .object({
    topic: z.enum(ENUMS.question_topic),
    questionType: z.enum(ENUMS.question_type),
    title: z.string().trim().min(1).max(200),
    body: z.string().max(8000),
    options: z.array(z.object({ label: z.string().trim().min(1).max(200), value: z.unknown(), isRecommended: z.boolean().optional() })).max(25),
    recommendation: questionRecommendationSchema.nullable().optional(),
    rationale: z.string().max(2000).optional(),
    links: z.array(refSchema).min(1, "질문에는 연결 대상이 하나 이상 있어야 합니다(INV-Q-05)."),
    preview: z.array(previewExcerptSchema).max(10).optional(),
    dependsOnQuestionId: z.string().regex(/^qst_/).nullable().optional(),
    proposedBlockingBasis: z.enum(ENUMS.blocking_basis).nullable().optional(),
    notice: z.boolean().optional(),
    allowFreeText: z.boolean().optional(),
    gradeHints: gradeHintsSchema.optional(),
  })
  .superRefine((d, ctx) => {
    const n = d.options.length;
    if (d.notice) {
      if (n) ctx.addIssue({ code: "custom", path: ["options"], message: "정보성 알림에는 선택지를 둘 수 없습니다." });
      return;
    }
    if ((d.questionType === "single_choice" || d.questionType === "multi_choice") && n < 2) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "선택형 질문에는 선택지가 2개 이상 있어야 합니다." });
    }
    if (d.questionType === "free_text" && n) ctx.addIssue({ code: "custom", path: ["options"], message: "서술형 질문에는 선택지를 두지 않습니다." });
    const schema = OPTION_VALUE_SCHEMAS[d.topic];
    d.options.forEach((o, i) => {
      if (d.questionType === "approve_reject") {
        if (i >= 2 && !alternativeDecision.safeParse(o.value).success) {
          ctx.addIssue({ code: "custom", path: ["options", i, "value"], message: "대안 결정은 maps_to·variant가 필요합니다." });
        }
        return;
      }
      if (schema && !schema.safeParse(o.value).success) ctx.addIssue({ code: "custom", path: ["options", i, "value"], message: `선택지 값 형식이 주제(${d.topic})와 맞지 않습니다.` });
    });
  });
export type ValidQuestionDraft = z.infer<typeof questionDraftSchema>;

/** stored in questions.recommendation (05 §4.3) + presentation metadata (see report: DDL request) */
export interface StoredRecommendation {
  option_idx: number | null;
  text: string | null;
  default_action: "apply" | "hold" | null;
  provisional: boolean;
  rationale: string;
  preview: Array<z.infer<typeof previewExcerptSchema>>;
  allow_free_text: boolean;
  origin_task_id: string | null;
}

export function readRecommendation(v: unknown): StoredRecommendation {
  const r = (v ?? {}) as Partial<StoredRecommendation>;
  return {
    option_idx: typeof r.option_idx === "number" ? r.option_idx : null,
    text: r.text ?? null,
    default_action: r.default_action ?? null,
    provisional: r.provisional ?? false,
    rationale: r.rationale ?? "",
    preview: r.preview ?? [],
    allow_free_text: r.allow_free_text ?? false,
    origin_task_id: r.origin_task_id ?? null,
  };
}

const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
export const sameValue = (a: unknown, b: unknown) => stable(a) === stable(b);

export function buildRecommendation(
  d: ValidQuestionDraft,
  grade: "blocking" | "non_blocking" | "informational",
  extra: { originTaskId: string | null; approval?: boolean },
): StoredRecommendation {
  const rule = TOPIC_RULES[d.topic];
  let idx: number | null = null;
  if (d.recommendation && d.recommendation.optionValue !== undefined) {
    const i = d.options.findIndex((o) => sameValue(o.value, d.recommendation!.optionValue));
    idx = i >= 0 ? i : null;
  }
  if (idx === null) {
    const i = d.options.findIndex((o) => o.isRecommended);
    idx = i >= 0 ? i : d.options.length ? 0 : null;
  }
  // INV-Q-04 / INV-Q-06: hold topics never auto-apply; blocking questions never default (INV-Q-02)
  let action: "apply" | "hold" = d.recommendation?.defaultAction ?? rule.defaultAction;
  if (HOLD_TOPICS.has(d.topic) || grade === "blocking" || extra.approval) action = "hold";
  return {
    option_idx: grade === "informational" ? null : idx,
    text: idx === null && d.questionType === "free_text" ? (d.recommendation?.rationale ?? null) : null,
    default_action: grade === "informational" ? null : action,
    provisional: false,
    rationale: d.recommendation?.rationale ?? d.rationale ?? "",
    preview: d.preview ?? [],
    allow_free_text: d.allowFreeText ?? (d.questionType === "free_text" || d.questionType === "single_choice"),
    origin_task_id: extra.originTaskId,
  };
}

// ── answers ─────────────────────────────────────────────────────────────
export interface AnswerPayload {
  selected_idx: number[];
  text?: string;
  decision?: "approved" | "rejected";
  decision_variant?: string;
  decision_note?: string;
  rework_from?: ReworkFrom;
  source_key: string;
}

export interface NormalizeInput {
  questionType: QuestionType;
  optionCount: number;
  optionValues: unknown[];
  isEpisodeApproval: boolean;
  optionIds?: string[];
  text?: string | null;
  approval?: { decision: "approved" | "rejected"; decisionNote?: string; reworkFrom?: ReworkFrom };
  sourceKey: string;
}

export function normalizeAnswer(i: NormalizeInput): AnswerPayload {
  const text = i.text?.trim() || undefined;
  const idxs = (i.optionIds ?? []).map((s) => Number(s));
  if (idxs.some((x) => !Number.isInteger(x) || x < 0 || x >= i.optionCount)) throw new DomainValidationError("invalid_option", "없는 선택지입니다.");
  const uniq = [...new Set(idxs)].sort((a, b) => a - b);
  const p: AnswerPayload = { selected_idx: uniq, source_key: i.sourceKey };
  switch (i.questionType) {
    case "single_choice":
      if (uniq.length > 1) throw new DomainValidationError("too_many_options", "선택지를 하나만 고르세요.");
      if (!uniq.length && !text) throw new DomainValidationError("empty_answer", "선택지를 고르거나 답을 입력하세요.");
      if (!uniq.length && text) p.text = text;
      return p;
    case "multi_choice":
      if (!uniq.length) throw new DomainValidationError("empty_answer", "선택지를 하나 이상 고르세요.");
      return p;
    case "free_text":
      if (!text) throw new DomainValidationError("empty_answer", "답을 입력하세요.");
      return { selected_idx: [], text, source_key: i.sourceKey };
    case "approve_reject":
    case "attachment_review": {
      let decision = i.approval?.decision;
      if (!decision) {
        if (uniq.length !== 1) throw new DomainValidationError("decision_required", "승인 또는 반려를 고르세요.");
        const idx = uniq[0]!;
        if (idx === 0) decision = "approved";
        else if (idx === 1) decision = "rejected";
        else {
          const alt = alternativeDecision.safeParse(i.optionValues[idx]);
          if (!alt.success) throw new DomainValidationError("invalid_option", "없는 선택지입니다.");
          decision = alt.data.maps_to;
          p.decision_variant = alt.data.variant;
        }
      } else if (!uniq.length) {
        p.selected_idx = [decision === "approved" ? 0 : 1];
      }
      p.decision = decision;
      const note = i.approval?.decisionNote?.trim() || text;
      if (decision === "rejected") {
        if (!note) throw new DomainValidationError("decision_note_required", "반려 사유를 입력하세요.");
        if (i.isEpisodeApproval && !i.approval?.reworkFrom) throw new DomainValidationError("rework_from_required", "어느 단계부터 다시 쓸지 고르세요.");
      }
      if (note) p.decision_note = note;
      if (i.approval?.reworkFrom) p.rework_from = i.approval.reworkFrom;
      return p;
    }
  }
}

/** 05 §6.2 step 4: same responder + same payload → duplicate, else late */
export function isDuplicateOf(a: AnswerPayload, accepted: AnswerPayload): boolean {
  const strip = ({ source_key: _s, ...rest }: AnswerPayload) => rest;
  return sameValue(strip(a), strip(accepted));
}

/** answer that needs interpretation before it can become canon (INV-AI-01, 05 §7.1 T1) */
export function needsInterpretation(questionType: QuestionType, p: AnswerPayload): boolean {
  if (questionType === "approve_reject" || questionType === "attachment_review") return false;
  return !!p.text;
}

// ── interpretation (05 §7) ──────────────────────────────────────────────
export const interpretationChangeSchema = z.object({
  kind: z.enum(["fact", "constraint", "task_change", "name_rule"]),
  description_ko: z.string().min(1).max(500),
  entity_ids: z.array(z.string()).default([]),
  fact_kind: z.enum(ENUMS.fact_kind).optional(),
  subject_entity_id: z.string().optional(),
  predicate: z.string().optional(),
  object_entity_id: z.string().optional(),
  story_range: z.object({ from: z.number().int(), to: z.number().int().nullable().optional() }).optional(),
  /** death / exit / identity reveal / merge — confirm with entity buttons, not free text (05 §7.1) */
  irreversible: z.boolean().default(false),
});
export const interpretAnswerOutputSchema = z.object({
  status: z.enum(["proposed", "needs_followup"]),
  summary_ko: z.string().min(1).max(1500),
  changes: z.array(interpretationChangeSchema).max(10).default([]),
  followup_question_ko: z.string().max(500).optional(),
});
export type InterpretAnswerOutput = z.infer<typeof interpretAnswerOutputSchema>;
export type InterpretationChange = z.infer<typeof interpretationChangeSchema>;

export function interpretationConfirmBody(out: InterpretAnswerOutput): string {
  const lines = out.changes.map((c, i) => `(${i + 1}) ${c.description_ko}`);
  return `다음 ${out.changes.length || 1}가지로 반영합니다:\n${lines.length ? lines.join("\n") : `(1) ${out.summary_ko}`}\n\n맞습니까?`;
}
