/** imaging tables: image_generations, image_assets (only this module touches them). */
import { and, asc, desc, eq, inArray, isNull, lt, or, sql, type SQL } from "@ncs/db/orm";
import { imageAssets, imageGenerations, type ImageAssetsInsert, type ImageGenerationsInsert } from "@ncs/db/schema";
import type { ImageGenerationStatus } from "@ncs/shared";
import type { Db } from "../../../../platform/index.js";
import type { ImageAsset, ImageGeneration } from "../../index.js";

export const imagingRepo = {
  async insertGeneration(db: Db, row: ImageGenerationsInsert): Promise<ImageGeneration> {
    const [r] = await db.insert(imageGenerations).values(row).returning();
    return r!;
  },
  async getGeneration(db: Db, id: string): Promise<ImageGeneration | null> {
    const [r] = await db.select().from(imageGenerations).where(eq(imageGenerations.id, id));
    return r ?? null;
  },
  /** CAS: only when the row is in one of `from` */
  async transition(db: Db, id: string, from: readonly ImageGenerationStatus[], patch: Partial<ImageGenerationsInsert>): Promise<ImageGeneration | null> {
    const [r] = await db
      .update(imageGenerations)
      .set(patch)
      .where(and(eq(imageGenerations.id, id), inArray(imageGenerations.status, [...from])))
      .returning();
    return r ?? null;
  },
  async list(db: Db, f: { novelId?: string; scope: "install" | "novel" | "all"; status?: ImageGenerationStatus; limit: number; before?: ImageGeneration | null }): Promise<ImageGeneration[]> {
    const conds: SQL[] = [];
    if (f.scope === "install") conds.push(isNull(imageGenerations.novelId));
    else if (f.scope === "novel" && f.novelId) conds.push(eq(imageGenerations.novelId, f.novelId));
    if (f.status) conds.push(eq(imageGenerations.status, f.status));
    if (f.before) {
      conds.push(
        or(lt(imageGenerations.createdAt, f.before.createdAt), and(eq(imageGenerations.createdAt, f.before.createdAt), lt(imageGenerations.id, f.before.id)))!,
      );
    }
    return db
      .select()
      .from(imageGenerations)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(imageGenerations.createdAt), desc(imageGenerations.id))
      .limit(f.limit);
  },
  async openIds(db: Db, status: ImageGenerationStatus): Promise<ImageGeneration[]> {
    return db.select().from(imageGenerations).where(eq(imageGenerations.status, status)).orderBy(asc(imageGenerations.createdAt));
  },
  /** in-flight estimates of a novel (they hold no budget reservation row) */
  async pendingEstimate(db: Db, novelId: string, exceptId?: string): Promise<number> {
    const conds: SQL[] = [eq(imageGenerations.novelId, novelId), inArray(imageGenerations.status, ["queued", "running"]), sql`${imageGenerations.costBasis} IS DISTINCT FROM 'plan'`];
    if (exceptId) conds.push(sql`${imageGenerations.id} <> ${exceptId}`);
    const [r] = await db
      .select({ v: sql<string>`coalesce(sum(${imageGenerations.estimatedMicros}), 0)` })
      .from(imageGenerations)
      .where(and(...conds));
    return Number(r?.v ?? 0);
  },
  async deleteGeneration(db: Db, id: string): Promise<boolean> {
    const r = await db.delete(imageGenerations).where(eq(imageGenerations.id, id)).returning({ id: imageGenerations.id });
    return r.length > 0;
  },
  async insertAssets(db: Db, rows: ImageAssetsInsert[]): Promise<ImageAsset[]> {
    if (!rows.length) return [];
    return db.insert(imageAssets).values(rows).returning();
  },
  async assetsOf(db: Db, generationIds: string[]): Promise<ImageAsset[]> {
    if (!generationIds.length) return [];
    return db.select().from(imageAssets).where(inArray(imageAssets.generationId, generationIds)).orderBy(asc(imageAssets.generationId), asc(imageAssets.ord));
  },
  async getAsset(db: Db, id: string): Promise<ImageAsset | null> {
    const [r] = await db.select().from(imageAssets).where(eq(imageAssets.id, id));
    return r ?? null;
  },
};
