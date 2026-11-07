// Drizzle mirror of the SQL migrations (columns only — constraints, FKs and indexes live in SQL).
// Owning module: revision (0018_revision_chat.sql, 설계 추가: 화별 수정 대화).
import { integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { ENUMS } from "@ncs/shared/enums";

/** passage the author asked about ([이 부분 묻기]) */
export interface RevisionAnchorJson {
  versionId: string;
  quote: string;
  start: number;
  end: number;
}

/** revision_chat_sessions — one thread per episode */
export const revisionChatSessions = pgTable("revision_chat_sessions", {
  id: text("id").notNull().primaryKey(),
  novelId: text("novel_id").notNull(),
  episodeId: text("episode_id").notNull(),
  status: text("status", { enum: ENUMS.revision_chat_session_status }).notNull().default("active"),
  outcome: text("outcome", { enum: ENUMS.revision_chat_outcome }),
  inFlightTaskId: text("in_flight_task_id"),
  lastProcessedSeq: integer("last_processed_seq").notNull().default(0),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});
export type RevisionChatSessionsRow = typeof revisionChatSessions.$inferSelect;
export type RevisionChatSessionsInsert = typeof revisionChatSessions.$inferInsert;

/** revision_chat_messages — append-only thread */
export const revisionChatMessages = pgTable("revision_chat_messages", {
  id: text("id").notNull().primaryKey(),
  novelId: text("novel_id").notNull(),
  sessionId: text("session_id").notNull(),
  seq: integer("seq").notNull(),
  authorKind: text("author_kind", { enum: ENUMS.revision_chat_author }).notNull(),
  body: text("body").notNull(),
  runId: text("run_id"),
  anchor: jsonb("anchor").$type<RevisionAnchorJson | null>(),
  diagnosisKind: text("diagnosis_kind", { enum: ENUMS.revision_diagnosis_kind }),
  question: jsonb("question").$type<{ text: string; options: string[] } | null>(),
  sources: jsonb("sources").$type<Array<{ kind: string; refId: string | null; quote: string | null }> | null>(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});
export type RevisionChatMessagesRow = typeof revisionChatMessages.$inferSelect;
export type RevisionChatMessagesInsert = typeof revisionChatMessages.$inferInsert;

/** revision_chat_proposals — text patch / setting change / impact note, decided one by one */
export const revisionChatProposals = pgTable("revision_chat_proposals", {
  id: text("id").notNull().primaryKey(),
  novelId: text("novel_id").notNull(),
  sessionId: text("session_id").notNull(),
  messageId: text("message_id").notNull(),
  kind: text("kind", { enum: ENUMS.revision_proposal_kind }).notNull(),
  status: text("status", { enum: ENUMS.revision_proposal_status }).notNull().default("pending"),
  baseVersionId: text("base_version_id"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  resultVersionId: text("result_version_id"),
  approvalId: text("approval_id"),
  decidedByUserId: text("decided_by_user_id"),
  decidedAt: timestamp("decided_at", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});
export type RevisionChatProposalsRow = typeof revisionChatProposals.$inferSelect;
export type RevisionChatProposalsInsert = typeof revisionChatProposals.$inferInsert;

/** episode_author_notes — "작가 확인: 의도대로 둠" fed to later writing contexts */
export const episodeAuthorNotes = pgTable("episode_author_notes", {
  id: text("id").notNull().primaryKey(),
  novelId: text("novel_id").notNull(),
  episodeId: text("episode_id").notNull(),
  sessionId: text("session_id"),
  body: text("body").notNull(),
  status: text("status", { enum: ENUMS.author_note_status }).notNull().default("active"),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});
export type EpisodeAuthorNotesRow = typeof episodeAuthorNotes.$inferSelect;
export type EpisodeAuthorNotesInsert = typeof episodeAuthorNotes.$inferInsert;
