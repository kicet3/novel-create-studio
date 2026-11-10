/**
 * DTOs of the `manuscript` module (03 §3.2, §4.1; 07). `…` = /api/novels/:novelId
 *
 *   GET  …/episodes?arcId&status=a,b                     → episodeListSchema
 *   GET  …/episodes/:episodeNo                           → episodeDetailDtoSchema
 *   GET  …/episodes/:episodeNo/versions                  → { items: manuscriptVersionSummaryDtoSchema[] }
 *   GET  …/episodes/:episodeNo/scenes?includeRetired     → { items: sceneDtoSchema[] }
 *   GET  …/episodes/:episodeNo/rejections                → { items: episodeRejectionDtoSchema[] }
 *   GET  …/versions/:versionId?with=spans,scenes,issues,beats,lines → manuscriptVersionDetailDtoSchema
 *   POST …/episodes/:episodeNo/versions        humanEditRequestSchema        → 201 manuscriptVersionDtoSchema (E16)
 *   POST …/episodes/:episodeNo/revision-request revisionRequestSchema        → 201 episodeRejectionDtoSchema (E11)
 *   POST …/episodes/:episodeNo/publish                                        → episodeDtoSchema (E13)
 *   POST …/episodes/:episodeNo/unpublish       unpublishRequestSchema         → episodeDtoSchema (E14)
 *   POST …/episodes/:episodeNo/pause|resume                                   → episodeDtoSchema
 *   POST …/planning/schedule                                                  → scheduleResultDtoSchema
 *   GET  …/reserve                                                            → reserveSummaryDtoSchema
 *   GET  …/structure                                                          → structureViewSchema
 *   POST …/structure/generate                 structureGenerateRequestSchema → 202 { taskId }
 *   POST …/structure/decision                 structureDecisionRequestSchema → structureViewSchema
 *   POST …/arcs/:arcId/replan                 arcReplanRequestSchema         → 202 { taskId }
 *   GET  …/episode-units?arcId                                                → { items: episodeUnitDtoSchema[] }
 *   POST …/arcs/:arcId/retitle                                                → 202 { taskId } (제목 정리 제안: plan_arc retitle)
 *   GET  …/arcs/:arcId/retitle                                                → retitleProposalViewSchema (대기 중인 제안 + 전→후)
 *   POST …/arcs/:arcId/retitle/apply           retitleApplyRequestSchema      → retitleApplyResultSchema
 */
import { z } from "zod";
import { ENUMS } from "../enum-registry.js";
import { isoDateTime } from "./common.js";
import { arcDtoSchema, storyStructureDtoSchema } from "./novel.js";
import { castCompletenessSchema } from "./cast.js";
import { EPISODE_TITLE_MODES } from "../episode-title.js";

const csv = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .transform((s) => s.split(",").filter(Boolean))
    .pipe(z.array(z.enum(values)));

// ── responses ───────────────────────────────────────────────────────────
/**
 * 설계 추가 0023: 에피소드 묶음. `title`은 표시 제목("묶음 제목 (n)", 한 화짜리 묶음은 번호 없음 — 공개된 화는 작가가 고를 때만 바뀜).
 * 묶음이 없는 화(화별 제목 방식, 이전 작품)는 모두 null. 목록·상세·구성·읽기 목차 응답에서 채웁니다.
 */
const unitFields = {
  unitId: z.string().nullable().optional(),
  unitTitle: z.string().nullable().optional(),
  /** 묶음 안에서 몇 번째 화(1부터) */
  unitPartNo: z.number().int().nullable().optional(),
  /** 묶음의 화 수 */
  unitPartCount: z.number().int().nullable().optional(),
};

export const episodeUnitDtoSchema = z.object({
  id: z.string(),
  arcId: z.string(),
  title: z.string(),
  ord: z.number().int(),
  episodeFrom: z.number().int(),
  episodeTo: z.number().int(),
  partCount: z.number().int(),
  episodeNos: z.array(z.number().int()),
});
export type EpisodeUnitDto = z.infer<typeof episodeUnitDtoSchema>;
export const episodeUnitListSchema = z.object({ items: z.array(episodeUnitDtoSchema) });

