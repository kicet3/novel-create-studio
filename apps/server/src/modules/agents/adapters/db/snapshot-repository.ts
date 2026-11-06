/** context_snapshots (agents). Insert-only rows (03 §3.3); one per run, clones for RU-3. */
import { and, desc, eq, inArray } from "@ncs/db/orm";
import { contextSnapshots, type ContextSnapshotsInsert } from "@ncs/db/schema";
import type { Db, NovelScope } from "../../../../platform/index.js";
import type { ContextSnapshot } from "../../index.js";

export const snapshotRepo = {
  async insert(db: Db, row: ContextSnapshotsInsert): Promise<ContextSnapshot> {
    const [r] = await db.insert(contextSnapshots).values(row).returning();
    return r!;
  },
  async get(db: Db, scope: NovelScope, id: string): Promise<ContextSnapshot | null> {
    const [r] = await db
      .select()
      .from(contextSnapshots)
      .where(and(eq(contextSnapshots.novelId, scope.novelId), eq(contextSnapshots.id, id)))
      .limit(1);
    return r ?? null;
  },
  async latestForRuns(db: Db, scope: NovelScope, runIds: string[]): Promise<ContextSnapshot[]> {
    if (!runIds.length) return [];
    return db
      .select()
      .from(contextSnapshots)
      .where(and(eq(contextSnapshots.novelId, scope.novelId), inArray(contextSnapshots.runId, runIds)))
      .orderBy(desc(contextSnapshots.createdAt));
  },
};
