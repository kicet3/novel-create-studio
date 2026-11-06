/**
 * DTOs of the `concept` module (design/11 §4.1 web chat, §5.2–5.4). Owned by the concept module agent.
 * Paths: `…` = `/api/novels/:novelId`.
 */
import { z } from "zod";
import { ENUMS } from "../enum-registry.js";
import { isoDateTime, queryInt } from "./common.js";
import { llmWebSourceSchema } from "./llm.js";

// ── shared pieces ───────────────────────────────────────────────────────
export const conceptOptionDtoSchema = z.object({
  idx: z.number().int(),
  label: z.string(),
  value: z.string(),
  is_recommended: z.boolean().optional(),
  rationale: z.string().optional(),
  risk: z.string().optional(),
  is_common_choice: z.boolean().optional(),
  /** seed = fixed choice, agent = model candidate, control = reserved button (900 직접 입력, 901 추천해 줘, 902 나중에, 903 요약 보기, 904 이대로 정리, 905 전부 맡기기, 906 상한 올리기, 907 폼으로 마저 입력, 910+ 기타) */
  source: z.enum(["seed", "agent", "control"]),
  field_path: z.string().optional(),
});
export type ConceptOptionDto = z.infer<typeof conceptOptionDtoSchema>;

export const conceptSlotDiffDtoSchema = z.object({
  field_path: z.string(),
  before: z.unknown(),
  after: z.unknown(),
  origin: z.enum(ENUMS.concept_field_origin),
  slot_state: z.enum(ENUMS.concept_slot_state),
});

export const conceptFieldProvenanceDtoSchema = z.object({
  origin: z.enum(ENUMS.concept_field_origin),
  slot_state: z.enum(ENUMS.concept_slot_state),
  evidence_message_ids: z.array(z.string()),
  template_question_ref: z.string().optional(),
  history_count: z.number().int(),
});

export const conceptTitleSuggestionDtoSchema = z.object({ title: z.string(), reason: z.string() });
export type ConceptTitleSuggestionDto = z.infer<typeof conceptTitleSuggestionDtoSchema>;

// ── responses ───────────────────────────────────────────────────────────
export const conceptSessionDtoSchema = z.object({
  id: z.string(),
  novelId: z.string(),
  purpose: z.enum(ENUMS.concept_session_purpose),
  entryMode: z.enum(ENUMS.concept_entry_mode),
  baseBriefId: z.string().nullable(),
  status: z.enum(ENUMS.concept_session_status),
  stage: z.enum(ENUMS.concept_stage),
  pauseReason: z.enum(ENUMS.concept_pause_reason).nullable(),
  /** `{content, field_provenance, change_proposals, checks, meta}` (11 §5.4) */
  workingBrief: z.unknown(),
  fieldFlipCounts: z.unknown(),
  agentTurnCount: z.number().int(),
  userMessageCount: z.number().int(),
  turnLimit: z.number().int(),
  turnExtensionCount: z.number().int(),
  llmDisabled: z.boolean(),
  budgetLimitMicros: z.number().int(),
  spentMicros: z.number().int(),
  activeChannelId: z.string(),
  inFlightTaskId: z.string().nullable(),
  questionSetVersion: z.string(),
  pendingApprovalId: z.string().nullable(),
  approvedBriefId: z.string().nullable(),
  lastUserMessageAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type ConceptSessionDto = z.infer<typeof conceptSessionDtoSchema>;

export const conceptMessageDtoSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  seq: z.number().int(),
  authorKind: z.enum(ENUMS.concept_message_author),
  authorUserId: z.string().nullable(),
  runId: z.string().nullable(),
  channelId: z.string(),
  kind: z.enum(ENUMS.concept_message_kind),
  body: z.string(),
  options: z.array(conceptOptionDtoSchema).nullable(),
  pickedIdx: z.number().int().nullable(),
  askedFieldPaths: z.array(z.string()).nullable(),
  slotUpdates: z.array(conceptSlotDiffDtoSchema),
  respondsToSeq: z.number().int().nullable(),
  isSuperseded: z.boolean(),
  /** 설계 추가: 자동 승인 모드가 사용자 대신 고른 선택(author_kind=user, 위임) */
  autoApproved: z.boolean().default(false),
  /** 설계 추가 0011: 답변이 쓴 웹 검색 출처 (각주 "출처") */
  sources: z.array(llmWebSourceSchema).nullable().default(null),
  createdAt: isoDateTime,
});
export type ConceptMessageDto = z.infer<typeof conceptMessageDtoSchema>;

