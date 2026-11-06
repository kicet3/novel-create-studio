// Drizzle mirror of the SQL migrations (columns only — constraints, FKs and indexes live in SQL).
// Owning module: export (design/08 §2.3).
import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { ENUMS } from "@ncs/shared/enums";

/** export_jobs */
export const exportJobs = pgTable(
  "export_jobs",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    scopeKind: text("scope_kind", { enum: ENUMS.export_scope_kind }).notNull(),
    scopeTargetId: text("scope_target_id"),
    exportFormat: text("export_format", { enum: ENUMS.export_format }).notNull(),
    versionSelection: text("version_selection", { enum: ENUMS.export_version_selection }).notNull().default("default"),
    items: jsonb("items").$type<unknown>().notNull().default([]),
    excluded: jsonb("excluded").$type<unknown>().notNull().default([]),
    storageKey: text("storage_key"),
    contentHash: text("content_hash"),
    requestedByActorType: text("requested_by_actor_type", { enum: ENUMS.actor_type }).notNull(),
    requestedByActorId: text("requested_by_actor_id").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type ExportJobsRow = typeof exportJobs.$inferSelect;
export type ExportJobsInsert = typeof exportJobs.$inferInsert;
