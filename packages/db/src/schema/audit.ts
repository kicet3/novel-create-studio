// Drizzle mirror of the SQL migrations (columns only — constraints, FKs and indexes live in SQL).
// Owning module: audit (design/08 §2.3).
import { bigint, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { ENUMS } from "@ncs/shared/enums";

/** activity_log — append-only; seq = realtime event id (ADR-017) */
export const activityLog = pgTable(
  "activity_log",
  {
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity().notNull().primaryKey(),
    id: text("id").notNull(),
    novelId: text("novel_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    actorType: text("actor_type", { enum: ENUMS.actor_type }).notNull(),
    actorId: text("actor_id").notNull(),
    runId: text("run_id"),
    questionId: text("question_id"),
    approvalId: text("approval_id"),
    answerId: text("answer_id"),
    action: text("action").notNull(),
    targetType: text("target_type", { enum: ENUMS.ref_type }).notNull(),
    targetId: text("target_id").notNull(),
    before: jsonb("before").$type<unknown>(),
    after: jsonb("after").$type<unknown>(),
    reason: text("reason"),
    details: jsonb("details").$type<unknown>(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type ActivityLogRow = typeof activityLog.$inferSelect;
export type ActivityLogInsert = typeof activityLog.$inferInsert;
