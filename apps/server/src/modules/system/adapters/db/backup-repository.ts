import { desc, eq, inArray, sql } from "@ncs/db/orm";
import { backupRecords, type BackupRecordsInsert, type BackupRecordsRow } from "@ncs/db/schema";
import type { Db } from "../../../../platform/index.js";

export const backupRepo = {
  async insert(db: Db, row: BackupRecordsInsert): Promise<BackupRecordsRow> {
    const [r] = await db.insert(backupRecords).values(row).returning();
    return r!;
  },
  async get(db: Db, id: string): Promise<BackupRecordsRow | null> {
    const [r] = await db.select().from(backupRecords).where(eq(backupRecords.id, id));
    return r ?? null;
  },
  async list(db: Db, limit = 200): Promise<BackupRecordsRow[]> {
    return db.select().from(backupRecords).orderBy(desc(backupRecords.startedAt), desc(backupRecords.id)).limit(limit);
  },
  async succeed(
    db: Db,
    id: string,
    v: { finishedAt: Date; storageKey: string; sizeBytes: number; contentHash: string; lastMigrationId: string | null; details: unknown },
  ): Promise<BackupRecordsRow> {
    const [r] = await db
      .update(backupRecords)
      .set({ status: "succeeded", ...v, errorMessage: null, updatedAt: sql`now()` })
      .where(eq(backupRecords.id, id))
      .returning();
    return r!;
  },
  async fail(db: Db, id: string, v: { finishedAt: Date; errorMessage: string; details?: unknown }): Promise<BackupRecordsRow> {
    const [r] = await db
      .update(backupRecords)
      .set({ status: "failed", ...v, updatedAt: sql`now()` })
      .where(eq(backupRecords.id, id))
      .returning();
    return r!;
  },
  /** rows left `running` by a crashed process */
  async failStaleRunning(db: Db, finishedAt: Date, message: string): Promise<string[]> {
    const rows = await db
      .update(backupRecords)
      .set({ status: "failed", finishedAt, errorMessage: message, updatedAt: sql`now()` })
      .where(eq(backupRecords.status, "running"))
      .returning({ id: backupRecords.id });
    return rows.map((r) => r.id);
  },
  async deleteMany(db: Db, ids: string[]): Promise<void> {
    if (ids.length) await db.delete(backupRecords).where(inArray(backupRecords.id, ids));
  },
};