export const episodeDtoSchema = z.object({
  id: z.string(),
  novelId: z.string(),
  arcId: z.string(),
  episodeNo: z.number().int(),
  title: z.string().nullable(),
  status: z.enum(ENUMS.episode_status),
  blockReasons: z.array(z.enum(ENUMS.episode_block_reason)),
  pausedAt: isoDateTime.nullable(),
  primaryTimelineId: z.string(),
  outlineVersionId: z.string().nullable(),
  currentVersionId: z.string().nullable(),
  approvedVersionId: z.string().nullable(),
  publishedVersionId: z.string().nullable(),
  rejectionCount: z.number().int(),
  autoRewriteCount: z.number().int(),
  lastReworkFrom: z.enum(ENUMS.rework_from).nullable(),
  hookNote: z.string().nullable(),
  approvedAt: isoDateTime.nullable(),
  approvedByActorType: z.enum(ENUMS.actor_type).nullable(),
  approvedByActorId: z.string().nullable(),
  publishedAt: isoDateTime.nullable(),
  publishedByActorType: z.enum(ENUMS.actor_type).nullable(),
  publishedByActorId: z.string().nullable(),
  scheduledPublishAt: isoDateTime.nullable(),
  /** 화 계획(plan_arc): 요약·씬 수·목표 분량 */
  planSummary: z.string(),
  plannedSceneCount: z.number().int().nullable(),
  targetChars: z.number().int().nullable(),
  /** 현재 원고가 절대 하한(3,000자) 미만 (목록·상세 응답에서 계산, 그 밖의 응답은 false) */
  lengthBelowFloor: z.boolean().default(false),
  ...unitFields,
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type EpisodeDto = z.infer<typeof episodeDtoSchema>;

export const attributionSpanDtoSchema = z.object({
  start: z.number().int(),
  end: z.number().int(),
  actorType: z.enum(ENUMS.actor_type),
  actorId: z.string(),
  originVersionId: z.string(),
});
export type AttributionSpanDto = z.infer<typeof attributionSpanDtoSchema>;

const versionBase = {
  id: z.string(),
  novelId: z.string(),
  episodeId: z.string(),
  versionNo: z.number().int(),
  kind: z.enum(ENUMS.manuscript_version_kind),
  parentVersionId: z.string().nullable(),
  stage: z.enum(ENUMS.episode_status),
  charCountWithSpaces: z.number().int(),
  charCountWithoutSpaces: z.number().int(),
  contentHash: z.string(),
  authorActorType: z.enum(ENUMS.actor_type),
  authorActorId: z.string(),
  agentRole: z.enum(ENUMS.agent_role).nullable(),
  modelId: z.string().nullable(),
  runId: z.string().nullable(),
  isHumanEdit: z.boolean(),
  isFallbackModel: z.boolean(),
  createdAt: isoDateTime,
};

/** list item: no body (use GET …/versions/:versionId) */
export const manuscriptVersionSummaryDtoSchema = z.object({ ...versionBase, contentPreview: z.string() });
export type ManuscriptVersionSummaryDto = z.infer<typeof manuscriptVersionSummaryDtoSchema>;

export const manuscriptVersionDtoSchema = z.object({
  ...versionBase,
  content: z.string(),
  outlineData: z.unknown().nullable(),
  writerAnnotations: z.unknown().nullable(),
  attributionSpans: z.array(attributionSpanDtoSchema).optional(),
});
export type ManuscriptVersionDto = z.infer<typeof manuscriptVersionDtoSchema>;

export const sceneDtoSchema = z.object({
  id: z.string(),
  novelId: z.string(),
  episodeId: z.string(),
  ord: z.number().int(),
  status: z.enum(ENUMS.scene_status),
  manuscriptVersionId: z.string(),
  charStart: z.number().int(),
  charEnd: z.number().int(),
  storyPoint: z.number().int(),
  timelineId: z.string(),
  locationEntityId: z.string().nullable(),
  povEntityId: z.string().nullable(),
  narrationMode: z.enum(ENUMS.narration_mode).nullable(),
  summary: z.string(),
  boundaryRevision: z.number().int(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type SceneDto = z.infer<typeof sceneDtoSchema>;

export const lineAttributionDtoSchema = z.object({
  line: z.number().int(),
  actors: z.array(z.object({ actorType: z.string(), actorId: z.string(), ratio: z.number() })),
});

/** `with=issues|beats` are null until continuity / foreshadow register an annotator */
export const manuscriptVersionDetailDtoSchema = manuscriptVersionDtoSchema.extend({
  scenes: z.array(sceneDtoSchema).optional(),
  lines: z.array(lineAttributionDtoSchema).optional(),
  issues: z.array(z.unknown()).nullable().optional(),
  beats: z.array(z.unknown()).nullable().optional(),
});
export type ManuscriptVersionDetailDto = z.infer<typeof manuscriptVersionDetailDtoSchema>;

export const episodeDetailDtoSchema = episodeDtoSchema.extend({
  currentVersion: manuscriptVersionSummaryDtoSchema.nullable(),
  /** FR-MAN-02 warning only */
  length: z
    .object({
      basis: z.enum(ENUMS.count_basis),
      count: z.number().int(),
      minChars: z.number().int(),
      maxChars: z.number().int(),
      deviation: z.enum(["short", "long"]).nullable(),
      /** 절대 하한(3,000자) */
      hardMinChars: z.number().int(),
      belowFloor: z.boolean(),
    })
    .nullable(),
});
export type EpisodeDetailDto = z.infer<typeof episodeDetailDtoSchema>;

export const episodeRejectionDtoSchema = z.object({
  id: z.string(),
  novelId: z.string(),
  episodeId: z.string(),
  rejectionNo: z.number().int(),
  approvalId: z.string().nullable(),
  fromVersionId: z.string(),
  reason: z.string(),
  reworkFrom: z.enum(ENUMS.rework_from),
  rejectedByUserId: z.string(),
  createdAt: isoDateTime,
});
export type EpisodeRejectionDto = z.infer<typeof episodeRejectionDtoSchema>;

export const reserveSummaryDtoSchema = z.object({ includingAwaiting: z.number().int(), approvedOnly: z.number().int(), target: z.number().int() });
export type ReserveSummaryDto = z.infer<typeof reserveSummaryDtoSchema>;

export const scheduleResultDtoSchema = z.object({
  createdTasks: z.array(z.object({ kind: z.string(), taskId: z.string(), targetId: z.string() })),
  reserve: reserveSummaryDtoSchema,
  inFlight: z.number().int(),
  notes: z.array(z.string()),
});
export type ScheduleResultDto = z.infer<typeof scheduleResultDtoSchema>;

// ── requests ────────────────────────────────────────────────────────────
export const episodeNoParamsSchema = z.object({ episodeNo: z.coerce.number().int().min(1) });
export const versionIdParamsSchema = z.object({ versionId: z.string().regex(/^mnv_/) });

export const episodeListQuerySchema = z.object({
  arcId: z.string().regex(/^arc_/).optional(),
  status: csv(ENUMS.episode_status).optional(),
});
export type EpisodeListQuery = z.input<typeof episodeListQuerySchema>;

export const versionDetailQuerySchema = z.object({
  with: z
    .string()
    .transform((s) => s.split(",").filter(Boolean))
    .pipe(z.array(z.enum(["spans", "scenes", "issues", "beats", "lines"])))
    .optional(),
});

export const sceneListQuerySchema = z.object({
  includeRetired: z.union([z.boolean(), z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1")]).optional(),
  versionId: z.string().regex(/^mnv_/).optional(),
});

/** E16 (FR-MAN-07): base must be the episode's current version (409 stale_base_version otherwise) */
export const humanEditRequestSchema = z.object({
  content: z.string().min(1).max(200_000),
  baseVersionId: z.string().regex(/^mnv_/),
});
export type HumanEditRequest = z.infer<typeof humanEditRequestSchema>;

/** E11 (approved, before publish) */
export const revisionRequestSchema = z.object({
  decisionNote: z.string().trim().min(1, "사유를 입력하세요.").max(4000),
  reworkFrom: z.enum(ENUMS.rework_from),
});
export type RevisionRequest = z.infer<typeof revisionRequestSchema>;

/** E14 (FR-MAN-03): "외부 미공개" confirmation + reason */
export const unpublishRequestSchema = z.object({
  reason: z.string().trim().min(1, "사유를 입력하세요.").max(2000),
  confirmedNotPublishedExternally: z.literal(true),
});
export type UnpublishRequest = z.infer<typeof unpublishRequestSchema>;

// ── 전체 구성(1~4부 + 결말) → 플롯 → 화 ───────────────────────────────────
export const structureGenerateRequestSchema = z.object({
  scope: z.enum(["all", "ending", "parts"]).default("all"),
  instructions: z.string().trim().max(1000).optional(),
});
export type StructureGenerateRequest = z.input<typeof structureGenerateRequestSchema>;

export const structureDecisionRequestSchema = z
  .object({
    decision: z.enum(["approved", "rejected"]),
    note: z.string().trim().max(4000).optional(),
    expectedRevision: z.number().int().min(1),
  })
  .refine((d) => d.decision === "approved" || !!d.note, { message: "반려 사유를 입력하세요.", path: ["note"] });
export type StructureDecisionRequest = z.input<typeof structureDecisionRequestSchema>;

export const arcReplanRequestSchema = z.object({ note: z.string().trim().max(2000).optional() });
export type ArcReplanRequest = z.input<typeof arcReplanRequestSchema>;

export const structurePlotDtoSchema = arcDtoSchema.extend({
  episodeCount: z.number().int(),
  /** outline = 화 계획 전, episodes_planned = 화 목록이 있음 */
  planningStage: z.enum(["outline", "episodes_planned"]),
  /** 이 플롯에서 새로 등장하는 인물 중 빈 항목이 있거나 AI 제안을 수락하지 않은 인물(있으면 플롯 계획을 승인할 수 없음) */
  castGaps: castCompletenessSchema.nullable().default(null),
  /** 진행 중인 플롯의 재계획안이 승인을 기다림(인박스) */
  replanApprovalId: z.string().nullable().default(null),
  /** 설계 추가 0023: [제목 정리] 제안이 승인을 기다림(인박스) */
  retitleApprovalId: z.string().nullable().optional(),
});
export type StructurePlotDto = z.infer<typeof structurePlotDtoSchema>;

export const structureEpisodeDtoSchema = z.object({
  id: z.string(),
  arcId: z.string(),
  episodeNo: z.number().int(),
  title: z.string().nullable(),
  status: z.enum(ENUMS.episode_status),
  planSummary: z.string(),
  plannedSceneCount: z.number().int().nullable(),
  targetChars: z.number().int().nullable(),
  lengthBelowFloor: z.boolean(),
  ...unitFields,
});
export type StructureEpisodeDto = z.infer<typeof structureEpisodeDtoSchema>;

export const structureViewSchema = z.object({
  structure: storyStructureDtoSchema.nullable(),
  /** 구성 생성 가능 여부와 막는 이유(한국어) */
  gate: z.object({
    canGenerate: z.boolean(),
    reasons: z.array(z.string()),
    /** reasons와 같은 순서의 코드(concept_not_approved, cast_incomplete, goal_required, bible_not_approved, structure_too_short) */
    codes: z.array(z.string()).default([]),
    cast: castCompletenessSchema,
  }),
  /** 진행 중인 plan_structure 작업 */
  task: z.object({ id: z.string(), status: z.string() }).nullable(),
  lastError: z.string().nullable(),
  plots: z.array(structurePlotDtoSchema),
  episodes: z.array(structureEpisodeDtoSchema),
  /** 설계 추가 0023: 에피소드 묶음(플롯·순서별) */
  units: z.array(episodeUnitDtoSchema).optional(),
  /** 작품 제목 방식 */
  episodeTitleMode: z.enum(EPISODE_TITLE_MODES).optional(),
  goal: z.object({ totalEpisodesMin: z.number().int(), totalEpisodesMax: z.number().int().nullable(), endingDirection: z.string() }).nullable(),
});
export type StructureView = z.infer<typeof structureViewSchema>;
export const structureTaskAcceptedSchema = z.object({ taskId: z.string() });

// ── 설계 추가 0023: [제목 정리] (플롯의 화를 에피소드 묶음으로 묶고 제목을 "묶음 제목 (n)"으로) ──
export const retitleItemSchema = z.object({
  episodeNo: z.number().int(),
  status: z.enum(ENUMS.episode_status),
  before: z.string().nullable(),
  /** 적용 후 제목(공개 제목을 유지하는 화는 포함해 바꿀 때의 제목) */
  after: z.string(),
  /** 새 묶음(공개 제목을 유지해 묶음에서 빠지는 화는 null) */
  unitTitle: z.string().nullable(),
  unitPartNo: z.number().int().nullable(),
  unitPartCount: z.number().int().nullable(),
  published: z.boolean(),
  /** 기본 적용에서 바뀜(공개 전 화). 공개된 화는 includePublishedEpisodeNos로 고를 때만 바뀜 */
  willRename: z.boolean(),
  unchanged: z.boolean(),
  /** 공개 제목을 유지해 새 묶음에서 빠짐(묶음은 그다음 화부터 (1)로 시작) */
  excluded: z.boolean().default(false),
});
export type RetitleItem = z.infer<typeof retitleItemSchema>;

export const retitleProposalViewSchema = z.object({
  arcId: z.string(),
  /** 진행 중인 제안 작업(plan_arc retitle) */
  task: z.object({ id: z.string(), status: z.string() }).nullable(),
  lastError: z.string().nullable(),
  /** 대기 중인 제안(없으면 null) */
  proposal: z
    .object({
      approvalId: z.string(),
      createdAt: isoDateTime,
      units: z.array(z.object({ title: z.string(), from: z.number().int(), to: z.number().int() })),
      items: z.array(retitleItemSchema),
    })
    .nullable(),
});
export type RetitleProposalView = z.infer<typeof retitleProposalViewSchema>;

/** POST …/arcs/:arcId/retitle — 다시 제안할 때 바꿀 점(선택) */
export const retitleProposeRequestSchema = z.object({ note: z.string().trim().max(2000).optional() });
export type RetitleProposeRequest = z.input<typeof retitleProposeRequestSchema>;

export const retitleApplyRequestSchema = z.object({
  approvalId: z.string().min(1),
  /** 공개된 화 중 제목을 바꿀 화(기본: 없음 — 공개된 화는 제목 유지) */
  includePublishedEpisodeNos: z.array(z.number().int().min(1)).max(500).default([]),
  /** 공개된 화 제목 변경 확인(리트콘처럼 독자에게 보이는 제목이 바뀜) — includePublishedEpisodeNos가 있으면 true 필수 */
  confirmPublishedRename: z.boolean().default(false),
  /** 제안을 반려(아무것도 바꾸지 않음) */
  reject: z.boolean().default(false),
  /** 반려 사유(선택) */
  note: z.string().trim().max(2000).optional(),
});
export type RetitleApplyRequest = z.input<typeof retitleApplyRequestSchema>;

export const retitleApplyResultSchema = z.object({
  applied: z.boolean(),
  renamed: z.array(z.object({ episodeNo: z.number().int(), before: z.string().nullable(), after: z.string() })),
  keptPublished: z.array(z.number().int()),
  episodeTitleMode: z.enum(EPISODE_TITLE_MODES),
});
export type RetitleApplyResult = z.infer<typeof retitleApplyResultSchema>;
