// Drizzle mirror of the SQL migrations (columns only — constraints, FKs and indexes live in SQL).
// Owning module: manuscript (design/08 §2.3).
import { boolean, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { ENUMS } from "@ncs/shared/enums";

/** episodes */
export const episodes = pgTable(
  "episodes",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    arcId: text("arc_id").notNull(),
    episodeNo: integer("episode_no").notNull(),
    title: text("title"),
    status: text("status", { enum: ENUMS.episode_status }).notNull().default("planned"),
    blockReasons: text("block_reasons", { enum: ENUMS.episode_block_reason }).array().notNull().default(sql`'{}'`),
    pausedAt: timestamp("paused_at", { withTimezone: true, mode: "date" }),
    primaryTimelineId: text("primary_timeline_id").notNull(),
    outlineVersionId: text("outline_version_id"),
    currentVersionId: text("current_version_id"),
    approvedVersionId: text("approved_version_id"),
    publishedVersionId: text("published_version_id"),
    /** 설계 추가 0024: pending [문체 다듬기] candidate (a version that is not current; the author keeps or discards it) */
    rhythmCandidateVersionId: text("rhythm_candidate_version_id"),
    rejectionCount: integer("rejection_count").notNull().default(0),
    autoRewriteCount: integer("auto_rewrite_count").notNull().default(0),
    lastReworkFrom: text("last_rework_from", { enum: ENUMS.rework_from }),
    hookNote: text("hook_note"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "date" }),
    approvedByActorType: text("approved_by_actor_type", { enum: ENUMS.actor_type }),
    approvedByActorId: text("approved_by_actor_id"),
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "date" }),
    publishedByActorType: text("published_by_actor_type", { enum: ENUMS.actor_type }),
    publishedByActorId: text("published_by_actor_id"),
    scheduledPublishAt: timestamp("scheduled_publish_at", { withTimezone: true, mode: "date" }),
    /** 0008: episode plan (plan_arc) */
    planSummary: text("plan_summary").notNull().default(""),
    plannedSceneCount: integer("planned_scene_count"),
    targetChars: integer("target_chars"),
    /** 0023: story episode (에피소드 묶음) this 화 belongs to and its part number (1-based) */
    unitId: text("unit_id"),
    unitPartNo: integer("unit_part_no"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type EpisodesRow = typeof episodes.$inferSelect;
export type EpisodesInsert = typeof episodes.$inferInsert;

/** episode_units (0023: 에피소드 묶음 — consecutive 화 of a plot sharing one title, shown as "제목 (n)") */
export const episodeUnits = pgTable("episode_units", {
  id: text("id").notNull().primaryKey(),
  novelId: text("novel_id").notNull(),
  arcId: text("arc_id").notNull(),
  title: text("title").notNull(),
  ord: integer("ord").notNull(),
  plannedEpisodeCount: integer("planned_episode_count").notNull().default(1),
  status: text("status", { enum: ["active", "retired"] }).notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});
export type EpisodeUnitsRow = typeof episodeUnits.$inferSelect;
export type EpisodeUnitsInsert = typeof episodeUnits.$inferInsert;

/** manuscript_versions */
export const manuscriptVersions = pgTable(
  "manuscript_versions",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    episodeId: text("episode_id").notNull(),
    versionNo: integer("version_no").notNull(),
    kind: text("kind", { enum: ENUMS.manuscript_version_kind }).notNull(),
    parentVersionId: text("parent_version_id"),
    stage: text("stage", { enum: ENUMS.episode_status }).notNull(),
    content: text("content").notNull(),
    outlineData: jsonb("outline_data").$type<unknown>(),
    charCountWithSpaces: integer("char_count_with_spaces").notNull(),
    charCountWithoutSpaces: integer("char_count_without_spaces").notNull(),
    contentHash: text("content_hash").notNull(),
    authorActorType: text("author_actor_type", { enum: ENUMS.actor_type }).notNull(),
    authorActorId: text("author_actor_id").notNull(),
    agentRole: text("agent_role", { enum: ENUMS.agent_role }),
    modelId: text("model_id"),
    runId: text("run_id"),
    isHumanEdit: boolean("is_human_edit").notNull().default(false),
    isFallbackModel: boolean("is_fallback_model").notNull().default(false),
    attributionSpans: jsonb("attribution_spans").$type<unknown>().notNull().default([]),
    writerAnnotations: jsonb("writer_annotations").$type<unknown>(),
    /** 설계 추가 0024: 문장 리듬 지표 (+ [문체 다듬기] 후보 상태) */
    rhythm: jsonb("rhythm").$type<unknown>(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type ManuscriptVersionsRow = typeof manuscriptVersions.$inferSelect;
export type ManuscriptVersionsInsert = typeof manuscriptVersions.$inferInsert;

/** episode_rejections */
export const episodeRejections = pgTable(
  "episode_rejections",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    episodeId: text("episode_id").notNull(),
    rejectionNo: integer("rejection_no").notNull(),
    approvalId: text("approval_id"), // 0002: nullable (E11 / full_auto)
    fromVersionId: text("from_version_id").notNull(),
    reason: text("reason").notNull(),
    reworkFrom: text("rework_from", { enum: ENUMS.rework_from }).notNull(),
    rejectedByUserId: text("rejected_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type EpisodeRejectionsRow = typeof episodeRejections.$inferSelect;
export type EpisodeRejectionsInsert = typeof episodeRejections.$inferInsert;

/** scenes */
export const scenes = pgTable(
  "scenes",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    episodeId: text("episode_id").notNull(),
    ord: integer("ord").notNull(),
    status: text("status", { enum: ENUMS.scene_status }).notNull().default("active"),
    manuscriptVersionId: text("manuscript_version_id").notNull(),
    charStart: integer("char_start").notNull(),
    charEnd: integer("char_end").notNull(),
    storyPoint: integer("story_point").notNull(),
    timelineId: text("timeline_id").notNull(),
    locationEntityId: text("location_entity_id"),
    povEntityId: text("pov_entity_id"),
    narrationMode: text("narration_mode", { enum: ENUMS.narration_mode }),
    summary: text("summary").notNull(),
    boundaryRevision: integer("boundary_revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type ScenesRow = typeof scenes.$inferSelect;
export type ScenesInsert = typeof scenes.$inferInsert;

/** scene_participants */
export const sceneParticipants = pgTable(
  "scene_participants",
  {
    novelId: text("novel_id").notNull(),
    sceneId: text("scene_id").notNull(),
    entityId: text("entity_id").notNull(),
    participation: text("participation", { enum: ENUMS.scene_participation }).notNull(),
    mentionCount: integer("mention_count").notNull().default(0),
    firstMentionId: text("first_mention_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.novelId, t.sceneId, t.entityId] })],
);
export type SceneParticipantsRow = typeof sceneParticipants.$inferSelect;
export type SceneParticipantsInsert = typeof sceneParticipants.$inferInsert;

/** episode_recaps */
export const episodeRecaps = pgTable(
  "episode_recaps",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    episodeId: text("episode_id").notNull(),
    sourceVersionId: text("source_version_id").notNull(),
    layer: text("layer", { enum: ENUMS.recap_layer }).notNull(),
    povEntityId: text("pov_entity_id"),
    summary: text("summary").notNull(),
    prefilterResult: jsonb("prefilter_result").$type<unknown>(),
    createdByRunId: text("created_by_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    /** 설계 추가 0019: 직전 화 끝 상태 (place, time, present, physical_state, emotional_state, open_hook, last_line) */
    handoff: jsonb("handoff").$type<unknown>(),
    /** 설계 추가 0019: the episode text changed after this recap (a newer version is summarized again) */
    staleAt: timestamp("stale_at", { withTimezone: true, mode: "date" }),
  },
);
export type EpisodeRecapsRow = typeof episodeRecaps.$inferSelect;
export type EpisodeRecapsInsert = typeof episodeRecaps.$inferInsert;
