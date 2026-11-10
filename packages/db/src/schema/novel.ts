// Drizzle mirror of the SQL migrations (columns only — constraints, FKs and indexes live in SQL).
// Owning module: novel (design/08 §2.3).
import { bigint, boolean, integer, jsonb, pgTable, primaryKey, real, text, time, timestamp } from "drizzle-orm/pg-core";
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
    /** 설계 추가 0011: 인터넷 검색(기본 켬)과 LLM 호출 1회당 검색 상한(1~10) */
    webSearchEnabled: boolean("web_search_enabled").notNull().default(true),
    webSearchMaxUses: integer("web_search_max_uses").notNull().default(3),
    /** 설계 추가 0015: 엔티티 판정 에이전트(기본 켬)와 자동 적용 신뢰도 기준(0~1) */
    entityAgentResolution: boolean("entity_agent_resolution").notNull().default(true),
    entityAgentMinConfidence: real("entity_agent_min_confidence").notNull().default(0.75),
    /** 설계 추가 0018: 한 화씩 진행(화별 승인에서 N화 승인 뒤 N+1화) — 기본 켬 */
    sequentialEpisodes: boolean("sequential_episodes").notNull().default(true),
    /** 설계 추가 0023: 제목 방식 — unit = 에피소드 묶음 "제목 (1)(2)" (새 작품 기본), per_episode = 화별 제목 */
    episodeTitleMode: text("episode_title_mode", { enum: ["unit", "per_episode"] }).notNull().default("unit"),
    /** 설계 추가 0024: 문장 리듬 — concise 간결 / normal 보통(기본) / flowing 유려 (리듬 지표 기준값) */
    proseRhythm: text("prose_rhythm", { enum: ["concise", "normal", "flowing"] }).notNull().default("normal"),
    defaultNarrationMode: text("default_narration_mode", { enum: ENUMS.narration_mode }).notNull().default("third_limited"),
    timezone: text("timezone").notNull().default("Asia/Seoul"),
    lengthProfileId: text("length_profile_id").notNull(),
    activeSchemaVersionId: text("active_schema_version_id").notNull(),
    pausedAt: timestamp("paused_at", { withTimezone: true, mode: "date" }),
    pauseReason: text("pause_reason", { enum: ENUMS.pause_reason }),
    stylePresetAssetId: text("style_preset_asset_id"),
    /** 설계 추가 0014: 완전 자율 설정(AutopilotSettings, 빈 객체 = 기본값)·진행 상태·위임한 사람·킬 스위치 */
    autopilotSettings: jsonb("autopilot_settings").$type<Record<string, unknown>>().notNull().default({}),
    autopilotState: jsonb("autopilot_state").$type<Record<string, unknown>>().notNull().default({}),
    autopilotEnabledByUserId: text("autopilot_enabled_by_user_id"),
    autopilotAcknowledgedAt: timestamp("autopilot_acknowledged_at", { withTimezone: true, mode: "date" }),
    autopilotHaltedAt: timestamp("autopilot_halted_at", { withTimezone: true, mode: "date" }),
    autopilotHaltReason: text("autopilot_halt_reason", { enum: ENUMS.autopilot_halt_reason }),
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

export interface ArcSetupPlanJson {
  plant?: string[];
  payoff?: string[];
}

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
    /** 0008: plot = arc linked to a story part */
    partId: text("part_id"),
    coreEvent: text("core_event").notNull().default(""),
    involvedCharacterIds: text("involved_character_ids").array().notNull().default(sql`'{}'`),
    changeText: text("change_text").notNull().default(""),
    setupPlan: jsonb("setup_plan").$type<ArcSetupPlanJson>().notNull().default({}),
    planFlags: text("plan_flags", { enum: ENUMS.arc_plan_flag }).array().notNull().default(sql`'{}'`),
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

// ── 0008 전체 구성(1~4부 + 결말) ─────────────────────────────────────────
export interface StoryEndingJson {
  worldState: string;
  conflictResolution: string;
  characterFinalStates: Array<{ characterId: string; finalState: string }>;
  protagonistChange: { from: string; to: string };
  foreshadowPayoffs: Array<{ setup: string; payoff: string; setupId: string | null }>;
}
export interface StructurePendingChangesJson {
  ending?: boolean;
  partIds?: string[];
  goalEndingChanged?: boolean;
  regenerated?: boolean;
}
export interface StoryCharacterStateJson {
  characterId: string;
  state: string;
}
export interface StoryPlotOutlineJson {
  title: string;
  coreEvent: string;
  episodeCount: number;
}

/** story_structures — one per novel (revision-based, like goals) */
export const storyStructures = pgTable("story_structures", {
  id: text("id").notNull().primaryKey(),
  novelId: text("novel_id").notNull(),
  status: text("status", { enum: ENUMS.story_structure_status }).notNull().default("draft"),
  revision: integer("revision").notNull().default(1),
  approvedRevision: integer("approved_revision"),
  ending: jsonb("ending").$type<Partial<StoryEndingJson>>().notNull().default({}),
  endingFieldOrigins: jsonb("ending_field_origins").$type<Record<string, "user" | "agent">>().notNull().default({}),
  firstAppearances: jsonb("first_appearances").$type<Array<{ characterId: string; episodeNo: number }>>().notNull().default([]),
  pendingChanges: jsonb("pending_changes").$type<StructurePendingChangesJson>().notNull().default({}),
  approvalId: text("approval_id"),
  approvedAt: timestamp("approved_at", { withTimezone: true, mode: "date" }),
  sourceBibleId: text("source_bible_id"),
  modelId: text("model_id"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});
export type StoryStructuresRow = typeof storyStructures.$inferSelect;
export type StoryStructuresInsert = typeof storyStructures.$inferInsert;

/** story_parts — exactly 4 per structure (ord 1..4) */
export const storyParts = pgTable("story_parts", {
  id: text("id").notNull().primaryKey(),
  novelId: text("novel_id").notNull(),
  structureId: text("structure_id").notNull(),
  ord: integer("ord").notNull(),
  title: text("title").notNull().default(""),
  goalText: text("goal_text").notNull().default(""),
  turningPoints: jsonb("turning_points").$type<string[]>().notNull().default([]),
  plannedEpisodeFrom: integer("planned_episode_from").notNull(),
  plannedEpisodeTo: integer("planned_episode_to").notNull(),
  characterStates: jsonb("character_states").$type<StoryCharacterStateJson[]>().notNull().default([]),
  plotOutline: jsonb("plot_outline").$type<StoryPlotOutlineJson[]>().notNull().default([]),
  fieldOrigins: jsonb("field_origins").$type<Record<string, "user" | "agent">>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});
export type StoryPartsRow = typeof storyParts.$inferSelect;
export type StoryPartsInsert = typeof storyParts.$inferInsert;
