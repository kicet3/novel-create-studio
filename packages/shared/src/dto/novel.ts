/** DTOs of the `novel` module (Novel, Goal, SeriesBible, Arc, LengthProfile, NotificationPolicy, User). */
import { z } from "zod";
import { ENUMS } from "../enum-registry.js";
import { isoDateTime } from "./common.js";

// ── responses ───────────────────────────────────────────────────────────
export const userDtoSchema = z.object({ id: z.string(), displayName: z.string(), role: z.enum(ENUMS.user_role) });
export type UserDto = z.infer<typeof userDtoSchema>;

export const novelCategorySchema = z
  .object({
    genre_key: z.string().optional(),
    genre_label: z.string().optional(),
    secondary_genre_key: z.string().optional(),
    subgenre_keys: z.array(z.string()).default([]),
    subgenre_labels: z.array(z.string()).default([]),
    trope_keys: z.array(z.string()).default([]),
    trope_labels: z.array(z.string()).default([]),
    audience_facets: z.array(z.string()).default([]),
    audience_facet_labels: z.array(z.string()).default([]),
  })
  .partial();
export type NovelCategory = z.infer<typeof novelCategorySchema>;

export const novelDtoSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** provisional | auto(컨셉 대화가 정한 가제) | user — user 제목은 자동으로 바뀌지 않음 */
  titleSource: z.enum(ENUMS.novel_title_source),
  genre: z.string(),
  approvedConceptBriefId: z.string().nullable(),
  category: z.record(z.string(), z.unknown()),
  targetAudience: z.string().nullable(),
  ageRating: z.enum(ENUMS.age_rating),
  status: z.enum(ENUMS.novel_status),
  autonomyLevel: z.enum(ENUMS.autonomy_level),
  questionThreshold: z.enum(ENUMS.question_threshold),
  publishPolicy: z.enum(ENUMS.publish_policy),
  multiTimelineEnabled: z.boolean(),
  possessionModeEnabled: z.boolean(),
  defaultNarrationMode: z.enum(ENUMS.narration_mode),
  timezone: z.string(),
  lengthProfileId: z.string(),
  activeSchemaVersionId: z.string(),
  pausedAt: isoDateTime.nullable(),
  pauseReason: z.enum(ENUMS.pause_reason).nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type NovelDto = z.infer<typeof novelDtoSchema>;

export const goalDtoSchema = z.object({
  id: z.string(),
  novelId: z.string(),
  revision: z.number().int(),
  totalEpisodesMin: z.number().int(),
  totalEpisodesMax: z.number().int().nullable(),
  cadenceEpisodesPerWeek: z.number().int(),
  reserveTargetEpisodes: z.number().int(),
  endingDirection: z.string(),
  notes: z.string().nullable(),
  updatedAt: isoDateTime,
  /** PUT /goal only: the ending direction change waits for this `ending_change` approval (05 §10) */
  pendingEndingChange: z.object({ approvalId: z.string(), questionId: z.string(), endingDirection: z.string() }).optional(),
});
export type GoalDto = z.infer<typeof goalDtoSchema>;

export const seriesBibleDtoSchema = z.object({
  id: z.string(),
  novelId: z.string(),
  versionNo: z.number().int(),
  status: z.enum(ENUMS.series_bible_status),
  logline: z.string(),
  synopsis: z.string(),
  content: z.unknown(),
  contentMd: z.string(),
  authorActorType: z.enum(ENUMS.actor_type),
  authorActorId: z.string(),
  conceptBriefId: z.string(),
  approvalId: z.string().nullable(),
  approvedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
});
export type SeriesBibleDto = z.infer<typeof seriesBibleDtoSchema>;

export const arcDtoSchema = z.object({
  id: z.string(),
  novelId: z.string(),
  ord: z.number().int(),
  title: z.string(),
  goalText: z.string(),
  conflictText: z.string(),
  endCondition: z.string(),
  plannedEpisodeFrom: z.number().int(),
  plannedEpisodeTo: z.number().int(),
  status: z.enum(ENUMS.arc_status),
  planApprovalId: z.string().nullable(),
  arcApprovalId: z.string().nullable(),
  pausedAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type ArcDto = z.infer<typeof arcDtoSchema>;

export const lengthProfileDtoSchema = z.object({
  id: z.string(),
  novelId: z.string().nullable(),
  name: z.string(),
  minChars: z.number().int(),
  maxChars: z.number().int(),
  countBasis: z.enum(ENUMS.count_basis),
});
export type LengthProfileDto = z.infer<typeof lengthProfileDtoSchema>;

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, "HH:MM 형식이어야 합니다.");

export const notificationPolicyDtoSchema = z.object({
  id: z.string(),
  novelId: z.string(),
  quietHoursStart: z.string().nullable(),
  quietHoursEnd: z.string().nullable(),
  urgentExceptionEnabled: z.boolean(),
  dailyCapNonBlocking: z.number().int(),
  digestWindowMinutes: z.number().int(),
  digestMaxItems: z.number().int(),
  deadlineHoursBlocking: z.number().int(),
  deadlineHoursNonBlocking: z.number().int(),
  reminderOffsetsMinutes: z.array(z.number().int()),
  questionsPaused: z.boolean(),
  channelPriority: z.array(z.string()),
  dailySummaryTime: z.string(),
});
export type NotificationPolicyDto = z.infer<typeof notificationPolicyDtoSchema>;

// ── requests ────────────────────────────────────────────────────────────
/** POST /api/novels — N1 (03 §4.12). */
export const createNovelRequestSchema = z.object({
  /** 비우면 "제목 미정"(title_source=provisional) — 컨셉 대화가 가제를 붙입니다 */
  title: z.string().trim().max(200).optional(),
  ageRating: z.enum(["all", "age_12", "age_15"]).default("age_15"), // INV-NOV-01 (MVP: ≤ age_15)
  entryMode: z.enum(ENUMS.concept_entry_mode).default("conversation"),
  timezone: z.string().min(1).optional(),
});
export type CreateNovelRequest = z.input<typeof createNovelRequestSchema>;

/** PATCH /api/novels/:novelId — novel.settings_changed */
export const updateNovelSettingsRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    /** 지금 제목(가제)을 바꾸지 않고 확정 — 이후 컨셉 대화가 제목을 바꾸지 않음 */
    confirmTitle: z.literal(true),
    targetAudience: z.string().max(500).nullable(),
    questionThreshold: z.enum(ENUMS.question_threshold),
    defaultNarrationMode: z.enum(ENUMS.narration_mode),
    timezone: z.string().min(1),
    possessionModeEnabled: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "변경할 항목이 없습니다.");
