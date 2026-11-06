/** drizzle access to the tables owned by `hitl`. Every novel-owned query filters by novel_id (03 T-3). */
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "@ncs/db/orm";
import {
  answerInterpretations,
  answerReflectionItems,
  answerReflections,
  answerSessions,
  answers,
  approvals,
  digestBatches,
  questionDeliveries,
  questionLinks,
  questionOptions,
  questions,
} from "@ncs/db/schema";
import type { ApprovalStatus, ApprovalType, QuestionDeliveryState, QuestionStatus } from "@ncs/shared";
import type { Db, NovelScope } from "../../../../platform/index.js";
import type { Answer, Approval, Question, QuestionFilter } from "../../index.js";

export type QuestionOption = typeof questionOptions.$inferSelect;
export type QuestionLink = typeof questionLinks.$inferSelect;
export type QuestionDelivery = typeof questionDeliveries.$inferSelect;
export type Interpretation = typeof answerInterpretations.$inferSelect;
export type Reflection = typeof answerReflections.$inferSelect;
export type ReflectionItem = typeof answerReflectionItems.$inferSelect;
export type AnswerSession = typeof answerSessions.$inferSelect;
export type DigestBatch = typeof digestBatches.$inferSelect;

const nq = (scope: NovelScope) => eq(questions.novelId, scope.novelId);

