import { and, desc, eq, gt, inArray, isNull, like, lt, max, type SQL } from "@ncs/db/orm";
import { activityLog } from "@ncs/db/schema";
import type { Db } from "../../../../platform/index.js";
import type { ActivityEvent, ActivityFilter } from "../../index.js";
import { likePrefix } from "../../domain/activity.js";

export type ActivityInsert = typeof activityLog.$inferInsert;

export function createActivityRepository() {
  const scopeCond = (novelId: string | null) => (novelId === null ? isNull(activityLog.novelId) : eq(activityLog.novelId, novelId));
  return {
    async insert(db: Db, rows: ActivityInsert[]): Promise<ActivityEvent[]> {
      if (rows.length === 0) return [];
      return (await db.insert(activityLog).values(rows).returning()) as ActivityEvent[];
    },
    async list(db: Db, novelId: string | null, f: ActivityFilter): Promise<ActivityEvent[]> {
      const conds: SQL[] = [scopeCond(novelId)];
      if (f.actorType) conds.push(eq(activityLog.actorType, f.actorType));
      if (f.actorId) conds.push(eq(activityLog.actorId, f.actorId));
      if (f.targetType) conds.push(eq(activityLog.targetType, f.targetType));
      if (f.targetIds?.length) conds.push(inArray(activityLog.targetId, f.targetIds));
      if (f.actionPrefix) conds.push(like(activityLog.action, likePrefix(f.actionPrefix)));
      if (f.afterSeq !== undefined) conds.push(gt(activityLog.seq, f.afterSeq));
      if (f.beforeSeq !== undefined) conds.push(lt(activityLog.seq, f.beforeSeq));
      return (await db
        .select()
        .from(activityLog)
        .where(and(...conds))
        .orderBy(desc(activityLog.seq))
        .limit(f.limit ?? 50)) as ActivityEvent[];
    },
    async latestSeq(db: Db, novelId: string | null): Promise<number> {
      const [row] = await db.select({ v: max(activityLog.seq) }).from(activityLog).where(scopeCond(novelId));
      return Number(row?.v ?? 0);
    },
  };
}