export type UpdateNovelSettingsRequest = z.input<typeof updateNovelSettingsRequestSchema>;

/** PUT /api/novels/:novelId/autonomy — novel.autonomy_changed (INV-NOV-02, INV-NOV-04). */
export const changeAutonomyRequestSchema = z.object({
  autonomyLevel: z.enum(ENUMS.autonomy_level),
  /** only meaningful for full_auto; other levels force `manual` */
  publishPolicy: z.enum(ENUMS.publish_policy).optional(),
  /** required true when autonomyLevel=full_auto (정책·저작권 경고 확인) */
  acknowledgedFullAutoWarning: z.boolean().default(false),
  reason: z.string().max(1000).optional(),
});
export type ChangeAutonomyRequest = z.input<typeof changeAutonomyRequestSchema>;

export const pauseNovelRequestSchema = z.object({ reason: z.string().max(1000).optional() });
export const changeNovelStatusRequestSchema = z.object({
  to: z.enum(["completed", "archived"]),
  reason: z.string().max(1000).optional(),
});

/** PUT /api/novels/:novelId/goal — creates (N3) or revises the Goal. */
export const saveGoalRequestSchema = z
  .object({
    totalEpisodesMin: z.number().int().min(1),
    totalEpisodesMax: z.number().int().min(1).nullable().default(null),
    cadenceEpisodesPerWeek: z.number().int().min(1).max(70),
    reserveTargetEpisodes: z.number().int().min(0).default(5),
    endingDirection: z.string().trim().min(1).max(4000),
    notes: z.string().max(4000).nullable().default(null),
    /** optimistic concurrency: current revision (omit on first save) */
    expectedRevision: z.number().int().optional(),
  })
  .refine((g) => g.totalEpisodesMax === null || g.totalEpisodesMax >= g.totalEpisodesMin, {
    message: "최대 화수는 최소 화수 이상이어야 합니다.",
    path: ["totalEpisodesMax"],
  });
export type SaveGoalRequest = z.input<typeof saveGoalRequestSchema>;

export const arcInputSchema = z.object({
  ord: z.number().int().min(1),
  title: z.string().trim().min(1).max(200),
  goalText: z.string().trim().min(1),
  conflictText: z.string().trim().min(1),
  endCondition: z.string().trim().min(1),
  plannedEpisodeFrom: z.number().int().min(1),
  plannedEpisodeTo: z.number().int().min(1),
});
export const createArcRequestSchema = arcInputSchema.refine((a) => a.plannedEpisodeTo >= a.plannedEpisodeFrom, {
  message: "끝 화는 시작 화 이상이어야 합니다.",
  path: ["plannedEpisodeTo"],
});
export type CreateArcRequest = z.input<typeof createArcRequestSchema>;
export const updateArcRequestSchema = arcInputSchema.partial().refine((v) => Object.keys(v).length > 0, "변경할 항목이 없습니다.");
export type UpdateArcRequest = z.input<typeof updateArcRequestSchema>;

export const updateLengthProfileRequestSchema = z
  .object({
    minChars: z.number().int().min(1),
    maxChars: z.number().int().min(1),
    countBasis: z.enum(ENUMS.count_basis),
  })
  .partial()
  .refine((v) => v.minChars === undefined || v.maxChars === undefined || v.maxChars >= v.minChars, {
    message: "최대 글자 수는 최소 글자 수 이상이어야 합니다.",
    path: ["maxChars"],
  });
export type UpdateLengthProfileRequest = z.input<typeof updateLengthProfileRequestSchema>;

export const updateNotificationPolicyRequestSchema = z
  .object({
    quietHoursStart: timeOfDay.nullable(),
    quietHoursEnd: timeOfDay.nullable(),
    urgentExceptionEnabled: z.boolean(),
    dailyCapNonBlocking: z.number().int().min(0),
    digestWindowMinutes: z.number().int().min(1),
    digestMaxItems: z.number().int().min(1),
    deadlineHoursBlocking: z.number().int().min(1),
    deadlineHoursNonBlocking: z.number().int().min(1),
    reminderOffsetsMinutes: z.array(z.number().int().min(0)).max(10),
    questionsPaused: z.boolean(),
    channelPriority: z.array(z.string()),
    dailySummaryTime: timeOfDay,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "변경할 항목이 없습니다.");
export type UpdateNotificationPolicyRequest = z.input<typeof updateNotificationPolicyRequestSchema>;
