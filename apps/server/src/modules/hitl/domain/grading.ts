/**
 * Question grading (05 §4): G1 topic default → G2 deterministic upgrade rules (U1–U7) → G3 LLM
 * (`grade_question`, async, upgrade only) → G4 agent proposal (upgrade only) → G5 record.
 * Grading only ever raises the grade (FR-HIL-07). Pure.
 */
import { z } from "zod";
import { ENUMS, type ApprovalType, type BlockingBasis, type QuestionGrade, type QuestionTopic, type QuestionType, type RefType } from "@ncs/shared";

export interface TopicRule {
  grade: Exclude<QuestionGrade, "informational">;
  basis: BlockingBasis;
  /** non_blocking deadline behaviour (05 §4.3) */
  defaultAction: "apply" | "hold";
  /** grade comes from the parent question (interpretation_confirm / followup) */
  inherit?: boolean;
  /** G3 LLM judgement useful (rules alone cannot decide, 04 §3 grade_question) */
  llmGraded?: boolean;
}

/** 05 §3.3 topic catalogue (G1). */
export const TOPIC_RULES: Record<QuestionTopic, TopicRule> = {
  direction: { grade: "blocking", basis: "ending_direction", defaultAction: "hold" },
  concept_confirm: { grade: "blocking", basis: "approval_gate", defaultAction: "hold" },
  bible_confirm: { grade: "blocking", basis: "approval_gate", defaultAction: "hold" },
  character_fate: { grade: "non_blocking", basis: "none", defaultAction: "apply", llmGraded: true },
  creative_choice: { grade: "non_blocking", basis: "none", defaultAction: "apply", llmGraded: true },
  setup_due: { grade: "non_blocking", basis: "none", defaultAction: "apply" },
  setup_abandon: { grade: "blocking", basis: "approval_gate", defaultAction: "hold" },
  entity_disambiguation: { grade: "non_blocking", basis: "none", defaultAction: "hold" },
  duplicate_entity: { grade: "non_blocking", basis: "none", defaultAction: "hold" },
  identity_change: { grade: "non_blocking", basis: "none", defaultAction: "hold" },
  schema_change: { grade: "blocking", basis: "approval_gate", defaultAction: "hold" },
  interpretation_confirm: { grade: "non_blocking", basis: "none", defaultAction: "hold", inherit: true },
  followup: { grade: "non_blocking", basis: "none", defaultAction: "hold", inherit: true },
  approval_gate: { grade: "blocking", basis: "approval_gate", defaultAction: "hold" },
  rewrite_limit: { grade: "blocking", basis: "rewrite_limit", defaultAction: "hold" },
  extraction_failure: { grade: "blocking", basis: "system_failure", defaultAction: "hold" },
  budget: { grade: "blocking", basis: "budget", defaultAction: "hold" },
  provider_outage: { grade: "blocking", basis: "system_failure", defaultAction: "hold" },
  retcon: { grade: "blocking", basis: "published_canon", defaultAction: "hold" },
  late_answer_conflict: { grade: "non_blocking", basis: "none", defaultAction: "hold" },
  publish_batch: { grade: "blocking", basis: "approval_gate", defaultAction: "hold" },
  media_gate: { grade: "blocking", basis: "approval_gate", defaultAction: "hold" },
  safety_review: { grade: "blocking", basis: "safety_review", defaultAction: "hold" },
} as Record<QuestionTopic, TopicRule>;

/** INV-Q-04 / INV-Q-06: never auto-applied at the deadline */
export const HOLD_TOPICS: ReadonlySet<QuestionTopic> = new Set<QuestionTopic>([
  "entity_disambiguation",
  "duplicate_entity",
  "identity_change",
  "interpretation_confirm",
  "late_answer_conflict",
  "setup_abandon",
]);

