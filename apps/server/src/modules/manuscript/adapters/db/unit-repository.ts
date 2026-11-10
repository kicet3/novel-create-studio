/** 설계 추가 0023: episode_units (에피소드 묶음) — owned by manuscript. Every query filters by novel_id (T-3). */
import { and, asc, eq, inArray, notInArray, sql } from "@ncs/db/orm";
import { episodeUnits, type EpisodeUnitsInsert, type EpisodeUnitsRow } from "@ncs/db/schema";
import type { Db, NovelScope } from "../../../../platform/index.js";

export type EpisodeUnitRow = EpisodeUnitsRow;

export const unitRepo = {
  async insert(db: Db, rows: EpisodeUnitsInsert[]): Promise<EpisodeUnitRow[]> {
    if (!rows.length) return [];
    return db.insert(episodeUnits).values(rows).returning();
  },
  async list(db: Db, scope: NovelScope, f: { arcId?: string; ids?: string[]; includeRetired?: boolean } = {}): Promise<EpisodeUnitRow[]> {
    const conds = [eq(episodeUnits.novelId, scope.novelId)];
    if (f.arcId) conds.push(eq(episodeUnits.arcId, f.arcId));
    if (f.ids) {
      if (!f.ids.length) return [];
      conds.push(inArray(episodeUnits.id, f.ids));
    } else if (!f.includeRetired) conds.push(eq(episodeUnits.status, "active"));
    return db.select().from(episodeUnits).where(and(...conds)).orderBy(asc(episodeUnits.arcId), asc(episodeUnits.ord));
  },
  /** retire the active units of a plot (a new grouping replaces them; rows stay for history) except `keepIds` (still used) */
  async retireArc(db: Db, scope: NovelScope, arcId: string, keepIds: readonly string[] = []): Promise<void> {
    const conds = [eq(episodeUnits.novelId, scope.novelId), eq(episodeUnits.arcId, arcId), eq(episodeUnits.status, "active")];
    if (keepIds.length) conds.push(notInArray(episodeUnits.id, [...keepIds]));
    await db.update(episodeUnits).set({ status: "retired", updatedAt: sql`now()` }).where(and(...conds));
  },
  /** a unit's 화 count after some of its 화 moved to a new grouping */
  async setCount(db: Db, scope: NovelScope, id: string, plannedEpisodeCount: number): Promise<void> {
    await db
      .update(episodeUnits)
      .set({ plannedEpisodeCount: Math.max(1, plannedEpisodeCount), updatedAt: sql`now()` })
      .where(and(eq(episodeUnits.novelId, scope.novelId), eq(episodeUnits.id, id)));
  },
};
