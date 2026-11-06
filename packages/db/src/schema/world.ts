// Drizzle mirror of the SQL migrations (columns only — constraints, FKs and indexes live in SQL).
// Owning module: world (0012_world_ontology.sql, 설계 추가: 세계관 온톨로지 생성).
import { boolean, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { ENUMS } from "@ncs/shared/enums";

/** one web source behind a world ontology candidate (provider_calls.response.webSearch.citations subset) */
export interface WorldItemSourceJson {
  url: string;
  title: string | null;
  retrievedAt: string;
}

/**
 * world_ontology_items — one reviewable world candidate: an entity (faction / place / system / object / history /
 * constraint) with the facts it owns (attributes, rule statement), or one relation fact. The entity and facts live in
 * the ontology tables; this row keeps the kind, provenance (task, run, web sources) and review status.
 */
export const worldOntologyItems = pgTable("world_ontology_items", {
  id: text("id").notNull().primaryKey(),
  novelId: text("novel_id").notNull(),
  kind: text("kind", { enum: ENUMS.world_item_kind }).notNull(),
  status: text("status", { enum: ENUMS.world_item_status }).notNull().default("pending"),
  origin: text("origin", { enum: ENUMS.world_item_origin }).notNull().default("agent"),
  userEdited: boolean("user_edited").notNull().default(false),
  entityId: text("entity_id"),
  factIds: text("fact_ids").array().notNull().default(sql`'{}'`),
  taskId: text("task_id"),
  runId: text("run_id"),
  sources: jsonb("sources").$type<WorldItemSourceJson[]>().notNull().default([]),
  note: text("note"),
  fromBrief: boolean("from_brief").notNull().default(false),
  heldReason: text("held_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type WorldOntologyItemsRow = typeof worldOntologyItems.$inferSelect;
export type WorldOntologyItemsInsert = typeof worldOntologyItems.$inferInsert;
