// Drizzle mirror of the SQL migrations (columns only — constraints, FKs and indexes live in SQL).
// Owning module: novel (design/08 §2.3).
import { bigint, boolean, integer, jsonb, pgTable, primaryKey, text, time, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { ENUMS } from "@ncs/shared/enums";

/** users */
export const users = pgTable(
  "users",
  {
    id: text("id").notNull().primaryKey(),
    displayName: text("display_name").notNull(),
    role: text("role", { enum: ENUMS.user_role }).notNull().default("owner"),
    auth: jsonb("auth").$type<unknown>(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type UsersRow = typeof users.$inferSelect;
export type UsersInsert = typeof users.$inferInsert;

/** length_profiles — novel_id NULL = install preset */
export const lengthProfiles = pgTable(
  "length_profiles",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id"),
    name: text("name").notNull(),
    minChars: integer("min_chars").notNull().default(5000),
    maxChars: integer("max_chars").notNull().default(5500),
    countBasis: text("count_basis", { enum: ENUMS.count_basis }).notNull().default("with_spaces"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type LengthProfilesRow = typeof lengthProfiles.$inferSelect;
export type LengthProfilesInsert = typeof lengthProfiles.$inferInsert;

/** novels */
export const novels = pgTable(
  "novels",
  {
    id: text("id").notNull().primaryKey(),
    title: text("title").notNull(),
    titleSource: text("title_source", { enum: ENUMS.novel_title_source }).notNull().default("user"),
    genre: text("genre").notNull().default(""),
    approvedConceptBriefId: text("approved_concept_brief_id"),
    category: jsonb("category").$type<unknown>().notNull().default({}),
    templateRefs: jsonb("template_refs").$type<unknown>().notNull().default([]),
    targetAudience: text("target_audience"),
    ageRating: text("age_rating", { enum: ENUMS.age_rating }).notNull(),
    status: text("status", { enum: ENUMS.novel_status }).notNull().default("concept"),
    autonomyLevel: text("autonomy_level", { enum: ENUMS.autonomy_level }).notNull().default("episode_approval"),
    questionThreshold: text("question_threshold", { enum: ENUMS.question_threshold }).notNull().default("normal"),
    mediaAutonomy: text("media_autonomy", { enum: ENUMS.media_autonomy }).notNull().default("review_all"),
    mediaTargetBasis: text("media_target_basis", { enum: ENUMS.media_target_basis }).notNull().default("published"),
    publishPolicy: text("publish_policy", { enum: ENUMS.publish_policy }).notNull().default("manual"),
    multiTimelineEnabled: boolean("multi_timeline_enabled").notNull().default(false),
    possessionModeEnabled: boolean("possession_mode_enabled").notNull().default(false),
    defaultNarrationMode: text("default_narration_mode", { enum: ENUMS.narration_mode }).notNull().default("third_limited"),
    timezone: text("timezone").notNull().default("Asia/Seoul"),
    lengthProfileId: text("length_profile_id").notNull(),
    activeSchemaVersionId: text("active_schema_version_id").notNull(),
    pausedAt: timestamp("paused_at", { withTimezone: true, mode: "date" }),
    pauseReason: text("pause_reason", { enum: ENUMS.pause_reason }),
    stylePresetAssetId: text("style_preset_asset_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type NovelsRow = typeof novels.$inferSelect;
export type NovelsInsert = typeof novels.$inferInsert;

/** goals */
export const goals = pgTable(
  "goals",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    revision: integer("revision").notNull().default(1),
    totalEpisodesMin: integer("total_episodes_min").notNull(),
    totalEpisodesMax: integer("total_episodes_max"),
    cadenceEpisodesPerWeek: integer("cadence_episodes_per_week").notNull(),
    reserveTargetEpisodes: integer("reserve_target_episodes").notNull().default(5),
    endingDirection: text("ending_direction").notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type GoalsRow = typeof goals.$inferSelect;
export type GoalsInsert = typeof goals.$inferInsert;

/** series_bibles */
export const seriesBibles = pgTable(
  "series_bibles",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    versionNo: integer("version_no").notNull(),
    status: text("status", { enum: ENUMS.series_bible_status }).notNull().default("draft"),
    logline: text("logline").notNull(),
    synopsis: text("synopsis").notNull(),
    content: jsonb("content").$type<unknown>().notNull().default({}),
    contentMd: text("content_md").notNull(),
    authorActorType: text("author_actor_type", { enum: ENUMS.actor_type }).notNull(),
    authorActorId: text("author_actor_id").notNull(),
    conceptBriefId: text("concept_brief_id").notNull(),
    approvalId: text("approval_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type SeriesBiblesRow = typeof seriesBibles.$inferSelect;
export type SeriesBiblesInsert = typeof seriesBibles.$inferInsert;

/** arcs */
export const arcs = pgTable(
  "arcs",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    ord: integer("ord").notNull(),
    title: text("title").notNull(),
    goalText: text("goal_text").notNull(),
    conflictText: text("conflict_text").notNull(),
    endCondition: text("end_condition").notNull(),
    plannedEpisodeFrom: integer("planned_episode_from").notNull(),
    plannedEpisodeTo: integer("planned_episode_to").notNull(),
    status: text("status", { enum: ENUMS.arc_status }).notNull().default("planned"),
    planApprovalId: text("plan_approval_id"),
    arcApprovalId: text("arc_approval_id"),
    pausedAt: timestamp("paused_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type ArcsRow = typeof arcs.$inferSelect;
export type ArcsInsert = typeof arcs.$inferInsert;

/** notification_policies */
export const notificationPolicies = pgTable(
  "notification_policies",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    quietHoursStart: time("quiet_hours_start"),
    quietHoursEnd: time("quiet_hours_end"),
    urgentExceptionEnabled: boolean("urgent_exception_enabled").notNull().default(false),
    dailyCapNonBlocking: integer("daily_cap_non_blocking").notNull().default(10),
    digestWindowMinutes: integer("digest_window_minutes").notNull().default(15),
    digestMaxItems: integer("digest_max_items").notNull().default(3),
    deadlineHoursBlocking: integer("deadline_hours_blocking").notNull().default(12),
    deadlineHoursNonBlocking: integer("deadline_hours_non_blocking").notNull().default(24),
    reminderOffsetsMinutes: integer("reminder_offsets_minutes").array().notNull().default(sql`'{0,1440}'`),
    questionsPaused: boolean("questions_paused").notNull().default(false),
    channelPriority: text("channel_priority").array().notNull().default(sql`'{}'`),
    dailySummaryTime: time("daily_summary_time").notNull().default(sql`'08:00'`),
    absenceMode: jsonb("absence_mode").$type<unknown>(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type NotificationPoliciesRow = typeof notificationPolicies.$inferSelect;
export type NotificationPoliciesInsert = typeof notificationPolicies.$inferInsert;

/** novel_counters */
export const novelCounters = pgTable(
  "novel_counters",
  {
    novelId: text("novel_id").notNull(),
    counterKind: text("counter_kind", { enum: ENUMS.novel_counter_kind }).notNull(),
    lastValue: bigint("last_value", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.novelId, t.counterKind] })],
);
export type NovelCountersRow = typeof novelCounters.$inferSelect;
export type NovelCountersInsert = typeof novelCounters.$inferInsert;
