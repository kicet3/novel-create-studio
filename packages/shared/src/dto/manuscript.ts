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
 */
import { z } from "zod";
import { ENUMS } from "../enum-registry.js";
import { isoDateTime } from "./common.js";

const csv = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .transform((s) => s.split(",").filter(Boolean))
    .pipe(z.array(z.enum(values)));

// ── responses ───────────────────────────────────────────────────────────
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
