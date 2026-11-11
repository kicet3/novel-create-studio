/** drizzle access to the tables owned by `manuscript` (08 §2.3). Every query filters by novel_id (03 T-3). */
import { and, asc, desc, eq, inArray, max, sql } from "@ncs/db/orm";
import { costEvents, episodeRecaps, episodeRejections, episodes, manuscriptVersions, sceneParticipants, scenes } from "@ncs/db/schema";
import type { EpisodeStatus } from "@ncs/shared";
import type { Db, NovelScope } from "../../../../platform/index.js";
import type { Episode, EpisodeFilter, EpisodeRejection, ManuscriptVersion, Scene } from "../../index.js";

type EpisodeInsert = typeof episodes.$inferInsert;
type VersionInsert = typeof manuscriptVersions.$inferInsert;
type SceneInsert = typeof scenes.$inferInsert;

export const manuscriptRepo = {
  // ── episodes ──
  async insertEpisodes(db: Db, rows: EpisodeInsert[]): Promise<Episode[]> {
    if (!rows.length) return [];
    return db.insert(episodes).values(rows).returning();
  },
  async getEpisode(db: Db, scope: NovelScope, id: string, forUpdate = false): Promise<Episode | null> {
    const q = db.select().from(episodes).where(and(eq(episodes.novelId, scope.novelId), eq(episodes.id, id)));
    const [e] = forUpdate ? await q.for("update") : await q;
    return e ?? null;
  },
  async getEpisodeByNo(db: Db, scope: NovelScope, no: number): Promise<Episode | null> {
    const [e] = await db.select().from(episodes).where(and(eq(episodes.novelId, scope.novelId), eq(episodes.episodeNo, no)));
    return e ?? null;
  },
  async listEpisodes(db: Db, scope: NovelScope, f: EpisodeFilter = {}): Promise<Episode[]> {
    const conds = [eq(episodes.novelId, scope.novelId)];
    if (f.arcId) conds.push(eq(episodes.arcId, f.arcId));
    if (f.statuses?.length) conds.push(inArray(episodes.status, f.statuses));
    if (f.fromNo !== undefined) conds.push(sql`${episodes.episodeNo} >= ${f.fromNo}`);
    if (f.toNo !== undefined) conds.push(sql`${episodes.episodeNo} <= ${f.toNo}`);
    return db.select().from(episodes).where(and(...conds)).orderBy(asc(episodes.episodeNo));
  },
  async updateEpisode(db: Db, scope: NovelScope, id: string, patch: Partial<EpisodeInsert>): Promise<Episode> {
    const [e] = await db
      .update(episodes)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(and(eq(episodes.novelId, scope.novelId), eq(episodes.id, id)))
      .returning();
    return e!;
  },
  /** status CAS (CONVENTIONS §5) */
  async casStatus(db: Db, scope: NovelScope, id: string, from: EpisodeStatus, patch: Partial<EpisodeInsert>): Promise<Episode | null> {
    const [e] = await db
      .update(episodes)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(and(eq(episodes.novelId, scope.novelId), eq(episodes.id, id), eq(episodes.status, from)))
      .returning();
    return e ?? null;
  },
  async countByStatus(db: Db, scope: NovelScope): Promise<Partial<Record<EpisodeStatus, number>>> {
    const rows = await db
      .select({ status: episodes.status, n: sql<number>`count(*)::int` })
      .from(episodes)
      .where(eq(episodes.novelId, scope.novelId))
      .groupBy(episodes.status);
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  },

  // ── versions (append-only, INV-MV-01) ──
  async nextVersionNo(db: Db, scope: NovelScope, episodeId: string): Promise<number> {
    const [r] = await db
      .select({ m: max(manuscriptVersions.versionNo) })
      .from(manuscriptVersions)
      .where(and(eq(manuscriptVersions.novelId, scope.novelId), eq(manuscriptVersions.episodeId, episodeId)));
    return Number(r?.m ?? 0) + 1;
  },
  async insertVersion(db: Db, row: VersionInsert): Promise<ManuscriptVersion> {
    const [v] = await db.insert(manuscriptVersions).values(row).returning();
    return v!;
  },
  async getVersion(db: Db, scope: NovelScope, id: string): Promise<ManuscriptVersion | null> {
    const [v] = await db.select().from(manuscriptVersions).where(and(eq(manuscriptVersions.novelId, scope.novelId), eq(manuscriptVersions.id, id)));
    return v ?? null;
  },
  async listVersions(db: Db, scope: NovelScope, episodeId: string): Promise<ManuscriptVersion[]> {
    return db
      .select()
      .from(manuscriptVersions)
      .where(and(eq(manuscriptVersions.novelId, scope.novelId), eq(manuscriptVersions.episodeId, episodeId)))
      .orderBy(desc(manuscriptVersions.versionNo));
  },

  // ── rejections ──
  async nextRejectionNo(db: Db, scope: NovelScope, episodeId: string): Promise<number> {
    const [r] = await db
      .select({ m: max(episodeRejections.rejectionNo) })
      .from(episodeRejections)
      .where(and(eq(episodeRejections.novelId, scope.novelId), eq(episodeRejections.episodeId, episodeId)));
    return Number(r?.m ?? 0) + 1;
  },
  async insertRejection(db: Db, row: typeof episodeRejections.$inferInsert): Promise<EpisodeRejection> {
    const [r] = await db.insert(episodeRejections).values(row).returning();
    return r!;
  },
  async getRejection(db: Db, scope: NovelScope, id: string): Promise<EpisodeRejection | null> {
    const [r] = await db.select().from(episodeRejections).where(and(eq(episodeRejections.novelId, scope.novelId), eq(episodeRejections.id, id)));
    return r ?? null;
  },
  async listRejections(db: Db, scope: NovelScope, episodeId: string): Promise<EpisodeRejection[]> {
    return db
      .select()
      .from(episodeRejections)
      .where(and(eq(episodeRejections.novelId, scope.novelId), eq(episodeRejections.episodeId, episodeId)))
      .orderBy(asc(episodeRejections.rejectionNo));
  },

  // ── scenes ──
  async listScenes(db: Db, scope: NovelScope, episodeId: string, opts: { versionId?: string; includeRetired?: boolean } = {}): Promise<Scene[]> {
    const conds = [eq(scenes.novelId, scope.novelId), eq(scenes.episodeId, episodeId)];
    if (!opts.includeRetired) conds.push(eq(scenes.status, "active"));
    if (opts.versionId) conds.push(eq(scenes.manuscriptVersionId, opts.versionId));
    return db.select().from(scenes).where(and(...conds)).orderBy(asc(scenes.status), asc(scenes.ord));
  },
  async lockActiveScenes(db: Db, scope: NovelScope, episodeId: string): Promise<Scene[]> {
    return db
      .select()
      .from(scenes)
      .where(and(eq(scenes.novelId, scope.novelId), eq(scenes.episodeId, episodeId), eq(scenes.status, "active")))
      .orderBy(asc(scenes.ord))
      .for("update");
  },
  async retireScenes(db: Db, scope: NovelScope, ids: string[]): Promise<void> {
    if (!ids.length) return;
    await db
      .update(scenes)
      .set({ status: "retired", updatedAt: sql`now()` })
      .where(and(eq(scenes.novelId, scope.novelId), inArray(scenes.id, ids)));
  },
  async updateScene(db: Db, scope: NovelScope, id: string, patch: Partial<SceneInsert>): Promise<Scene> {
    const [s] = await db
      .update(scenes)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(and(eq(scenes.novelId, scope.novelId), eq(scenes.id, id)))
      .returning();
    return s!;
  },
  async insertScenes(db: Db, rows: SceneInsert[]): Promise<Scene[]> {
    if (!rows.length) return [];
    return db.insert(scenes).values(rows).returning();
  },

  // ── 설계 추가(화 삭제): hard deletes of the episode's generated rows (FK order: participants → scenes → versions) ──
  async countRecaps(db: Db, scope: NovelScope, episodeId: string): Promise<number> {
    const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(episodeRecaps).where(and(eq(episodeRecaps.novelId, scope.novelId), eq(episodeRecaps.episodeId, episodeId)));
    return Number(r?.n ?? 0);
  },
  async deleteRecaps(db: Db, scope: NovelScope, episodeId: string): Promise<number> {
    const rows = await db.delete(episodeRecaps).where(and(eq(episodeRecaps.novelId, scope.novelId), eq(episodeRecaps.episodeId, episodeId))).returning({ id: episodeRecaps.id });
    return rows.length;
  },
  async deleteRejections(db: Db, scope: NovelScope, episodeId: string): Promise<number> {
    const rows = await db.delete(episodeRejections).where(and(eq(episodeRejections.novelId, scope.novelId), eq(episodeRejections.episodeId, episodeId))).returning({ id: episodeRejections.id });
    return rows.length;
  },
  async deleteScenes(db: Db, scope: NovelScope, sceneIds: string[]): Promise<number> {
    if (!sceneIds.length) return 0;
    await db.delete(sceneParticipants).where(and(eq(sceneParticipants.novelId, scope.novelId), inArray(sceneParticipants.sceneId, sceneIds)));
    // cost_events rows stay (budget history); only their scene anchor is cleared so the scene rows can go
    await db.update(costEvents).set({ sceneId: null }).where(and(eq(costEvents.novelId, scope.novelId), inArray(costEvents.sceneId, sceneIds)));
    const rows = await db.delete(scenes).where(and(eq(scenes.novelId, scope.novelId), inArray(scenes.id, sceneIds))).returning({ id: scenes.id });
    return rows.length;
  },
  /** every version of the episode (the episode's version pointers must already be NULL) */
  async deleteVersions(db: Db, scope: NovelScope, episodeId: string): Promise<number> {
    const rows = await db.delete(manuscriptVersions).where(and(eq(manuscriptVersions.novelId, scope.novelId), eq(manuscriptVersions.episodeId, episodeId))).returning({ id: manuscriptVersions.id });
    return rows.length;
  },
};
