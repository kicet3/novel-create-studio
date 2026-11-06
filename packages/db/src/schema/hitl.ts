// Drizzle mirror of the SQL migrations (columns only — constraints, FKs and indexes live in SQL).
// Owning module: hitl (design/08 §2.3).
import { bigint, boolean, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { ENUMS } from "@ncs/shared/enums";

/** questions */
export const questions = pgTable(
  "questions",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    displayNo: integer("display_no").notNull(),
    grade: text("grade", { enum: ENUMS.question_grade }).notNull(),
    questionType: text("question_type", { enum: ENUMS.question_type }).notNull(),
    topic: text("topic", { enum: ENUMS.question_topic }).notNull(),
    status: text("status", { enum: ENUMS.question_status }).notNull().default("pending"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    recommendation: jsonb("recommendation").$type<unknown>(),
    rationale: text("rationale").notNull(),
    blockingBasis: text("blocking_basis", { enum: ENUMS.blocking_basis }).notNull(),
    gradeReason: text("grade_reason").notNull(),
    deadlineAt: timestamp("deadline_at", { withTimezone: true, mode: "date" }),
    reminderCount: integer("reminder_count").notNull().default(0),
    lastRemindedAt: timestamp("last_reminded_at", { withTimezone: true, mode: "date" }),
    askedByRole: text("asked_by_role", { enum: ENUMS.agent_role }),
    createdByRunId: text("created_by_run_id"),
    approvalId: text("approval_id"),
    parentQuestionId: text("parent_question_id"),
    dependsOnQuestionId: text("depends_on_question_id"),
    digestBatchId: text("digest_batch_id"),
    acceptedAnswerId: text("accepted_answer_id"),
    resolutionSource: text("resolution_source", { enum: ENUMS.resolution_source }),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }),
    answeredAt: timestamp("answered_at", { withTimezone: true, mode: "date" }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
    cancelledReason: text("cancelled_reason"),
    /** 설계 추가 0014: high = 완전 자율에서도 자동 응답하지 않음 */
    sensitivity: text("sensitivity", { enum: ENUMS.question_sensitivity }).notNull().default("normal"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type QuestionsRow = typeof questions.$inferSelect;
export type QuestionsInsert = typeof questions.$inferInsert;

/** question_options */
export const questionOptions = pgTable(
  "question_options",
  {
    novelId: text("novel_id").notNull(),
    questionId: text("question_id").notNull(),
    idx: integer("idx").notNull(),
    label: text("label").notNull(),
    value: jsonb("value").$type<unknown>(),
    isRecommended: boolean("is_recommended").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.novelId, t.questionId, t.idx] })],
);
export type QuestionOptionsRow = typeof questionOptions.$inferSelect;
export type QuestionOptionsInsert = typeof questionOptions.$inferInsert;