export const conceptBriefDtoSchema = z.object({
  id: z.string(),
  novelId: z.string(),
  sessionId: z.string(),
  versionNo: z.number().int(),
  status: z.enum(ENUMS.concept_brief_status),
  approvalId: z.string().nullable(),
  approvedAt: isoDateTime.nullable(),
  supersedesId: z.string().nullable(),
  authorActorType: z.enum(ENUMS.actor_type),
  authorActorId: z.string(),
  entryMode: z.enum(ENUMS.concept_entry_mode),
  questionSetVersion: z.string(),
  /** brief content + field_provenance + contribution_summary + checks */
  content: z.unknown(),
  contentMd: z.string(),
  createdAt: isoDateTime,
});
export type ConceptBriefDto = z.infer<typeof conceptBriefDtoSchema>;

/** 설계 추가: 자동 승인 모드 상태 (SessionView.autoApprove) */
export const CONCEPT_AUTO_APPROVE_STATUS = ["off", "running", "waiting_user"] as const;
export const CONCEPT_AUTO_APPROVE_STOP_REASONS = [
  "completed",
  "step_cap",
  "turn_cap",
  "budget",
  "error",
  "user_stopped",
  "toggled_off",
  "session_closed",
  "messenger",
] as const;
export const CONCEPT_AUTO_APPROVE_WAIT_REASONS = ["open_question", "user_field_proposal", "conflict"] as const;
export const conceptAutoApproveViewDtoSchema = z.object({
  enabled: z.boolean(),
  status: z.enum(CONCEPT_AUTO_APPROVE_STATUS),
  /** auto picks in the current run */
  steps: z.number().int(),
  maxSteps: z.number().int(),
  /** also auto-accept change proposals on fields the user wrote (default off) */
  acceptUserFieldProposals: z.boolean(),
  waitingReason: z.enum(CONCEPT_AUTO_APPROVE_WAIT_REASONS).nullable(),
  stopReason: z.enum(CONCEPT_AUTO_APPROVE_STOP_REASONS).nullable(),
  canEnable: z.boolean(),
  updatedAt: isoDateTime.nullable(),
});
export type ConceptAutoApproveViewDto = z.infer<typeof conceptAutoApproveViewDtoSchema>;

/** GET …/concept/session and GET …/concept/sessions/:sessionId */
export const conceptSessionViewDtoSchema = z.object({
  session: conceptSessionDtoSchema,
  workingBrief: z.object({
    content: z.record(z.string(), z.unknown()),
    field_provenance: z.record(z.string(), conceptFieldProvenanceDtoSchema),
    change_proposals: z.array(z.object({ id: z.string(), field_path: z.string(), new_value: z.unknown(), reason: z.string(), status: z.enum(["pending", "accepted", "rejected", "superseded"]), resolution: z.string().optional() }).loose()),
    checks: z.unknown(),
    meta: z.unknown(),
  }),
  progress: z.object({ requiredTotal: z.number().int(), requiredConfirmed: z.number().int(), missing: z.array(z.object({ path: z.string(), label: z.string() })) }),
  blockers: z.array(z.object({ code: z.string(), message: z.string(), fieldPaths: z.array(z.string()) })),
  canSubmit: z.boolean(),
  /** `limit`은 숨은 안전 상한, `softWarning`은 경고를 띄울 사용 턴 수, `extension`은 [턴 상한 올리기] 1회에 늘어나는 턴 수 */
  turns: z.object({ used: z.number().int(), limit: z.number().int(), extensionsLeft: z.number().int(), softWarning: z.number().int(), extension: z.number().int() }),
  budget: z.object({ spentMicros: z.number().int(), limitMicros: z.number().int(), checkReserveMicros: z.number().int() }),
  statusLabel: z.string(),
  stageLabel: z.string(),
  /** field path → Korean badge labels (출처·슬롯 상태) */
  fieldBadges: z.record(z.string(), z.object({ originLabel: z.string(), stateLabel: z.string() })),
  nextStep: z.object({ kind: z.string(), path: z.string().nullable(), text: z.string() }),
  /** 설계 추가: 컨셉 파트너가 고른 추천 제목 3~5개 (고르기 전까지 작품 제목은 가제/임시) */
  titleSuggestions: z
    .object({
      items: z.array(conceptTitleSuggestionDtoSchema),
      generatedAt: isoDateTime.nullable(),
      /** "다른 추천 받기" 진행 중 */
      refreshing: z.boolean(),
      error: z.string().nullable(),
      canRefresh: z.boolean(),
    })
    .default({ items: [], generatedAt: null, refreshing: false, error: null, canRefresh: false }),
  /** 설계 추가: 자동 승인 모드 (세션 단위, 서버가 추천안을 골라 대화를 이어 감) */
  autoApprove: conceptAutoApproveViewDtoSchema.default({
    enabled: false,
    status: "off",
    steps: 0,
    maxSteps: 20,
    acceptUserFieldProposals: false,
    waitingReason: null,
    stopReason: null,
    canEnable: false,
    updatedAt: null,
  }),
});
export type ConceptSessionViewDto = z.infer<typeof conceptSessionViewDtoSchema>;

