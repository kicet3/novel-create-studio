// Drizzle mirror of the SQL migrations (columns only — constraints, FKs and indexes live in SQL).
// Owning module: concept (design/08 §2.3).
import { bigint, boolean, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { ENUMS } from "@ncs/shared/enums";

/** concept_sessions */
export const conceptSessions = pgTable(
  "concept_sessions",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    purpose: text("purpose", { enum: ENUMS.concept_session_purpose }).notNull().default("initial"),
    entryMode: text("entry_mode", { enum: ENUMS.concept_entry_mode }).notNull().default("conversation"),
    baseBriefId: text("base_brief_id"),
    status: text("status", { enum: ENUMS.concept_session_status }).notNull().default("active"),
    stage: text("stage", { enum: ENUMS.concept_stage }).notNull().default("opening"),
    pauseReason: text("pause_reason", { enum: ENUMS.concept_pause_reason }),
    workingBrief: jsonb("working_brief").$type<unknown>().notNull().default({}),
    fieldFlipCounts: jsonb("field_flip_counts").$type<unknown>().notNull().default({}),
    agentTurnCount: integer("agent_turn_count").notNull().default(0),
    userMessageCount: integer("user_message_count").notNull().default(0),
    turnLimit: integer("turn_limit").notNull().default(40),
    turnExtensionCount: integer("turn_extension_count").notNull().default(0),
    llmDisabled: boolean("llm_disabled").notNull().default(false),
    budgetLimitMicros: bigint("budget_limit_micros", { mode: "number" }).notNull(),
    spentMicros: bigint("spent_micros", { mode: "number" }).notNull().default(0),
    activeChannelId: text("active_channel_id").notNull(),
    inFlightTaskId: text("in_flight_task_id"),
    questionSetVersion: text("question_set_version").notNull().default("common@1"),
    templateRefs: jsonb("template_refs").$type<unknown>().notNull().default([]),
    pendingApprovalId: text("pending_approval_id"),
    approvedBriefId: text("approved_brief_id"),
    lastUserMessageAt: timestamp("last_user_message_at", { withTimezone: true, mode: "date" }),
    remindedAt: timestamp("reminded_at", { withTimezone: true, mode: "date" }),
    createdByUserId: text("created_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type ConceptSessionsRow = typeof conceptSessions.$inferSelect;
export type ConceptSessionsInsert = typeof conceptSessions.$inferInsert;

/** concept_messages */
export const conceptMessages = pgTable(
  "concept_messages",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    sessionId: text("session_id").notNull(),
    seq: integer("seq").notNull(),
    authorKind: text("author_kind", { enum: ENUMS.concept_message_author }).notNull(),
    authorUserId: text("author_user_id"),
    runId: text("run_id"),
    channelId: text("channel_id").notNull(),
    inboxId: text("inbox_id"),
    outboxId: text("outbox_id"),
    kind: text("kind", { enum: ENUMS.concept_message_kind }).notNull(),
    body: text("body").notNull(),
    options: jsonb("options").$type<unknown>(),
    pickedIdx: integer("picked_idx"),
    askedFieldPaths: text("asked_field_paths").array(),
    slotUpdates: jsonb("slot_updates").$type<unknown>().notNull().default([]),
    respondsToSeq: integer("responds_to_seq"),
    isSuperseded: boolean("is_superseded").notNull().default(false),
    providerMessageRef: text("provider_message_ref"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type ConceptMessagesRow = typeof conceptMessages.$inferSelect;
export type ConceptMessagesInsert = typeof conceptMessages.$inferInsert;

/** concept_briefs */
export const conceptBriefs = pgTable(
  "concept_briefs",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    sessionId: text("session_id").notNull(),
    versionNo: integer("version_no").notNull(),
    status: text("status", { enum: ENUMS.concept_brief_status }).notNull().default("awaiting_approval"),
    approvalId: text("approval_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "date" }),
    supersedesId: text("supersedes_id"),
    authorActorType: text("author_actor_type", { enum: ENUMS.actor_type }).notNull(),
    authorActorId: text("author_actor_id").notNull(),
    entryMode: text("entry_mode", { enum: ENUMS.concept_entry_mode }).notNull(),
    questionSetVersion: text("question_set_version").notNull(),
    templateRefs: jsonb("template_refs").$type<unknown>().notNull().default([]),
    templateOverrides: jsonb("template_overrides").$type<unknown>().notNull().default([]),
    content: jsonb("content").$type<unknown>().notNull(),
    contentMd: text("content_md").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type ConceptBriefsRow = typeof conceptBriefs.$inferSelect;
export type ConceptBriefsInsert = typeof conceptBriefs.$inferInsert;