/** approval type → (topic, blocking basis) (05 §10.1, §3.3) */
export function approvalQuestionShape(t: ApprovalType): { topic: QuestionTopic; basis: BlockingBasis } {
  switch (t) {
    case "concept_brief":
      return { topic: "concept_confirm", basis: "approval_gate" };
    case "series_bible":
      return { topic: "bible_confirm", basis: "approval_gate" };
    case "setup_abandon":
      return { topic: "setup_abandon", basis: "approval_gate" };
    case "schema_change":
      return { topic: "schema_change", basis: "approval_gate" };
    case "retcon":
      return { topic: "retcon", basis: "published_canon" };
    case "budget_resume":
      return { topic: "budget", basis: "budget" };
    case "publish_batch":
      return { topic: "publish_batch", basis: "approval_gate" };
    case "identity_change":
      return { topic: "identity_change", basis: "published_canon" };
    case "safety_review":
      return { topic: "safety_review", basis: "safety_review" };
    case "ending_change":
      return { topic: "approval_gate", basis: "ending_direction" };
    case "canon_change":
      return { topic: "approval_gate", basis: "canon_change" };
    case "character_sheet":
    case "media_quote":
    case "draft_adoption":
      return { topic: "media_gate", basis: "approval_gate" };
    default:
      return { topic: "approval_gate", basis: "approval_gate" };
  }
}

/** Deterministic facts the asking module knows about the decision (G2 inputs, 05 §4.2). */
export const gradeHintsSchema = z
  .object({
    /** U1: an option changes an `approved` fact / setup */
    touchesApprovedCanon: z.boolean().optional(),
    /** U1/U2: touches a `published_locked` fact or is the basis of a high continuity issue */
    touchesPublishedCanon: z.boolean().optional(),
    /** U3: a linked character is a major character and an option changes life/death state */
    majorCharacterFate: z.boolean().optional(),
    /** U4 */
    endingDirection: z.boolean().optional(),
    arcGoal: z.boolean().optional(),
    /** U5: an option changes limits / reservation policy */
    budgetChange: z.boolean().optional(),
    /** U7: setup importance high or before planning the arc's last episode */
    setupDueHigh: z.boolean().optional(),
  })
  .strict();
export type GradeHints = z.infer<typeof gradeHintsSchema>;

export interface GradeInput {
  topic: QuestionTopic;
  questionType: QuestionType;
  links: Array<{ type: RefType; id: string }>;
  hints?: GradeHints;
  proposedBlockingBasis?: BlockingBasis | null;
  /** U6: question linked to an approval */
  approval?: { basis: BlockingBasis } | null;
  /** interpretation_confirm / followup inherit the parent's grade */
  parent?: { grade: QuestionGrade; basis: BlockingBasis } | null;
  notice?: boolean;
}

export interface GradeResult {
  grade: QuestionGrade;
  basis: BlockingBasis;
  reason: string;
  /** rules could not settle it — schedule `grade_question` (G3) */
  needsLlm: boolean;
}

const GRADE_KO: Record<QuestionGrade, string> = { blocking: "차단형", non_blocking: "비차단형", informational: "정보성" };

export function gradeQuestion(input: GradeInput): GradeResult {
  if (input.notice) {
    if (input.proposedBlockingBasis && input.proposedBlockingBasis !== "none") {
      throw new Error("informational notice cannot carry a blocking basis");
    }
    return { grade: "informational", basis: "none", reason: "G1 정보성 알림", needsLlm: false };
  }
  const rule = TOPIC_RULES[input.topic];
  let grade: Exclude<QuestionGrade, "informational"> = rule.grade;
  let basis: BlockingBasis = rule.basis;
  const reasons: string[] = [];
  if (rule.inherit && input.parent && input.parent.grade !== "informational") {
    grade = input.parent.grade;
    basis = input.parent.basis;
    reasons.push(`G1 원 질문과 같은 등급: ${GRADE_KO[grade]}`);
  } else {
    if (input.topic === "direction" && input.links.some((l) => l.type === "arc") && !input.links.some((l) => l.type === "goal")) basis = "arc_goal";
    if (input.topic === "identity_change" && input.questionType === "approve_reject") {
      grade = "blocking";
      basis = "published_canon";
    }
    reasons.push(`G1 주제 기본값: ${GRADE_KO[grade]}`);
  }

  const raise = (b: BlockingBasis, why: string) => {
    if (grade !== "blocking") {
      grade = "blocking";
      basis = b;
    }
    reasons.push(why);
  };
  const h = input.hints ?? {};
  // G2 deterministic upgrades (05 §4.2)
  if (input.approval) raise(input.approval.basis, "U6 승인 게이트");
  if (h.touchesPublishedCanon) raise("published_canon", "U2 공개 사실 영향");
  if (h.touchesApprovedCanon) raise("canon_change", "U1 캐논 변경");
  if (h.majorCharacterFate) raise("major_character_fate", "U3 주요 인물 생사");
  if (h.endingDirection || input.links.some((l) => l.type === "goal")) raise("ending_direction", "U4 결말 방향");
  if (h.arcGoal) raise("arc_goal", "U4 아크 목표");
  if (h.budgetChange || input.links.some((l) => l.type === "budget_policy")) raise("budget", "U5 예산");
  if (h.setupDueHigh && input.topic === "setup_due") raise("setup_due_high", "U7 떡밥 기한(중요도 높음)");
  // G4 agent proposal (upgrade only)
  if (input.proposedBlockingBasis && input.proposedBlockingBasis !== "none") raise(input.proposedBlockingBasis, `G4 에이전트 제안: ${input.proposedBlockingBasis}`);

  const decided = grade === "blocking" || Object.keys(h).length > 0;
  return { grade, basis: grade === "blocking" ? basis : "none", reason: reasons.join("; "), needsLlm: !decided && !!rule.llmGraded };
}

