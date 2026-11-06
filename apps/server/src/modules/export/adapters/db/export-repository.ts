/** drizzle access to `export_jobs` (owned by export). */
import { and, desc, eq, sql } from "@ncs/db/orm";
import { exportJobs } from "@ncs/db/schema";
import type { Db, NovelScope } from "../../../../platform/index.js";
import type { ExportJob } from "../../index.js";

export const exportRepo = {
  async insert(db: Db, row: typeof exportJobs.$inferInsert): Promise<ExportJob> {
    const [r] = await db.insert(exportJobs).values(row).returning();
    return r!;
  },
  /** INV-EX-01: only incomplete rows are updated */
  async complete(db: Db, scope: NovelScope, id: string, patch: { storageKey: string; contentHash: string; completedAt: Date }): Promise<ExportJob> {
    const [r] = await db
      .update(exportJobs)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(and(eq(exportJobs.novelId, scope.novelId), eq(exportJobs.id, id), sql`${exportJobs.completedAt} IS NULL`))
      .returning();
    return r!;
  },
  async get(db: Db, scope: NovelScope, id: string): Promise<ExportJob | null> {
    const [r] = await db.select().from(exportJobs).where(and(eq(exportJobs.novelId, scope.novelId), eq(exportJobs.id, id)));
    return r ?? null;
  },
  async list(db: Db, scope: NovelScope, limit = 100): Promise<ExportJob[]> {
    return db.select().from(exportJobs).where(eq(exportJobs.novelId, scope.novelId)).orderBy(desc(exportJobs.createdAt)).limit(limit);
  },
};