/** question_links */
export const questionLinks = pgTable(
  "question_links",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    questionId: text("question_id").notNull(),
    refType: text("ref_type", { enum: ENUMS.ref_type }).notNull(),
    refId: text("ref_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type QuestionLinksRow = typeof questionLinks.$inferSelect;
export type QuestionLinksInsert = typeof questionLinks.$inferInsert;

/** question_deliveries */
export const questionDeliveries = pgTable(
  "question_deliveries",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    questionId: text("question_id").notNull(),
    channelId: text("channel_id").notNull(),
    state: text("state", { enum: ENUMS.question_delivery_state }).notNull().default("pending"),
    outboxId: text("outbox_id"),
    providerMessageRef: text("provider_message_ref"),
    postedAt: timestamp("posted_at", { withTimezone: true, mode: "date" }),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type QuestionDeliveriesRow = typeof questionDeliveries.$inferSelect;
export type QuestionDeliveriesInsert = typeof questionDeliveries.$inferInsert;

/** answers */
export const answers = pgTable(
  "answers",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    questionId: text("question_id").notNull(),
    channelId: text("channel_id").notNull(),
    inboxId: text("inbox_id"),
    responderUserId: text("responder_user_id").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" }).notNull(),
    payload: jsonb("payload").$type<unknown>().notNull(),
    disposition: text("disposition", { enum: ENUMS.answer_disposition }).notNull(),
    lateResolution: text("late_resolution", { enum: ENUMS.late_answer_resolution }),
    lateResolutionRefType: text("late_resolution_ref_type", { enum: ENUMS.ref_type }),
    lateResolutionRefId: text("late_resolution_ref_id"),
    /** 설계 추가 0014: 완전 자율이 위임한 사람 대신 답한 행 */
    autoAnswered: boolean("auto_answered").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type AnswersRow = typeof answers.$inferSelect;
export type AnswersInsert = typeof answers.$inferInsert;

/** answer_interpretations */
export const answerInterpretations = pgTable(
  "answer_interpretations",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    answerId: text("answer_id").notNull(),
    runId: text("run_id").notNull(),
    status: text("status", { enum: ENUMS.interpretation_status }).notNull().default("proposed"),
    proposedChanges: jsonb("proposed_changes").$type<unknown>().notNull(),
    confirmQuestionId: text("confirm_question_id"),
    finalChanges: jsonb("final_changes").$type<unknown>(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type AnswerInterpretationsRow = typeof answerInterpretations.$inferSelect;
export type AnswerInterpretationsInsert = typeof answerInterpretations.$inferInsert;

/** answer_reflections */
export const answerReflections = pgTable(
  "answer_reflections",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    questionId: text("question_id").notNull(),
    answerId: text("answer_id"),
    status: text("status", { enum: ENUMS.reflection_status }).notNull().default("pending"),
    consumerRunIds: text("consumer_run_ids").array().notNull().default(sql`'{}'`),
    locations: jsonb("locations").$type<unknown>().notNull().default([]),
    notAppliedReason: text("not_applied_reason"),
    notifiedAt: timestamp("notified_at", { withTimezone: true, mode: "date" }),
    noticeOutboxId: text("notice_outbox_id"),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type AnswerReflectionsRow = typeof answerReflections.$inferSelect;
export type AnswerReflectionsInsert = typeof answerReflections.$inferInsert;

/** answer_reflection_items */
export const answerReflectionItems = pgTable(
  "answer_reflection_items",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    reflectionId: text("reflection_id").notNull(),
    changeKind: text("change_kind", { enum: ENUMS.reflection_change_kind }).notNull(),
    refType: text("ref_type", { enum: ENUMS.ref_type }),
    refId: text("ref_id"),
    summary: text("summary").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type AnswerReflectionItemsRow = typeof answerReflectionItems.$inferSelect;
export type AnswerReflectionItemsInsert = typeof answerReflectionItems.$inferInsert;

/** answer_sessions */
export const answerSessions = pgTable(
  "answer_sessions",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    channelId: text("channel_id").notNull(),
    questionId: text("question_id").notNull(),
    responderExternalRef: text("responder_external_ref").notNull(),
    step: text("step").notNull(),
    collected: jsonb("collected").$type<unknown>().notNull().default({}),
    promptMessageRef: text("prompt_message_ref"),
    status: text("status", { enum: ENUMS.answer_session_status }).notNull().default("active"),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type AnswerSessionsRow = typeof answerSessions.$inferSelect;
export type AnswerSessionsInsert = typeof answerSessions.$inferInsert;

/** approvals */
export const approvals = pgTable(
  "approvals",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    approvalType: text("approval_type", { enum: ENUMS.approval_type }).notNull(),
    status: text("status", { enum: ENUMS.approval_status }).notNull().default("pending"),
    subjectType: text("subject_type", { enum: ENUMS.ref_type }).notNull(),
    subjectId: text("subject_id").notNull(),
    questionId: text("question_id").notNull(),
    payload: jsonb("payload").$type<unknown>().notNull().default({}),
    requestedByActorType: text("requested_by_actor_type", { enum: ENUMS.actor_type }).notNull(),
    requestedByActorId: text("requested_by_actor_id").notNull(),
    decidedByUserId: text("decided_by_user_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "date" }),
    decisionNote: text("decision_note"),
    reworkFrom: text("rework_from", { enum: ENUMS.rework_from }),
    decidedViaChannelId: text("decided_via_channel_id"),
    isAbsenceDelegated: boolean("is_absence_delegated").notNull().default(false),
    supersededById: text("superseded_by_id"),
    /** 설계 추가 0014: 완전 자율이 결정한 승인(승인만, 허용된 종류만 — approvals_ck_auto) */
    autoDecided: boolean("auto_decided").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type ApprovalsRow = typeof approvals.$inferSelect;
export type ApprovalsInsert = typeof approvals.$inferInsert;

/** digest_batches */
export const digestBatches = pgTable(
  "digest_batches",
  {
    id: text("id").notNull().primaryKey(),
    novelId: text("novel_id").notNull(),
    kind: text("kind", { enum: ENUMS.digest_kind }).notNull(),
    status: text("status", { enum: ENUMS.digest_status }).notNull().default("collecting"),
    channelId: text("channel_id"),
    windowStartAt: timestamp("window_start_at", { withTimezone: true, mode: "date" }).notNull(),
    windowEndAt: timestamp("window_end_at", { withTimezone: true, mode: "date" }).notNull(),
    questionIds: text("question_ids").array().notNull().default(sql`'{}'`),
    outboxId: text("outbox_id"),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
);
export type DigestBatchesRow = typeof digestBatches.$inferSelect;
export type DigestBatchesInsert = typeof digestBatches.$inferInsert;