/** G3 structured output of `grade_question` (validated with zod; upgrade only). */
export const gradeQuestionOutputSchema = z.object({
  blocking: z.boolean(),
  basis: z.enum(["ending_direction", "arc_goal", "major_character_fate", "canon_change", "published_canon", "none"]).default("none"),
  reason_ko: z.string().max(300).default(""),
});
export type GradeQuestionOutput = z.infer<typeof gradeQuestionOutputSchema>;

export function applyLlmGrade(current: { grade: QuestionGrade; basis: BlockingBasis }, out: GradeQuestionOutput): { grade: QuestionGrade; basis: BlockingBasis; changed: boolean } {
  if (current.grade !== "non_blocking" || !out.blocking || out.basis === "none") return { ...current, changed: false };
  return { grade: "blocking", basis: out.basis, changed: true };
}

export const BLOCKING_BASIS_VALUES = ENUMS.blocking_basis;

// ── 설계 추가 0014: 질문 민감도 (완전 자율 자동 응답 대상 판정) ──
/** topics never auto-answered in full_auto (hold topics + always-human decisions + system failures) */
export const HIGH_SENSITIVITY_TOPICS: ReadonlySet<QuestionTopic> = new Set<QuestionTopic>([
  // 설계 추가 0015: entity_disambiguation / duplicate_entity are non-canon link decisions (normal: the autopilot may answer
  // them with the recommendation). They stay HOLD topics (never applied at the deadline). A merge that touches
  // published/approved canon is raised by gradeHints / the identity_change approval.
  ...[...HOLD_TOPICS].filter((t) => t !== "entity_disambiguation" && t !== "duplicate_entity"),
  "retcon",
  "setup_abandon",
  "budget",
  "direction",
  "schema_change",
  "identity_change",
  "safety_review",
  "provider_outage",
  "extraction_failure",
  "publish_batch",
  "media_gate",
  "rewrite_limit",
]);
/** blocking bases that always need the author */
export const HIGH_SENSITIVITY_BASES: ReadonlySet<BlockingBasis> = new Set<BlockingBasis>([
  "ending_direction",
  "canon_change",
  "published_canon",
  "major_character_fate",
  "budget",
  "safety_review",
  "system_failure",
  "rewrite_limit",
]);

/** high = the autopilot never answers it (agents may only raise it; hints that touch canon / fate / ending raise it) */
export function questionSensitivity(i: { topic: QuestionTopic; basis: BlockingBasis; hints?: GradeHints; proposed?: "high" | null }): "normal" | "high" {
  if (i.proposed === "high") return "high";
  if (HIGH_SENSITIVITY_TOPICS.has(i.topic) || HIGH_SENSITIVITY_BASES.has(i.basis)) return "high";
  const h = i.hints ?? {};
  if (h.touchesApprovedCanon || h.touchesPublishedCanon || h.majorCharacterFate || h.endingDirection || h.budgetChange) return "high";
  return "normal";
}
