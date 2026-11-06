import { and, desc, eq, isNull, or, sql } from "@ncs/db/orm";
import { healthCheckResults } from "@ncs/db/schema";
import type { Db } from "../../../../platform/index.js";
import type { HealthCheckResult } from "../../index.js";

type Insert = typeof healthCheckResults.$inferInsert;

const withName = (r: typeof healthCheckResults.$inferSelect): HealthCheckResult => ({
  ...r,
  name: String((r.details as { name?: unknown } | null)?.name ?? r.kind),
});

export const healthRepo = {
  async insert(db: Db, row: Insert): Promise<HealthCheckResult> {
    const [r] = await db.insert(healthCheckResults).values(row).returning();
    return withName(r!);
  },
  /** latest row per (novel_id, details.name) */
  async latest(db: Db, novelId?: string): Promise<HealthCheckResult[]> {
    const scope = novelId ? or(isNull(healthCheckResults.novelId), eq(healthCheckResults.novelId, novelId)) : isNull(healthCheckResults.novelId);
    const rows = await db
      .selectDistinctOn([healthCheckResults.novelId, sql`(${healthCheckResults.details} ->> 'name')`])
      .from(healthCheckResults)
      .where(scope)
      .orderBy(healthCheckResults.novelId, sql`(${healthCheckResults.details} ->> 'name')`, desc(healthCheckResults.checkedAt));
    return rows.map(withName);
  },
  async previousStatus(db: Db, name: string, novelId: string | null): Promise<string | null> {
    const [r] = await db
      .select({ status: healthCheckResults.status })
      .from(healthCheckResults)
      .where(and(novelId ? eq(healthCheckResults.novelId, novelId) : isNull(healthCheckResults.novelId), sql`${healthCheckResults.details} ->> 'name' = ${name}`))
      .orderBy(desc(healthCheckResults.checkedAt))
      .limit(1);
    return r?.status ?? null;
  },
};
