/**
 * DTOs of the `hitl` module (05; CONVENTIONS §13 인박스). Responses are camelCase row fields,
 * timestamps ISO strings. Option ids are the option index as a string ("0", "1", …).
 */
import { z } from "zod";
import { ENUMS } from "../enum-registry.js";
import { isoDateTime } from "./common.js";

/** comma separated enum list in a query string (`status=open,pending`) */
const csvEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(z.enum(values)));

export const hitlQuestionListQuerySchema = z.object({
  status: csvEnum(ENUMS.question_status).optional(),
  grade: csvEnum(ENUMS.question_grade).optional(),
  topic: csvEnum(ENUMS.question_topic).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
export type HitlQuestionListQuery = z.infer<typeof hitlQuestionListQuerySchema>;

export const hitlApprovalListQuerySchema = z.object({
  status: csvEnum(ENUMS.approval_status).optional(),
  type: csvEnum(ENUMS.approval_type).optional(),
});

export const hitlApprovalDecisionSchema = z
  .object({
    decision: z.enum(["approved", "rejected"]),
    decisionNote: z.string().trim().max(4000).optional(),
    reworkFrom: z.enum(ENUMS.rework_from).optional(),
  })
  .refine((d) => d.decision === "approved" || !!d.decisionNote, { message: "반려 사유를 입력하세요.", path: ["decisionNote"] });
export type HitlApprovalDecision = z.infer<typeof hitlApprovalDecisionSchema>;

/** POST …/questions/:questionId/answers */
export const hitlAnswerRequestSchema = z
  .object({
    optionIds: z.array(z.string().regex(/^\d{1,3}$/)).max(25).optional(),
    text: z.string().trim().max(4000).optional(),
    approval: hitlApprovalDecisionSchema.optional(),
    /** client idempotency key (retries of the same submit are replays) */
    requestId: z.string().min(8).max(100).optional(),
  })
  .refine((d) => !!d.optionIds?.length || !!d.text || !!d.approval, { message: "선택지를 고르거나 답을 입력하세요." });
export type HitlAnswerRequest = z.infer<typeof hitlAnswerRequestSchema>;

/** POST …/approvals/:approvalId/decision */
export const hitlApprovalDecisionRequestSchema = hitlApprovalDecisionSchema;

export const hitlLateAnswerResolutionRequestSchema = z.object({ resolution: z.literal("dismissed") });

export const hitlAnswerResultSchema = z.object({
  disposition: z.enum(ENUMS.answer_disposition),
  answerId: z.string(),
});
export type HitlAnswerResult = z.infer<typeof hitlAnswerResultSchema>;

export const hitlQuestionDtoSchema = z.object({
  id: z.string(),
  novelId: z.string(),
  displayNo: z.number().int(),
  grade: z.enum(ENUMS.question_grade),
  questionType: z.enum(ENUMS.question_type),
  topic: z.enum(ENUMS.question_topic),
  status: z.enum(ENUMS.question_status),
  title: z.string(),
  body: z.string(),
  rationale: z.string(),
  blockingBasis: z.enum(ENUMS.blocking_basis),
  gradeReason: z.string(),
  deadlineAt: isoDateTime.nullable(),
  reminderCount: z.number().int(),
  approvalId: z.string().nullable(),
  parentQuestionId: z.string().nullable(),
  acceptedAnswerId: z.string().nullable(),
  resolutionSource: z.enum(ENUMS.resolution_source).nullable(),
  sentAt: isoDateTime.nullable(),
  answeredAt: isoDateTime.nullable(),
  resolvedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
});
export type HitlQuestionDto = z.infer<typeof hitlQuestionDtoSchema>;

export const hitlAnswerDtoSchema = z.object({
  id: z.string(),
  questionId: z.string(),
  channelId: z.string(),
  responderUserId: z.string(),
  receivedAt: isoDateTime,
  payload: z.object({
    selected_idx: z.array(z.number().int()),
    text: z.string().optional(),
    decision: z.enum(["approved", "rejected"]).optional(),
    decision_note: z.string().optional(),
    rework_from: z.enum(ENUMS.rework_from).optional(),
  }).passthrough(),
  disposition: z.enum(ENUMS.answer_disposition),
  lateResolution: z.enum(ENUMS.late_answer_resolution).nullable(),
});

const previewDto = z.object({ label: z.string(), text: z.string(), ref: z.object({ refType: z.string(), refId: z.string() }).optional() });

export const hitlApprovalDtoSchema = z.object({
  id: z.string(),
  novelId: z.string(),
  approvalType: z.enum(ENUMS.approval_type),
  status: z.enum(ENUMS.approval_status),
  subjectType: z.enum(ENUMS.ref_type),
  subjectId: z.string(),
  questionId: z.string(),
  payload: z.unknown(),
  decidedByUserId: z.string().nullable(),
  decidedAt: isoDateTime.nullable(),
  decisionNote: z.string().nullable(),
  reworkFrom: z.enum(ENUMS.rework_from).nullable(),
  supersededById: z.string().nullable(),
  createdAt: isoDateTime,
});
export type HitlApprovalDto = z.infer<typeof hitlApprovalDtoSchema>;

/** GET …/questions/:questionId — QuestionView (05 §3.2) + state */
export const hitlQuestionViewSchema = z.object({
  questionId: z.string(),
  novelId: z.string(),
  displayNo: z.string(),
  grade: z.enum(ENUMS.question_grade),
  topic: z.enum(ENUMS.question_topic),
  questionType: z.enum(ENUMS.question_type),
  targetLabel: z.string(),
  title: z.string(),
  body: z.string(),
  preview: z.array(previewDto),
  recommendation: z.object({ label: z.string(), rationale: z.string() }).nullable(),
  blockingBasisLabel: z.string().nullable(),
  gradeReason: z.string().nullable(),
  options: z.array(z.object({ optionId: z.string(), label: z.string(), value: z.unknown(), isRecommended: z.boolean() })),
  allowFreeText: z.boolean(),
  deadline: z.object({ at: isoDateTime, wallClock: z.string(), afterLabel: z.string() }).nullable(),
  webUrl: z.string(),
  status: z.enum(ENUMS.question_status),
  answers: z.array(hitlAnswerDtoSchema),
  approval: hitlApprovalDtoSchema.nullable().optional(),
  reflection: z
    .object({
      status: z.enum(ENUMS.reflection_status),
      notAppliedReason: z.string().nullable(),
      items: z.array(z.object({ changeKind: z.enum(ENUMS.reflection_change_kind), refType: z.string().nullable(), refId: z.string().nullable(), summary: z.string() })),
    })
    .nullable()
    .optional(),
});
export type HitlQuestionView = z.infer<typeof hitlQuestionViewSchema>;


/** GET …/inbox/summary */
export const hitlInboxSummarySchema = z.object({
  blocking: z.number().int(),
  nonBlocking: z.number().int(),
  informational: z.number().int(),
  approvals: z.number().int(),
  earliestDeadlineAt: isoDateTime.nullable(),
  open: z.number().int(),
  pending: z.number().int(),
  lateAnswers: z.number().int(),
  pendingReflections: z.number().int(),
});
export type HitlInboxSummary = z.infer<typeof hitlInboxSummarySchema>;
