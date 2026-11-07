/** 설계 추가 0019: episode_recaps (layer canon) — the per-version handoff + summary written by summarize_episode. */
import { and, desc, eq, inArray, isNull, notInArray, sql } from "@ncs/db/orm";
import { episodeRecaps, episodes } from "@ncs/db/schema";
import type { Db, NovelScope } from "../../../../platform/index.js";

export type EpisodeRecapRow = typeof episodeRecaps.$inferSelect;

export const recapRepo = {
  /** canon recaps of one episode, newest first */
  async listForEpisode(db: Db, scope: NovelScope, episodeId: string): Promise<EpisodeRecapRow[]> {
    return db
      .select()
      .from(episodeRecaps)
      .where(and(eq(episodeRecaps.novelId, scope.novelId), eq(episodeRecaps.episodeId, episodeId), eq(episodeRecaps.layer, "canon")))
      .orderBy(desc(episodeRecaps.createdAt), desc(episodeRecaps.id));
  },
  /** canon recaps of the episodes numbered below `beforeNo` (newest first per episode) with their episode number */
  async listBefore(db: Db, scope: NovelScope, beforeNo: number): Promise<Array<EpisodeRecapRow & { episodeNo: number; currentVersionId: string | null; approvedVersionId: string | null }>> {
    const rows = await db
      .select({ r: episodeRecaps, episodeNo: episodes.episodeNo, currentVersionId: episodes.currentVersionId, approvedVersionId: episodes.approvedVersionId })
      .from(episodeRecaps)
      .innerJoin(episodes, and(eq(episodes.novelId, episodeRecaps.novelId), eq(episodes.id, episodeRecaps.episodeId)))
      .where(and(eq(episodeRecaps.novelId, scope.novelId), eq(episodeRecaps.layer, "canon"), sql`${episodes.episodeNo} < ${beforeNo}`))
      .orderBy(episodes.episodeNo, desc(episodeRecaps.createdAt), desc(episodeRecaps.id));
    return rows.map((x) => ({ ...x.r, episodeNo: x.episodeNo, currentVersionId: x.currentVersionId, approvedVersionId: x.approvedVersionId }));
  },
  async getForVersion(db: Db, scope: NovelScope, episodeId: string, versionId: string): Promise<EpisodeRecapRow | null> {
    const [r] = await db
      .select()
      .from(episodeRecaps)
      .where(and(eq(episodeRecaps.novelId, scope.novelId), eq(episodeRecaps.episodeId, episodeId), eq(episodeRecaps.sourceVersionId, versionId), eq(episodeRecaps.layer, "canon"), isNull(episodeRecaps.povEntityId)));
    return r ?? null;
  },
  async episodeIdsWithRecap(db: Db, scope: NovelScope, versionIds: string[]): Promise<Set<string>> {
    if (!versionIds.length) return new Set();
    const rows = await db
      .select({ v: episodeRecaps.sourceVersionId })
      .from(episodeRecaps)
      .where(and(eq(episodeRecaps.novelId, scope.novelId), eq(episodeRecaps.layer, "canon"), inArray(episodeRecaps.sourceVersionId, versionIds)));
    return new Set(rows.map((r) => r.v));
  },
  /** insert, or refresh the recap of the same source version (unique per version) */
  async upsert(db: Db, row: typeof episodeRecaps.$inferInsert): Promise<EpisodeRecapRow> {
    const existing = await recapRepo.getForVersion(db, { novelId: row.novelId }, row.episodeId, row.sourceVersionId);
    if (existing) {
      const [u] = await db
        .update(episodeRecaps)
        .set({ summary: row.summary, handoff: row.handoff, createdByRunId: row.createdByRunId ?? null, staleAt: null })
        .where(and(eq(episodeRecaps.novelId, row.novelId), eq(episodeRecaps.id, existing.id)))
        .returning();
      return u!;
    }
    const [r] = await db.insert(episodeRecaps).values(row).returning();
    return r!;
  },
  /** recaps of other versions than `freshVersionIds` get stale_at (the episode text changed after them) */
  async markStale(db: Db, scope: NovelScope, episodeId: string, freshVersionIds: string[], at: Date): Promise<number> {
    const conds = [eq(episodeRecaps.novelId, scope.novelId), eq(episodeRecaps.episodeId, episodeId), isNull(episodeRecaps.staleAt)];
    if (freshVersionIds.length) conds.push(notInArray(episodeRecaps.sourceVersionId, freshVersionIds));
    const r = await db.update(episodeRecaps).set({ staleAt: at }).where(and(...conds)).returning({ id: episodeRecaps.id });
    return r.length;
  },
};
