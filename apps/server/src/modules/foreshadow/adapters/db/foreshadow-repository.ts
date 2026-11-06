/** drizzle access to the tables owned by `foreshadow` (setups, setup_beats, setup_due_changes, setup_links). Every query filters by novel_id (03 T-3). */
import { and, asc, eq, inArray, sql } from "@ncs/db/orm";
import { setupBeats, setupDueChanges, setupLinks, setups } from "@ncs/db/schema";
import type { Db, NovelScope } from "../../../../platform/index.js";
import type { Setup, SetupBeat, SetupDueChange } from "../../index.js";

type SetupInsert = typeof setups.$inferInsert;
type BeatInsert = typeof setupBeats.$inferInsert;
type DueChangeInsert = typeof setupDueChanges.$inferInsert;
export type SetupLinkRow = typeof setupLinks.$inferSelect;

export const foreshadowRepo = {
  async insertSetup(db: Db, row: SetupInsert): Promise<Setup> {
    const [s] = await db.insert(setups).values(row).returning();
    return s!;
  },
  async getSetup(db: Db, scope: NovelScope, id: string, forUpdate = false): Promise<Setup | null> {
    const q = db.select().from(setups).where(and(eq(setups.novelId, scope.novelId), eq(setups.id, id)));
    const [s] = forUpdate ? await q.for("update") : await q;
    return s ?? null;
  },
  async getSetupByNo(db: Db, scope: NovelScope, displayNo: number): Promise<Setup | null> {
    const [s] = await db.select().from(setups).where(and(eq(setups.novelId, scope.novelId), eq(setups.displayNo, displayNo)));
    return s ?? null;
  },
  async listSetups(db: Db, scope: NovelScope, opts: { ids?: string[]; plannedArcId?: string } = {}): Promise<Setup[]> {
    const conds = [eq(setups.novelId, scope.novelId)];
    if (opts.ids) {
      if (!opts.ids.length) return [];
      conds.push(inArray(setups.id, opts.ids));
    }
    if (opts.plannedArcId) conds.push(eq(setups.plannedArcId, opts.plannedArcId));
    return db.select().from(setups).where(and(...conds)).orderBy(asc(setups.displayNo));
  },
  async updateSetup(db: Db, scope: NovelScope, id: string, patch: Partial<SetupInsert>): Promise<Setup> {
    const [s] = await db
      .update(setups)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(and(eq(setups.novelId, scope.novelId), eq(setups.id, id)))
      .returning();
    return s!;
  },

  // beats
  async insertBeats(db: Db, rows: BeatInsert[]): Promise<SetupBeat[]> {
    if (!rows.length) return [];
    return db.insert(setupBeats).values(rows).returning();
  },
  async getBeat(db: Db, scope: NovelScope, id: string, forUpdate = false): Promise<SetupBeat | null> {
    const q = db.select().from(setupBeats).where(and(eq(setupBeats.novelId, scope.novelId), eq(setupBeats.id, id)));
    const [b] = forUpdate ? await q.for("update") : await q;
    return b ?? null;
  },
  async listBeats(db: Db, scope: NovelScope, opts: { setupIds?: string[]; plannedEpisodeNo?: number; episodeId?: string } = {}): Promise<SetupBeat[]> {
    const conds = [eq(setupBeats.novelId, scope.novelId)];
    if (opts.setupIds) {
      if (!opts.setupIds.length) return [];
      conds.push(inArray(setupBeats.setupId, opts.setupIds));
    }
    if (opts.plannedEpisodeNo != null) conds.push(eq(setupBeats.plannedEpisodeNo, opts.plannedEpisodeNo));
    if (opts.episodeId) conds.push(eq(setupBeats.episodeId, opts.episodeId));
    return db.select().from(setupBeats).where(and(...conds)).orderBy(asc(setupBeats.plannedEpisodeNo), asc(setupBeats.createdAt), asc(setupBeats.id));
  },
  async updateBeat(db: Db, scope: NovelScope, id: string, patch: Partial<BeatInsert>): Promise<SetupBeat> {
    const [b] = await db
      .update(setupBeats)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(and(eq(setupBeats.novelId, scope.novelId), eq(setupBeats.id, id)))
      .returning();
    return b!;
  },

  // due changes
  async insertDueChange(db: Db, row: DueChangeInsert): Promise<SetupDueChange> {
    const [c] = await db.insert(setupDueChanges).values(row).returning();
    return c!;
  },
  async listDueChanges(db: Db, scope: NovelScope, setupIds?: string[]): Promise<SetupDueChange[]> {
    const conds = [eq(setupDueChanges.novelId, scope.novelId)];
    if (setupIds) {
      if (!setupIds.length) return [];
      conds.push(inArray(setupDueChanges.setupId, setupIds));
    }
    return db.select().from(setupDueChanges).where(and(...conds)).orderBy(asc(setupDueChanges.createdAt), asc(setupDueChanges.id));
  },

  // links (FR-ONT-12: ids only)
  async insertLinks(db: Db, scope: NovelScope, setupId: string, links: Array<{ refType: "entity" | "fact"; refId: string }>): Promise<void> {
    if (!links.length) return;
    await db
      .insert(setupLinks)
      .values(links.map((l) => ({ novelId: scope.novelId, setupId, refType: l.refType, refId: l.refId })))
      .onConflictDoNothing();
  },
  async listLinks(db: Db, scope: NovelScope, setupIds?: string[]): Promise<SetupLinkRow[]> {
    const conds = [eq(setupLinks.novelId, scope.novelId)];
    if (setupIds) {
      if (!setupIds.length) return [];
      conds.push(inArray(setupLinks.setupId, setupIds));
    }
    return db.select().from(setupLinks).where(and(...conds)).orderBy(asc(setupLinks.id));
  },
  async pinFactVersion(db: Db, scope: NovelScope, linkId: number, factVersionId: string): Promise<void> {
    await db
      .update(setupLinks)
      .set({ pinnedFactVersionId: factVersionId })
      .where(and(eq(setupLinks.novelId, scope.novelId), eq(setupLinks.id, linkId)));
  },
};
