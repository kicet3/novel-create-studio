// Drizzle mirror of the SQL migrations (columns only — constraints, FKs and indexes live in SQL).
// Owning module: foreshadow (design/08 §2.3).
import { bigint, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { ENUMS } from "@ncs/shared/enums";

/** setups */
export const setups = pgTable(
  "setups",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    displayNo: integer("display_no").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    importance: text("importance", { enum: ENUMS.setup_importance }).notNull(),
    narrativeStatus: text("narrative_status", { enum: ENUMS.setup_narrative_status }).notNull().default("planned"),
    canonStatus: text("canon_status", { enum: ENUMS.canon_status }).notNull().default("candidate"),
    plannedArcId: text("planned_arc_id"),
    dueKind: text("due_kind", { enum: ENUMS.setup_due_kind }).notNull(),
    dueEpisodeNo: integer("due_episode_no"),
    dueArcId: text("due_arc_id"),
    abandonedReason: text("abandoned_reason"),
    abandonApprovalId: text("abandon_approval_id"),
    paidOffBeatId: text("paid_off_beat_id"),
    createdByActorType: text("created_by_actor_type", { enum: ENUMS.actor_type }).notNull(),
    createdByActorId: text("created_by_actor_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type SetupsRow = typeof setups.$inferSelect;
export type SetupsInsert = typeof setups.$inferInsert;

/** setup_beats */
export const setupBeats = pgTable(
  "setup_beats",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    setupId: text("setup_id").notNull(),
    kind: text("kind", { enum: ENUMS.setup_beat_kind }).notNull(),
    status: text("status", { enum: ENUMS.setup_beat_status }).notNull().default("planned"),
    canonStatus: text("canon_status", { enum: ENUMS.canon_status }).notNull().default("candidate"),
    plannedEpisodeNo: integer("planned_episode_no"),
    plannedNote: text("planned_note"),
    episodeId: text("episode_id"),
    sceneId: text("scene_id"),
    manuscriptVersionId: text("manuscript_version_id"),
    charStart: integer("char_start"),
    charEnd: integer("char_end"),
    detectedByRunId: text("detected_by_run_id"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type SetupBeatsRow = typeof setupBeats.$inferSelect;
export type SetupBeatsInsert = typeof setupBeats.$inferInsert;

/** setup_due_changes */
export const setupDueChanges = pgTable(
  "setup_due_changes",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    setupId: text("setup_id").notNull(),
    fromDueKind: text("from_due_kind", { enum: ENUMS.setup_due_kind }),
    fromDueEpisodeNo: integer("from_due_episode_no"),
    fromDueArcId: text("from_due_arc_id"),
    toDueKind: text("to_due_kind", { enum: ENUMS.setup_due_kind }).notNull(),
    toDueEpisodeNo: integer("to_due_episode_no"),
    toDueArcId: text("to_due_arc_id"),
    reason: text("reason").notNull(),
    questionId: text("question_id"),
    approvalId: text("approval_id"),
    changedByActorType: text("changed_by_actor_type", { enum: ENUMS.actor_type }).notNull(),
    changedByActorId: text("changed_by_actor_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type SetupDueChangesRow = typeof setupDueChanges.$inferSelect;
export type SetupDueChangesInsert = typeof setupDueChanges.$inferInsert;

/** setup_links */
export const setupLinks = pgTable(
  "setup_links",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    setupId: text("setup_id").notNull(),
    refType: text("ref_type", { enum: ENUMS.ref_type }).notNull(),
    refId: text("ref_id").notNull(),
    pinnedFactVersionId: text("pinned_fact_version_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type SetupLinksRow = typeof setupLinks.$inferSelect;
export type SetupLinksInsert = typeof setupLinks.$inferInsert;
