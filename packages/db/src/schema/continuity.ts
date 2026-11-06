// Drizzle mirror of the SQL migrations (columns only — constraints, FKs and indexes live in SQL).
// Owning module: continuity (design/08 §2.3).
import { bigint, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { ENUMS } from "@ncs/shared/enums";

/** continuity_issues */
export const continuityIssues = pgTable(
  "continuity_issues",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    displayNo: integer("display_no").notNull(),
    episodeId: text("episode_id").notNull(),
    manuscriptVersionId: text("manuscript_version_id").notNull(),
    sceneId: text("scene_id"),
    charStart: integer("char_start"),
    charEnd: integer("char_end"),
    kind: text("kind", { enum: ENUMS.continuity_issue_kind }).notNull(),
    severity: text("severity", { enum: ENUMS.issue_severity }).notNull(),
    status: text("status", { enum: ENUMS.continuity_issue_status }).notNull().default("open"),
    detector: text("detector", { enum: ENUMS.issue_detector }).notNull(),
    detectedByRunId: text("detected_by_run_id"),
    message: text("message").notNull(),
    proposedFix: text("proposed_fix"),
    fixScope: text("fix_scope", { enum: ENUMS.issue_fix_scope }),
    autoFixDiff: jsonb("auto_fix_diff").$type<unknown>(),
    resolutionKind: text("resolution_kind", { enum: ENUMS.issue_resolution_kind }),
    resolvedByActorType: text("resolved_by_actor_type", { enum: ENUMS.actor_type }),
    resolvedByActorId: text("resolved_by_actor_id"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
    questionId: text("question_id"),
    approvalId: text("approval_id"),
    dedupeKey: text("dedupe_key").notNull(),
    previousIssueId: text("previous_issue_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type ContinuityIssuesRow = typeof continuityIssues.$inferSelect;
export type ContinuityIssuesInsert = typeof continuityIssues.$inferInsert;

/** continuity_issue_evidence */
export const continuityIssueEvidence = pgTable(
  "continuity_issue_evidence",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    issueId: text("issue_id").notNull(),
    refType: text("ref_type", { enum: ENUMS.ref_type }).notNull(),
    refId: text("ref_id").notNull(),
    factVersionId: text("fact_version_id"),
    schemaRuleKey: text("schema_rule_key"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type ContinuityIssueEvidenceRow = typeof continuityIssueEvidence.$inferSelect;
export type ContinuityIssueEvidenceInsert = typeof continuityIssueEvidence.$inferInsert;
