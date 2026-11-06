/** budget tables only: budget_policies, budget_reservations, cost_events (append-only). */
import { and, desc, eq, gte, inArray, isNull, lt, sql, type SQL } from "@ncs/db/orm";
import { budgetPolicies, budgetReservations, costEvents } from "@ncs/db/schema";
import type { BudgetCategory, CostCategory } from "@ncs/shared";
import type { Db, NovelScope } from "../../../../platform/index.js";
import type { BudgetPolicy, CostEvent } from "../../index.js";
import { costCategoriesOf } from "../../domain/policy.js";

export type Reservation = typeof budgetReservations.$inferSelect;

export const budgetRepo = {
  /** 03 §7.4 step 1: per-novel advisory lock for the whole reservation decision */
  async lockNovel(db: Db, scope: NovelScope): Promise<void> {
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${"budget:" + scope.novelId}, 0))`);
  },

  async listPolicies(db: Db, scope: NovelScope, categories?: BudgetCategory[], forUpdate = false): Promise<BudgetPolicy[]> {
    const conds: SQL[] = [eq(budgetPolicies.novelId, scope.novelId)];
    if (categories) conds.push(inArray(budgetPolicies.category, categories));
    const q = db.select().from(budgetPolicies).where(and(...conds)).orderBy(budgetPolicies.category);
    return forUpdate ? q.for("update") : q;
  },
  async getPolicy(db: Db, scope: NovelScope, id: string, forUpdate = false): Promise<BudgetPolicy | null> {
    const q = db.select().from(budgetPolicies).where(and(eq(budgetPolicies.novelId, scope.novelId), eq(budgetPolicies.id, id)));
    const [p] = forUpdate ? await q.for("update") : await q;
    return p ?? null;
  },
  async getPolicyByCategory(db: Db, scope: NovelScope, category: BudgetCategory, forUpdate = false): Promise<BudgetPolicy | null> {
    const q = db.select().from(budgetPolicies).where(and(eq(budgetPolicies.novelId, scope.novelId), eq(budgetPolicies.category, category)));
    const [p] = forUpdate ? await q.for("update") : await q;
    return p ?? null;
  },
  async insertPolicy(db: Db, row: typeof budgetPolicies.$inferInsert): Promise<BudgetPolicy> {
    const [p] = await db.insert(budgetPolicies).values(row).returning();
    return p!;
  },
  async updatePolicy(db: Db, scope: NovelScope, id: string, patch: Partial<typeof budgetPolicies.$inferInsert>): Promise<BudgetPolicy> {
    const [p] = await db
      .update(budgetPolicies)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(and(eq(budgetPolicies.novelId, scope.novelId), eq(budgetPolicies.id, id)))
      .returning();
    return p!;
  },

  /** ledger sum in the window (original + correction rows) */
  async spent(db: Db, scope: NovelScope, category: BudgetCategory, since: Date): Promise<number> {
    const [r] = await db
      .select({ v: sql<string>`coalesce(sum(${costEvents.amountMicros}), 0)` })
      .from(costEvents)
      .where(and(eq(costEvents.novelId, scope.novelId), inArray(costEvents.category, costCategoriesOf(category)), gte(costEvents.occurredAt, since)));
    return Number(r?.v ?? 0);
  },
  async activeReserved(db: Db, scope: NovelScope, category: BudgetCategory): Promise<number> {
    const [r] = await db
      .select({ v: sql<string>`coalesce(sum(${budgetReservations.amountMicros}), 0)` })
      .from(budgetReservations)
      .where(
        and(
          eq(budgetReservations.novelId, scope.novelId),
          eq(budgetReservations.status, "active"),
          inArray(budgetReservations.category, costCategoriesOf(category)),
        ),
      );
    return Number(r?.v ?? 0);
  },
  async activeCount(db: Db, scope: NovelScope): Promise<number> {
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(budgetReservations)
      .where(and(eq(budgetReservations.novelId, scope.novelId), eq(budgetReservations.status, "active")));
    return r?.n ?? 0;
  },

  // reservations
  async insertReservation(db: Db, row: typeof budgetReservations.$inferInsert): Promise<Reservation> {
    const [r] = await db.insert(budgetReservations).values(row).returning();
    return r!;
  },
  async getReservation(db: Db, scope: NovelScope, id: string, forUpdate = false): Promise<Reservation | null> {
    const q = db.select().from(budgetReservations).where(and(eq(budgetReservations.novelId, scope.novelId), eq(budgetReservations.id, id)));
    const [r] = forUpdate ? await q.for("update") : await q;
    return r ?? null;
  },
  async reservationsOfRun(db: Db, scope: NovelScope, runId: string, status?: Reservation["status"]): Promise<Reservation[]> {
    const conds: SQL[] = [eq(budgetReservations.novelId, scope.novelId), eq(budgetReservations.runId, runId)];
    if (status) conds.push(eq(budgetReservations.status, status));
    return db.select().from(budgetReservations).where(and(...conds)).for("update");
  },
  /** LR-4 CAS: attach only when active and not yet attached */
  async attach(db: Db, scope: NovelScope, id: string, providerCallId: string, callMeta?: (typeof budgetReservations.$inferInsert)["callMeta"]): Promise<boolean> {
    const rows = await db
      .update(budgetReservations)
      .set({ providerCallId, ...(callMeta ? { callMeta } : {}), updatedAt: sql`now()` })
      .where(
        and(
          eq(budgetReservations.novelId, scope.novelId),
          eq(budgetReservations.id, id),
          eq(budgetReservations.status, "active"),
          sql`(${budgetReservations.providerCallId} IS NULL OR ${budgetReservations.providerCallId} = ${providerCallId})`,
        ),
      )
      .returning({ id: budgetReservations.id });
    return rows.length === 1;
  },
  /** LR-4 CAS: active → settled | released | unknown_closed */
  async close(
    db: Db,
    scope: NovelScope,
    id: string,
    to: "settled" | "released" | "unknown_closed",
    at: Date,
    settledCostEventId: string | null,
  ): Promise<Reservation | null> {
    const [r] = await db
      .update(budgetReservations)
      .set({ status: to, settledAt: at, settledCostEventId, updatedAt: sql`now()` })
      .where(and(eq(budgetReservations.novelId, scope.novelId), eq(budgetReservations.id, id), eq(budgetReservations.status, "active")))
      .returning();
    return r ?? null;
  },
  /** install-wide stale unattached reservations (02 §7.2) */
  async staleUnattached(db: Db, before: Date, limit = 200): Promise<Reservation[]> {
    return db
      .select()
      .from(budgetReservations)
      .where(and(eq(budgetReservations.status, "active"), isNull(budgetReservations.providerCallId), lt(budgetReservations.createdAt, before)))
      .limit(limit);
  },

  // ledger
  /** INSERT … ON CONFLICT DO NOTHING on (novel_id, idempotency_key): returns null when the row already exists */
  async insertCostEvent(db: Db, row: typeof costEvents.$inferInsert): Promise<CostEvent | null> {
    const [e] = await db.insert(costEvents).values(row).onConflictDoNothing().returning();
    return e ?? null;
  },
  async costEventByKey(db: Db, scope: NovelScope, key: string): Promise<CostEvent | null> {
    const [e] = await db.select().from(costEvents).where(and(eq(costEvents.novelId, scope.novelId), eq(costEvents.idempotencyKey, key)));
    return e ?? null;
  },
  async costEventByCall(db: Db, scope: NovelScope, providerCallId: string): Promise<CostEvent | null> {
    const [e] = await db.select().from(costEvents).where(and(eq(costEvents.novelId, scope.novelId), eq(costEvents.providerCallId, providerCallId)));
    return e ?? null;
  },
  async listCostEvents(db: Db, scope: NovelScope, f: { runId?: string; since?: Date; limit?: number; category?: CostCategory }): Promise<CostEvent[]> {
    const conds: SQL[] = [eq(costEvents.novelId, scope.novelId)];
    if (f.runId) conds.push(eq(costEvents.runId, f.runId));
    if (f.since) conds.push(gte(costEvents.occurredAt, f.since));
    if (f.category) conds.push(eq(costEvents.category, f.category));
    return db
      .select()
      .from(costEvents)
      .where(and(...conds))
      .orderBy(desc(costEvents.occurredAt), desc(costEvents.createdAt))
      .limit(f.limit ?? 200);
  },
  async runSummary(db: Db, scope: NovelScope, runId: string) {
    const [r] = await db
      .select({
        cost: sql<string>`coalesce(sum(${costEvents.amountMicros}), 0)`,
        inTok: sql<string>`coalesce(sum(${costEvents.inputTokens}), 0)`,
        outTok: sql<string>`coalesce(sum(${costEvents.outputTokens}), 0)`,
        n: sql<number>`count(*)::int`,
      })
      .from(costEvents)
      .where(and(eq(costEvents.novelId, scope.novelId), eq(costEvents.runId, runId)));
    return { costMicros: Number(r?.cost ?? 0), inputTokens: Number(r?.inTok ?? 0), outputTokens: Number(r?.outTok ?? 0), events: r?.n ?? 0 };
  },
};