export const hitlRepo = {
  // ── questions ──
  async insertQuestion(db: Db, row: typeof questions.$inferInsert): Promise<Question> {
    const [q] = await db.insert(questions).values(row).returning();
    return q!;
  },
  async getQuestion(db: Db, scope: NovelScope, id: string, forUpdate = false): Promise<Question | null> {
    const q = db.select().from(questions).where(and(nq(scope), eq(questions.id, id)));
    const [r] = forUpdate ? await q.for("update") : await q;
    return r ?? null;
  },
  /** CAS: UPDATE … WHERE status IN (from) RETURNING */
  async updateQuestion(db: Db, scope: NovelScope, id: string, from: QuestionStatus[] | null, patch: Partial<typeof questions.$inferInsert>): Promise<Question | null> {
    const conds = [nq(scope), eq(questions.id, id)];
    if (from) conds.push(inArray(questions.status, from));
    const [r] = await db.update(questions).set(patch).where(and(...conds)).returning();
    return r ?? null;
  },
  listQuestions(db: Db, scope: NovelScope, f: QuestionFilter = {}) {
    const conds = [nq(scope)];
    if (f.statuses?.length) conds.push(inArray(questions.status, f.statuses));
    if (f.grades?.length) conds.push(inArray(questions.grade, f.grades));
    if (f.topics?.length) conds.push(inArray(questions.topic, f.topics));
    return db
      .select()
      .from(questions)
      .where(and(...conds))
      .orderBy(desc(questions.displayNo))
      .limit(Math.min(f.limit ?? 200, 500));
  },
  pendingNovelIds: (db: Db) => db.selectDistinct({ novelId: questions.novelId }).from(questions).where(eq(questions.status, "pending")),
  openNovelIds: (db: Db) => db.selectDistinct({ novelId: questions.novelId }).from(questions).where(eq(questions.status, "open")),
  async countNonBlockingSentToday(db: Db, scope: NovelScope, timeZone: string, now: Date): Promise<number> {
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(questions)
      .where(
        and(
          nq(scope),
          eq(questions.grade, "non_blocking"),
          or(
            sql`(${questions.sentAt} AT TIME ZONE ${timeZone})::date = (${now.toISOString()}::timestamptz AT TIME ZONE ${timeZone})::date`,
            and(eq(questions.status, "pending"), sql`${questions.digestBatchId} IS NOT NULL`),
          ),
        ),
      );
    return r?.n ?? 0;
  },
  async nextDisplayNoFallback(db: Db, scope: NovelScope): Promise<number> {
    const [r] = await db.select({ n: sql<number>`coalesce(max(${questions.displayNo}), 0)::int` }).from(questions).where(nq(scope));
    return (r?.n ?? 0) + 1;
  },

  // ── options / links ──
  async insertOptions(db: Db, rows: Array<typeof questionOptions.$inferInsert>): Promise<void> {
    if (rows.length) await db.insert(questionOptions).values(rows);
  },
  listOptions: (db: Db, scope: NovelScope, questionId: string) =>
    db
      .select()
      .from(questionOptions)
      .where(and(eq(questionOptions.novelId, scope.novelId), eq(questionOptions.questionId, questionId)))
      .orderBy(asc(questionOptions.idx)),
  async insertLinks(db: Db, rows: Array<typeof questionLinks.$inferInsert>): Promise<void> {
    if (rows.length) await db.insert(questionLinks).values(rows).onConflictDoNothing();
  },
  listLinks: (db: Db, scope: NovelScope, questionId: string) =>
    db
      .select()
      .from(questionLinks)
      .where(and(eq(questionLinks.novelId, scope.novelId), eq(questionLinks.questionId, questionId)))
      .orderBy(asc(questionLinks.id)),

  // ── deliveries ──
  async insertDelivery(db: Db, row: typeof questionDeliveries.$inferInsert): Promise<QuestionDelivery | null> {
    const [r] = await db.insert(questionDeliveries).values(row).onConflictDoNothing().returning();
    return r ?? null;
  },
  listDeliveries: (db: Db, scope: NovelScope, questionId: string) =>
    db.select().from(questionDeliveries).where(and(eq(questionDeliveries.novelId, scope.novelId), eq(questionDeliveries.questionId, questionId))),
  async updateDelivery(db: Db, scope: NovelScope, id: string, from: QuestionDeliveryState[], patch: Partial<typeof questionDeliveries.$inferInsert>): Promise<QuestionDelivery | null> {
    const [r] = await db
      .update(questionDeliveries)
      .set(patch)
      .where(and(eq(questionDeliveries.novelId, scope.novelId), eq(questionDeliveries.id, id), inArray(questionDeliveries.state, from)))
      .returning();
    return r ?? null;
  },
  deliveriesByOutbox: (db: Db, scope: NovelScope, outboxId: string) =>
    db.select().from(questionDeliveries).where(and(eq(questionDeliveries.novelId, scope.novelId), eq(questionDeliveries.outboxId, outboxId))),

  // ── answers ──
  async insertAnswer(db: Db, row: typeof answers.$inferInsert): Promise<Answer> {
    const [r] = await db.insert(answers).values(row).returning();
    return r!;
  },
  async getAnswer(db: Db, scope: NovelScope, id: string): Promise<Answer | null> {
    const [r] = await db.select().from(answers).where(and(eq(answers.novelId, scope.novelId), eq(answers.id, id)));
    return r ?? null;
  },
  listAnswers: (db: Db, scope: NovelScope, questionId: string) =>
    db.select().from(answers).where(and(eq(answers.novelId, scope.novelId), eq(answers.questionId, questionId))).orderBy(asc(answers.receivedAt), asc(answers.id)),
  async findAnswerBySource(db: Db, scope: NovelScope, questionId: string, sourceKey: string): Promise<Answer | null> {
    const [r] = await db
      .select()
      .from(answers)
      .where(and(eq(answers.novelId, scope.novelId), eq(answers.questionId, questionId), sql`${answers.payload}->>'source_key' = ${sourceKey}`))
      .limit(1);
    return r ?? null;
  },
  async updateAnswer(db: Db, scope: NovelScope, id: string, patch: Partial<typeof answers.$inferInsert>): Promise<Answer | null> {
    const [r] = await db.update(answers).set(patch).where(and(eq(answers.novelId, scope.novelId), eq(answers.id, id))).returning();
    return r ?? null;
  },
  async countLate(db: Db, scope: NovelScope): Promise<number> {
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(answers)
      .where(and(eq(answers.novelId, scope.novelId), eq(answers.disposition, "late"), eq(answers.lateResolution, "pending_user_choice")));
    return r?.n ?? 0;
  },

  // ── interpretations ──
  async insertInterpretation(db: Db, row: typeof answerInterpretations.$inferInsert): Promise<Interpretation> {
    const [r] = await db.insert(answerInterpretations).values(row).returning();
    return r!;
  },
  async interpretationByConfirmQuestion(db: Db, scope: NovelScope, questionId: string): Promise<Interpretation | null> {
    const [r] = await db
      .select()
      .from(answerInterpretations)
      .where(and(eq(answerInterpretations.novelId, scope.novelId), eq(answerInterpretations.confirmQuestionId, questionId)))
      .orderBy(desc(answerInterpretations.createdAt))
      .limit(1);
    return r ?? null;
  },
  listInterpretationsForAnswers: (db: Db, scope: NovelScope, answerIds: string[]) =>
    answerIds.length
      ? db
          .select()
          .from(answerInterpretations)
          .where(and(eq(answerInterpretations.novelId, scope.novelId), inArray(answerInterpretations.answerId, answerIds)))
          .orderBy(asc(answerInterpretations.createdAt))
      : Promise.resolve([] as Interpretation[]),
  async updateInterpretation(db: Db, scope: NovelScope, id: string, from: Interpretation["status"][], patch: Partial<typeof answerInterpretations.$inferInsert>): Promise<Interpretation | null> {
    const [r] = await db
      .update(answerInterpretations)
      .set(patch)
      .where(and(eq(answerInterpretations.novelId, scope.novelId), eq(answerInterpretations.id, id), inArray(answerInterpretations.status, from)))
      .returning();
    return r ?? null;
  },

  // ── reflections ──
  async insertReflection(db: Db, row: typeof answerReflections.$inferInsert): Promise<Reflection> {
    const [r] = await db.insert(answerReflections).values(row).onConflictDoNothing().returning();
    if (r) return r;
    const [e] = await db
      .select()
      .from(answerReflections)
      .where(and(eq(answerReflections.novelId, row.novelId), eq(answerReflections.questionId, row.questionId)));
    return e!;
  },
  async reflectionByQuestion(db: Db, scope: NovelScope, questionId: string, forUpdate = false): Promise<Reflection | null> {
    const q = db.select().from(answerReflections).where(and(eq(answerReflections.novelId, scope.novelId), eq(answerReflections.questionId, questionId)));
    const [r] = forUpdate ? await q.for("update") : await q;
    return r ?? null;
  },
  async updateReflection(db: Db, scope: NovelScope, id: string, patch: Partial<typeof answerReflections.$inferInsert>, onlyPending = false): Promise<Reflection | null> {
    const conds = [eq(answerReflections.novelId, scope.novelId), eq(answerReflections.id, id)];
    if (onlyPending) conds.push(eq(answerReflections.status, "pending"));
    const [r] = await db.update(answerReflections).set(patch).where(and(...conds)).returning();
    return r ?? null;
  },
  async insertReflectionItems(db: Db, rows: Array<typeof answerReflectionItems.$inferInsert>): Promise<void> {
    if (rows.length) await db.insert(answerReflectionItems).values(rows);
  },
  listReflectionItems: (db: Db, scope: NovelScope, reflectionId: string) =>
    db
      .select()
      .from(answerReflectionItems)
      .where(and(eq(answerReflectionItems.novelId, scope.novelId), eq(answerReflectionItems.reflectionId, reflectionId)))
      .orderBy(asc(answerReflectionItems.id)),
  async countPendingReflections(db: Db, scope: NovelScope): Promise<number> {
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(answerReflections)
      .where(and(eq(answerReflections.novelId, scope.novelId), eq(answerReflections.status, "pending")));
    return r?.n ?? 0;
  },
  answeredWithPendingNoticeNovelIds: (db: Db) =>
    db
      .selectDistinct({ novelId: answerReflections.novelId })
      .from(answerReflections)
      .where(and(inArray(answerReflections.status, ["applied", "not_applied"]), isNull(answerReflections.notifiedAt))),
  childQuestions: (db: Db, scope: NovelScope, parentId: string) =>
    db.select().from(questions).where(and(nq(scope), eq(questions.parentQuestionId, parentId))).for("update"),
  /** finished reflections not yet notified (non-blocking notices wait for the next digest, 05 §8.1 F7) */
  unnotifiedReflections: (db: Db, scope: NovelScope) =>
    db
      .select()
      .from(answerReflections)
      .where(and(eq(answerReflections.novelId, scope.novelId), inArray(answerReflections.status, ["applied", "not_applied"]), isNull(answerReflections.notifiedAt))),

  // ── approvals ──
  async insertApproval(db: Db, row: typeof approvals.$inferInsert): Promise<Approval> {
    const [r] = await db.insert(approvals).values(row).returning();
    return r!;
  },
  async getApproval(db: Db, scope: NovelScope, id: string, forUpdate = false): Promise<Approval | null> {
    const q = db.select().from(approvals).where(and(eq(approvals.novelId, scope.novelId), eq(approvals.id, id)));
    const [r] = forUpdate ? await q.for("update") : await q;
    return r ?? null;
  },
  async approvalByQuestion(db: Db, scope: NovelScope, questionId: string): Promise<Approval | null> {
    const [r] = await db.select().from(approvals).where(and(eq(approvals.novelId, scope.novelId), eq(approvals.questionId, questionId)));
    return r ?? null;
  },
  async pendingApprovalFor(db: Db, scope: NovelScope, subjectType: Approval["subjectType"], subjectId: string, type: ApprovalType): Promise<Approval | null> {
    const [r] = await db
      .select()
      .from(approvals)
      .where(and(eq(approvals.novelId, scope.novelId), eq(approvals.subjectType, subjectType), eq(approvals.subjectId, subjectId), eq(approvals.approvalType, type), eq(approvals.status, "pending")))
      .for("update");
    return r ?? null;
  },
  async updateApproval(db: Db, scope: NovelScope, id: string, from: ApprovalStatus[], patch: Partial<typeof approvals.$inferInsert>): Promise<Approval | null> {
    const [r] = await db
      .update(approvals)
      .set(patch)
      .where(and(eq(approvals.novelId, scope.novelId), eq(approvals.id, id), inArray(approvals.status, from)))
      .returning();
    return r ?? null;
  },
  listApprovals(db: Db, scope: NovelScope, f: { statuses?: ApprovalStatus[]; types?: ApprovalType[] } = {}) {
    const conds = [eq(approvals.novelId, scope.novelId)];
    if (f.statuses?.length) conds.push(inArray(approvals.status, f.statuses));
    if (f.types?.length) conds.push(inArray(approvals.approvalType, f.types));
    return db.select().from(approvals).where(and(...conds)).orderBy(desc(approvals.createdAt));
  },

  // ── digest batches ──
  async insertDigest(db: Db, row: typeof digestBatches.$inferInsert): Promise<DigestBatch> {
    const [r] = await db.insert(digestBatches).values(row).returning();
    return r!;
  },
  async collectingDigest(db: Db, scope: NovelScope, channelId: string | null): Promise<DigestBatch | null> {
    const [r] = await db
      .select()
      .from(digestBatches)
      .where(
        and(
          eq(digestBatches.novelId, scope.novelId),
          eq(digestBatches.kind, "non_blocking_digest"),
          eq(digestBatches.status, "collecting"),
          channelId ? eq(digestBatches.channelId, channelId) : isNull(digestBatches.channelId),
        ),
      )
      .orderBy(asc(digestBatches.createdAt))
      .limit(1)
      .for("update");
    return r ?? null;
  },
  listCollectingDigests: (db: Db, scope: NovelScope) =>
    db
      .select()
      .from(digestBatches)
      .where(and(eq(digestBatches.novelId, scope.novelId), eq(digestBatches.status, "collecting")))
      .orderBy(asc(digestBatches.createdAt)),
  async updateDigest(db: Db, scope: NovelScope, id: string, patch: Partial<typeof digestBatches.$inferInsert>): Promise<DigestBatch | null> {
    const [r] = await db
      .update(digestBatches)
      .set(patch)
      .where(and(eq(digestBatches.novelId, scope.novelId), eq(digestBatches.id, id), eq(digestBatches.status, "collecting")))
      .returning();
    return r ?? null;
  },
  collectingNovelIds: (db: Db) => db.selectDistinct({ novelId: digestBatches.novelId }).from(digestBatches).where(eq(digestBatches.status, "collecting")),

  // ── answer sessions ──
  async insertSession(db: Db, row: typeof answerSessions.$inferInsert): Promise<AnswerSession> {
    const [r] = await db.insert(answerSessions).values(row).returning();
    return r!;
  },
  async activeSession(db: Db, scope: NovelScope, channelId: string, responder: string): Promise<AnswerSession | null> {
    const [r] = await db
      .select()
      .from(answerSessions)
      .where(
        and(
          eq(answerSessions.novelId, scope.novelId),
          eq(answerSessions.channelId, channelId),
          eq(answerSessions.responderExternalRef, responder),
          eq(answerSessions.status, "active"),
        ),
      )
      .for("update");
    return r ?? null;
  },
  async updateSession(db: Db, scope: NovelScope, id: string, patch: Partial<typeof answerSessions.$inferInsert>): Promise<AnswerSession | null> {
    const [r] = await db
      .update(answerSessions)
      .set(patch)
      .where(and(eq(answerSessions.novelId, scope.novelId), eq(answerSessions.id, id), eq(answerSessions.status, "active")))
      .returning();
    return r ?? null;
  },
  cancelSessionsForQuestion: (db: Db, scope: NovelScope, questionId: string, at: Date, exceptId?: string) =>
    db
      .update(answerSessions)
      .set({ status: "cancelled", updatedAt: at })
      .where(
        and(
          eq(answerSessions.novelId, scope.novelId),
          eq(answerSessions.questionId, questionId),
          eq(answerSessions.status, "active"),
          ...(exceptId ? [sql`${answerSessions.id} <> ${exceptId}`] : []),
        ),
      )
      .returning(),
  expireSessions: (db: Db, at: Date) =>
    db
      .update(answerSessions)
      .set({ status: "expired", updatedAt: at })
      .where(and(eq(answerSessions.status, "active"), lte(answerSessions.expiresAt, at)))
      .returning(),
};
