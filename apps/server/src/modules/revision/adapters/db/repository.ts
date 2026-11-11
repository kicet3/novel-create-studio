/** Drizzle repository of the revision chat tables (always scoped by novel_id, T-3). */
import { and, asc, eq, inArray, max, sql } from "@ncs/db/orm";
import { episodeAuthorNotes, revisionChatMessages, revisionChatProposals, revisionChatSessions } from "@ncs/db/schema";
import type {
  EpisodeAuthorNotesInsert,
  EpisodeAuthorNotesRow,
  RevisionChatMessagesInsert,
  RevisionChatMessagesRow,
  RevisionChatProposalsInsert,
  RevisionChatProposalsRow,
  RevisionChatSessionsInsert,
  RevisionChatSessionsRow,
} from "@ncs/db/schema";
import type { RevisionProposalStatus } from "@ncs/shared";
import type { Db, NovelScope } from "../../../../platform/index.js";

type SessionPatch = Partial<Omit<RevisionChatSessionsInsert, "id" | "novelId" | "episodeId">>;
type ProposalPatch = Partial<Omit<RevisionChatProposalsInsert, "id" | "novelId" | "sessionId" | "messageId">>;

export const revisionRepo = {
  async sessionByEpisode(db: Db, scope: NovelScope, episodeId: string, forUpdate = false): Promise<RevisionChatSessionsRow | null> {
    const q = db.select().from(revisionChatSessions).where(and(eq(revisionChatSessions.novelId, scope.novelId), eq(revisionChatSessions.episodeId, episodeId)));
    const [row] = forUpdate ? await q.for("update") : await q;
    return row ?? null;
  },
  async getSession(db: Db, scope: NovelScope, id: string, forUpdate = false): Promise<RevisionChatSessionsRow | null> {
    const q = db.select().from(revisionChatSessions).where(and(eq(revisionChatSessions.novelId, scope.novelId), eq(revisionChatSessions.id, id)));
    const [row] = forUpdate ? await q.for("update") : await q;
    return row ?? null;
  },
  async insertSession(db: Db, values: RevisionChatSessionsInsert): Promise<RevisionChatSessionsRow> {
    const [row] = await db.insert(revisionChatSessions).values(values).onConflictDoNothing().returning();
    return row!;
  },
  async updateSession(db: Db, scope: NovelScope, id: string, patch: SessionPatch): Promise<RevisionChatSessionsRow> {
    const [row] = await db
      .update(revisionChatSessions)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(and(eq(revisionChatSessions.novelId, scope.novelId), eq(revisionChatSessions.id, id)))
      .returning();
    return row!;
  },

  async nextSeq(db: Db, scope: NovelScope, sessionId: string): Promise<number> {
    const [r] = await db
      .select({ m: max(revisionChatMessages.seq) })
      .from(revisionChatMessages)
      .where(and(eq(revisionChatMessages.novelId, scope.novelId), eq(revisionChatMessages.sessionId, sessionId)));
    return (r?.m ?? 0) + 1;
  },
  async insertMessage(db: Db, values: RevisionChatMessagesInsert): Promise<RevisionChatMessagesRow> {
    const [row] = await db.insert(revisionChatMessages).values(values).returning();
    return row!;
  },
  async listMessages(db: Db, scope: NovelScope, sessionId: string): Promise<RevisionChatMessagesRow[]> {
    return db
      .select()
      .from(revisionChatMessages)
      .where(and(eq(revisionChatMessages.novelId, scope.novelId), eq(revisionChatMessages.sessionId, sessionId)))
      .orderBy(asc(revisionChatMessages.seq))
      .limit(1000);
  },

  async insertProposal(db: Db, values: RevisionChatProposalsInsert): Promise<RevisionChatProposalsRow> {
    const [row] = await db.insert(revisionChatProposals).values(values).returning();
    return row!;
  },
  async getProposal(db: Db, scope: NovelScope, id: string, forUpdate = false): Promise<RevisionChatProposalsRow | null> {
    const q = db.select().from(revisionChatProposals).where(and(eq(revisionChatProposals.novelId, scope.novelId), eq(revisionChatProposals.id, id)));
    const [row] = forUpdate ? await q.for("update") : await q;
    return row ?? null;
  },
  async proposalByApproval(db: Db, scope: NovelScope, approvalId: string): Promise<RevisionChatProposalsRow | null> {
    const [row] = await db.select().from(revisionChatProposals).where(and(eq(revisionChatProposals.novelId, scope.novelId), eq(revisionChatProposals.approvalId, approvalId)));
    return row ?? null;
  },
  async listProposals(db: Db, scope: NovelScope, sessionId: string, statuses?: RevisionProposalStatus[]): Promise<RevisionChatProposalsRow[]> {
    return db
      .select()
      .from(revisionChatProposals)
      .where(
        and(
          eq(revisionChatProposals.novelId, scope.novelId),
          eq(revisionChatProposals.sessionId, sessionId),
          statuses?.length ? inArray(revisionChatProposals.status, statuses) : undefined,
        ),
      )
      .orderBy(asc(revisionChatProposals.createdAt), asc(revisionChatProposals.id));
  },
  async updateProposal(db: Db, scope: NovelScope, id: string, patch: ProposalPatch): Promise<RevisionChatProposalsRow> {
    const [row] = await db
      .update(revisionChatProposals)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(and(eq(revisionChatProposals.novelId, scope.novelId), eq(revisionChatProposals.id, id)))
      .returning();
    return row!;
  },

  async insertNote(db: Db, values: EpisodeAuthorNotesInsert): Promise<EpisodeAuthorNotesRow> {
    const [row] = await db.insert(episodeAuthorNotes).values(values).returning();
    return row!;
  },
  /** 설계 추가(화 삭제): the episode's chat (messages / proposals cascade) and author notes are removed with the text */
  async deleteEpisodeData(db: Db, scope: NovelScope, episodeId: string): Promise<{ sessions: number; notes: number }> {
    const notes = await db.delete(episodeAuthorNotes).where(and(eq(episodeAuthorNotes.novelId, scope.novelId), eq(episodeAuthorNotes.episodeId, episodeId))).returning({ id: episodeAuthorNotes.id });
    const sessions = await db.delete(revisionChatSessions).where(and(eq(revisionChatSessions.novelId, scope.novelId), eq(revisionChatSessions.episodeId, episodeId))).returning({ id: revisionChatSessions.id });
    return { sessions: sessions.length, notes: notes.length };
  },
  async activeNotes(db: Db, scope: NovelScope, episodeIds?: string[]): Promise<EpisodeAuthorNotesRow[]> {
    if (episodeIds && !episodeIds.length) return [];
    return db
      .select()
      .from(episodeAuthorNotes)
      .where(
        and(
          eq(episodeAuthorNotes.novelId, scope.novelId),
          eq(episodeAuthorNotes.status, "active"),
          episodeIds ? inArray(episodeAuthorNotes.episodeId, episodeIds) : undefined,
        ),
      )
      .orderBy(asc(episodeAuthorNotes.createdAt));
  },
};
