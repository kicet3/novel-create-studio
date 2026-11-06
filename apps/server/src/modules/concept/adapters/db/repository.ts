/** Drizzle repository for concept_sessions / concept_messages / concept_briefs (always scoped by novel_id, T-3). */
import { and, asc, desc, eq, gt, inArray, isNull, lt, max, or, sql } from "@ncs/db/orm";
import { conceptBriefs, conceptMessages, conceptSessions } from "@ncs/db/schema";
import type { ConceptBriefsInsert, ConceptMessagesInsert, ConceptSessionsInsert } from "@ncs/db/schema";
import type { ConceptBriefStatus, ConceptSessionStatus } from "@ncs/shared";
import type { Db, NovelScope } from "../../../../platform/index.js";
import type { ConceptBrief, ConceptMessage, ConceptSession } from "../../index.js";

type SessionPatch = Partial<Omit<ConceptSessionsInsert, "id" | "novelId">>;

export const conceptRepo = {
  async getSession(db: Db, scope: NovelScope, id: string, forUpdate = false): Promise<ConceptSession | null> {
    const q = db.select().from(conceptSessions).where(and(eq(conceptSessions.novelId, scope.novelId), eq(conceptSessions.id, id)));
    const [row] = forUpdate ? await q.for("update") : await q;
    return row ?? null;
  },
  async getOpenSession(db: Db, scope: NovelScope, forUpdate = false): Promise<ConceptSession | null> {
    const q = db
      .select()
      .from(conceptSessions)
      .where(and(eq(conceptSessions.novelId, scope.novelId), inArray(conceptSessions.status, ["active", "awaiting_approval", "paused"])))
      .limit(1);
    const [row] = forUpdate ? await q.for("update") : await q;
    return row ?? null;
  },
  async latestSession(db: Db, scope: NovelScope): Promise<ConceptSession | null> {
    const [row] = await db
      .select()
      .from(conceptSessions)
      .where(eq(conceptSessions.novelId, scope.novelId))
      .orderBy(desc(conceptSessions.createdAt), desc(conceptSessions.id))
      .limit(1);
    return row ?? null;
  },
  async insertSession(db: Db, values: ConceptSessionsInsert): Promise<ConceptSession> {
    const [row] = await db.insert(conceptSessions).values(values).returning();
    return row!;
  },
  async updateSession(db: Db, scope: NovelScope, id: string, patch: SessionPatch): Promise<ConceptSession> {
    const [row] = await db
      .update(conceptSessions)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(and(eq(conceptSessions.novelId, scope.novelId), eq(conceptSessions.id, id)))
      .returning();
    return row!;
  },
  /** status CAS (UPDATE … WHERE status IN (…) RETURNING) */
  async casSession(db: Db, scope: NovelScope, id: string, from: readonly ConceptSessionStatus[], patch: SessionPatch): Promise<ConceptSession | null> {
    const [row] = await db
      .update(conceptSessions)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(and(eq(conceptSessions.novelId, scope.novelId), eq(conceptSessions.id, id), inArray(conceptSessions.status, [...from])))
      .returning();
    return row ?? null;
  },

  // ── messages ──
  async nextSeq(db: Db, scope: NovelScope, sessionId: string): Promise<number> {
    const [r] = await db
      .select({ m: max(conceptMessages.seq) })
      .from(conceptMessages)
      .where(and(eq(conceptMessages.novelId, scope.novelId), eq(conceptMessages.sessionId, sessionId)));
    return (r?.m ?? 0) + 1;
  },
  async insertMessage(db: Db, values: ConceptMessagesInsert): Promise<ConceptMessage> {
    const [row] = await db.insert(conceptMessages).values(values).returning();
    return row!;
  },
  async updateMessage(db: Db, scope: NovelScope, id: string, patch: Partial<Pick<ConceptMessage, "slotUpdates" | "outboxId" | "providerMessageRef" | "isSuperseded">>) {
    await db.update(conceptMessages).set(patch).where(and(eq(conceptMessages.novelId, scope.novelId), eq(conceptMessages.id, id)));
  },
  async getMessage(db: Db, scope: NovelScope, id: string): Promise<ConceptMessage | null> {
    const [row] = await db.select().from(conceptMessages).where(and(eq(conceptMessages.novelId, scope.novelId), eq(conceptMessages.id, id)));
    return row ?? null;
  },
  async findByInbox(db: Db, scope: NovelScope, inboxId: string): Promise<ConceptMessage | null> {
    const [row] = await db.select().from(conceptMessages).where(and(eq(conceptMessages.novelId, scope.novelId), eq(conceptMessages.inboxId, inboxId)));
    return row ?? null;
  },
  async listMessages(db: Db, scope: NovelScope, sessionId: string, opts: { afterSeq?: number; limit?: number } = {}): Promise<ConceptMessage[]> {
    return db
      .select()
      .from(conceptMessages)
      .where(
        and(
          eq(conceptMessages.novelId, scope.novelId),
          eq(conceptMessages.sessionId, sessionId),
          opts.afterSeq !== undefined ? gt(conceptMessages.seq, opts.afterSeq) : undefined,
        ),
      )
      .orderBy(asc(conceptMessages.seq))
      .limit(Math.min(opts.limit ?? 500, 1000));
  },
  async recentMessages(db: Db, scope: NovelScope, sessionId: string, n: number): Promise<ConceptMessage[]> {
    const rows = await db
      .select()
      .from(conceptMessages)
      .where(and(eq(conceptMessages.novelId, scope.novelId), eq(conceptMessages.sessionId, sessionId), eq(conceptMessages.isSuperseded, false)))
      .orderBy(desc(conceptMessages.seq))
      .limit(n);
    return rows.reverse();
  },
  async userMessagesAfter(db: Db, scope: NovelScope, sessionId: string, seq: number): Promise<ConceptMessage[]> {
    return db
      .select()
      .from(conceptMessages)
      .where(and(eq(conceptMessages.novelId, scope.novelId), eq(conceptMessages.sessionId, sessionId), eq(conceptMessages.authorKind, "user"), gt(conceptMessages.seq, seq)))
      .orderBy(asc(conceptMessages.seq));
  },
  /** latest delivered prompt (agent question / system notice with options) before `seq` */
  async latestPrompt(db: Db, scope: NovelScope, sessionId: string, beforeSeq?: number): Promise<ConceptMessage | null> {
    const [row] = await db
      .select()
      .from(conceptMessages)
      .where(
        and(
          eq(conceptMessages.novelId, scope.novelId),
          eq(conceptMessages.sessionId, sessionId),
          inArray(conceptMessages.authorKind, ["agent", "system"]),
          eq(conceptMessages.isSuperseded, false),
          or(sql`${conceptMessages.options} IS NOT NULL`, sql`${conceptMessages.askedFieldPaths} IS NOT NULL`),
          beforeSeq !== undefined ? lt(conceptMessages.seq, beforeSeq) : undefined,
        ),
      )
      .orderBy(desc(conceptMessages.seq))
      .limit(1);
    return row ?? null;
  },
  async lastAgentMessage(db: Db, scope: NovelScope, sessionId: string): Promise<ConceptMessage | null> {
    const [row] = await db
      .select()
      .from(conceptMessages)
      .where(and(eq(conceptMessages.novelId, scope.novelId), eq(conceptMessages.sessionId, sessionId), eq(conceptMessages.authorKind, "agent"), eq(conceptMessages.isSuperseded, false)))
      .orderBy(desc(conceptMessages.seq))
      .limit(1);
    return row ?? null;
  },
  async lastUserSeq(db: Db, scope: NovelScope, sessionId: string): Promise<number> {
    const [r] = await db
      .select({ m: max(conceptMessages.seq) })
      .from(conceptMessages)
      .where(and(eq(conceptMessages.novelId, scope.novelId), eq(conceptMessages.sessionId, sessionId), eq(conceptMessages.authorKind, "user")));
    return r?.m ?? 0;
  },

  // ── briefs ──
  async nextBriefVersion(db: Db, scope: NovelScope): Promise<number> {
    const [r] = await db.select({ m: max(conceptBriefs.versionNo) }).from(conceptBriefs).where(eq(conceptBriefs.novelId, scope.novelId));
    return (r?.m ?? 0) + 1;
  },
  async insertBrief(db: Db, values: ConceptBriefsInsert): Promise<ConceptBrief> {
    const [row] = await db.insert(conceptBriefs).values(values).returning();
    return row!;
  },
  async getBrief(db: Db, scope: NovelScope, id: string, forUpdate = false): Promise<ConceptBrief | null> {
    const q = db.select().from(conceptBriefs).where(and(eq(conceptBriefs.novelId, scope.novelId), eq(conceptBriefs.id, id)));
    const [row] = forUpdate ? await q.for("update") : await q;
    return row ?? null;
  },
  async listBriefs(db: Db, scope: NovelScope): Promise<ConceptBrief[]> {
    return db.select().from(conceptBriefs).where(eq(conceptBriefs.novelId, scope.novelId)).orderBy(desc(conceptBriefs.versionNo));
  },
  async briefByStatus(db: Db, scope: NovelScope, status: ConceptBriefStatus, forUpdate = false): Promise<ConceptBrief | null> {
    const q = db.select().from(conceptBriefs).where(and(eq(conceptBriefs.novelId, scope.novelId), eq(conceptBriefs.status, status))).limit(1);
    const [row] = forUpdate ? await q.for("update") : await q;
    return row ?? null;
  },
  async casBrief(db: Db, scope: NovelScope, id: string, from: readonly ConceptBriefStatus[], patch: Partial<Omit<ConceptBriefsInsert, "id" | "novelId">>): Promise<ConceptBrief | null> {
    const [row] = await db
      .update(conceptBriefs)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(and(eq(conceptBriefs.novelId, scope.novelId), eq(conceptBriefs.id, id), inArray(conceptBriefs.status, [...from])))
      .returning();
    return row ?? null;
  },

  // ── idle sweep (install level, 3.9) ──
  async idleCandidates(db: Db, before: Date): Promise<ConceptSession[]> {
    return db
      .select()
      .from(conceptSessions)
      .where(and(eq(conceptSessions.status, "active"), or(lt(conceptSessions.lastUserMessageAt, before), and(isNull(conceptSessions.lastUserMessageAt), lt(conceptSessions.createdAt, before)))))
      .limit(200);
  },
};
