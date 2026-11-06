// Drizzle mirror of the SQL migrations (columns only — constraints, FKs and indexes live in SQL).
// Owning module: agents (design/08 §2.3).
import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** context_snapshots */
export const contextSnapshots = pgTable(
  "context_snapshots",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    runId: text("run_id").notNull(),
    storyPoint: integer("story_point"),
    timelineId: text("timeline_id"),
    conceptMessageIds: text("concept_message_ids").array().notNull().default(sql`'{}'`),
    povEntityId: text("pov_entity_id"),
    factVersionIds: text("fact_version_ids").array().notNull().default(sql`'{}'`),
    candidateFactVersionIds: text("candidate_fact_version_ids").array().notNull().default(sql`'{}'`),
    constraintFactIds: text("constraint_fact_ids").array().notNull().default(sql`'{}'`),
    setupIds: text("setup_ids").array().notNull().default(sql`'{}'`),
    answerIds: text("answer_ids").array().notNull().default(sql`'{}'`),
    entityIds: text("entity_ids").array().notNull().default(sql`'{}'`),
    entityNameIds: text("entity_name_ids").array().notNull().default(sql`'{}'`),
    schemaVersionId: text("schema_version_id").notNull(),
    episodeRecapIds: text("episode_recap_ids").array().notNull().default(sql`'{}'`),
    provisionalQuestionIds: text("provisional_question_ids").array().notNull().default(sql`'{}'`),
    /** 0002 */
    manuscriptVersionIds: text("manuscript_version_ids").array().notNull().default(sql`'{}'`),
    clonedFromSnapshotId: text("cloned_from_snapshot_id"),
    tokenEstimate: integer("token_estimate").notNull(),
    buildMs: integer("build_ms").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type ContextSnapshotsRow = typeof contextSnapshots.$inferSelect;
export type ContextSnapshotsInsert = typeof contextSnapshots.$inferInsert;