/** GET …/concept/goal-defaults (목표 폼 초기값, 11 M-06~M-08·M-22) */
export const conceptGoalDefaultsDtoSchema = z.object({
  conceptBriefId: z.string(),
  endingDirection: z.string().nullable(),
  totalEpisodesMin: z.number().int().nullable(),
  totalEpisodesMax: z.number().int().nullable(),
  cadenceEpisodesPerWeek: z.number().int().nullable(),
  lengthHint: z.string().nullable(),
  suggestMultiTimeline: z.boolean(),
  suggestPossessionMode: z.boolean(),
});
export type ConceptGoalDefaultsDto = z.infer<typeof conceptGoalDefaultsDtoSchema>;

// ── requests ────────────────────────────────────────────────────────────
export const conceptMessagesQuerySchema = z.object({
  afterSeq: queryInt.optional(),
  limit: queryInt.optional(),
});

/** POST …/concept/sessions/:sessionId/messages → 201 `{message, taskId}` */
export const conceptPostMessageRequestSchema = z
  .object({
    body: z.string().max(20_000).default(""),
    kind: z.enum(["text", "option_pick", "import_text"]).default("text"),
    /** option value or control value ("@recommend", "@delegate_all", "@confirm_field:<path>" …) */
    optionValue: z.string().max(400).optional(),
    pickedIdx: z.number().int().optional(),
  })
  .refine((v) => v.kind !== "option_pick" || v.optionValue !== undefined || v.pickedIdx !== undefined, { message: "option_pick에는 optionValue 또는 pickedIdx가 필요합니다." })
  .refine((v) => v.kind === "option_pick" || v.body.trim().length > 0, { message: "메시지 본문이 비어 있습니다." });
export type ConceptPostMessageRequest = z.infer<typeof conceptPostMessageRequestSchema>;

/** PATCH …/concept/sessions/:sessionId/brief — `value: null` clears the field */
export const conceptEditBriefRequestSchema = z.object({ path: z.string().min(1).max(120), value: z.unknown() });
export type ConceptEditBriefRequest = z.infer<typeof conceptEditBriefRequestSchema>;

export const conceptPauseRequestSchema = z.object({ reason: z.literal("user").default("user") });
/** POST …/extend — `turns: true` raises the safety ceiling by concept.turn_extension (50) once (max concept.max_turn_extensions); `budgetMicros` is the new absolute limit */
export const conceptExtendRequestSchema = z
  .object({ turns: z.boolean().optional(), budgetMicros: z.number().int().positive().optional() })
  .refine((v) => v.turns || v.budgetMicros !== undefined, { message: "turns 또는 budgetMicros가 필요합니다." });
export type ConceptExtendRequest = z.infer<typeof conceptExtendRequestSchema>;
export const conceptEntryModeRequestSchema = z.object({ mode: z.enum(ENUMS.concept_entry_mode) });
/** POST …/abandon — `restart: true` ("처음부터 다시") opens a new session (concept status only) → `{abandoned, session}` */
export const conceptAbandonRequestSchema = z.object({ restart: z.boolean().default(false) });
/** POST …/confirm — [추출값 전체 확인] / [모두 확정] / field list */
export const conceptConfirmRequestSchema = z.union([
  z.object({ which: z.enum(["imported", "delegated"]) }),
  z.object({ paths: z.array(z.string()).min(1).max(50) }),
]);
export type ConceptConfirmRequest = z.infer<typeof conceptConfirmRequestSchema>;
/** POST …/concept/sessions/:sessionId/title — 추천 제목을 고르거나 고쳐서/직접 입력해 확정 → SessionView */
export const conceptChooseTitleRequestSchema = z.object({ title: z.string().trim().min(1, "제목을 입력해 주세요.").max(200) });
export type ConceptChooseTitleRequest = z.infer<typeof conceptChooseTitleRequestSchema>;
/** POST …/change-proposals/:proposalId */
export const conceptChangeProposalDecisionSchema = z.object({ decision: z.enum(["accepted", "rejected"]) });
/** 설계 추가: POST …/concept/sessions/:sessionId/auto-approve → SessionView */
export const conceptAutoApproveRequestSchema = z.object({
  enabled: z.boolean(),
  /** auto picks before the run stops by itself (default 20) */
  maxSteps: z.number().int().min(1).max(60).optional(),
  acceptUserFieldProposals: z.boolean().optional(),
});
export type ConceptAutoApproveRequest = z.infer<typeof conceptAutoApproveRequestSchema>;
