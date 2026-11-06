/** llm tables: provider_profiles, role_model_bindings, provider_calls (drizzle). Novel-owned queries always filter novel_id (T-3). */
import { and, asc, desc, eq, inArray, like, ne, sql } from "@ncs/db/orm";
import { providerCalls, providerProfiles, roleModelBindings, type ProviderCallsInsert } from "@ncs/db/schema";
import type { AgentRole, ProviderCallStatus } from "@ncs/shared";
import type { Db, NovelScope } from "../../../../platform/index.js";
import type { ProviderCall, ProviderProfile, RoleModelBinding } from "../../index.js";

export const llmRepo = {
  async getProfile(db: Db, id: string): Promise<ProviderProfile | null> {
    const [p] = await db.select().from(providerProfiles).where(eq(providerProfiles.id, id)).limit(1);
    return p ?? null;
  },

  async listProfiles(db: Db): Promise<ProviderProfile[]> {
    return db.select().from(providerProfiles).orderBy(asc(providerProfiles.provider), asc(providerProfiles.versionNo));
  },

  async updateProfile(db: Db, id: string, patch: Partial<ProviderProfile>, now: Date): Promise<ProviderProfile | null> {
    const [p] = await db
      .update(providerProfiles)
      .set({ ...patch, updatedAt: now })
      .where(eq(providerProfiles.id, id))
      .returning();
    return p ?? null;
  },

  async insertProfile(db: Db, row: ProviderProfile): Promise<ProviderProfile> {
    const [p] = await db.insert(providerProfiles).values(row).returning();
    return p!;
  },

  async maxProfileVersion(db: Db, providerKind: ProviderProfile["providerKind"], provider: string): Promise<number> {
    const [r] = await db
      .select({ v: sql<number>`coalesce(max(${providerProfiles.versionNo}), 0)::int` })
      .from(providerProfiles)
      .where(and(eq(providerProfiles.providerKind, providerKind), eq(providerProfiles.provider, provider)));
    return Number(r?.v ?? 0);
  },

  /** install-level: a new price version replaces the old profile in every novel's bindings (no novel filter by design) */
  async repointBindings(db: Db, fromProfileId: string, toProfileId: string, now: Date): Promise<number> {
    const rows = await db
      .update(roleModelBindings)
      .set({ providerProfileId: toProfileId, updatedAt: now })
      .where(eq(roleModelBindings.providerProfileId, fromProfileId))
      .returning({ id: roleModelBindings.id });
    return rows.length;
  },

  async getBinding(db: Db, scope: NovelScope, role: AgentRole, forUpdate = false): Promise<RoleModelBinding | null> {
    const q = db
      .select()
      .from(roleModelBindings)
      .where(and(eq(roleModelBindings.novelId, scope.novelId), eq(roleModelBindings.agentRole, role)))
      .limit(1);
    const [b] = forUpdate ? await q.for("update") : await q;
    return b ?? null;
  },

  async listBindings(db: Db, scope: NovelScope): Promise<RoleModelBinding[]> {
    return db.select().from(roleModelBindings).where(eq(roleModelBindings.novelId, scope.novelId)).orderBy(asc(roleModelBindings.agentRole));
  },

  async updateBinding(db: Db, scope: NovelScope, id: string, patch: Partial<RoleModelBinding>, now: Date): Promise<RoleModelBinding> {
    const [b] = await db
      .update(roleModelBindings)
      .set({ ...patch, updatedAt: now })
      .where(and(eq(roleModelBindings.novelId, scope.novelId), eq(roleModelBindings.id, id)))
      .returning();
    return b!;
  },

  async nextSeq(db: Db, scope: NovelScope, runId: string): Promise<number> {
    const [r] = await db
      .select({ max: sql<number>`coalesce(max(${providerCalls.seq}), 0)::int` })
      .from(providerCalls)
      .where(and(eq(providerCalls.novelId, scope.novelId), eq(providerCalls.runId, runId)));
    return Number(r?.max ?? 0) + 1;
  },

  async insertCall(db: Db, row: ProviderCallsInsert): Promise<ProviderCall> {
    const [c] = await db.insert(providerCalls).values(row).returning();
    return c!;
  },

  /** LR-4 CAS: UPDATE … WHERE status IN (from) RETURNING; null when 0 rows */
  async casCall(db: Db, scope: NovelScope, id: string, from: readonly ProviderCallStatus[], patch: Partial<ProviderCall>, now: Date): Promise<ProviderCall | null> {
    const [c] = await db
      .update(providerCalls)
      .set({ ...patch, updatedAt: now })
      .where(and(eq(providerCalls.novelId, scope.novelId), eq(providerCalls.id, id), inArray(providerCalls.status, [...from])))
      .returning();
    return c ?? null;
  },

  async getCall(db: Db, scope: NovelScope, id: string): Promise<ProviderCall | null> {
    const [c] = await db
      .select()
      .from(providerCalls)
      .where(and(eq(providerCalls.novelId, scope.novelId), eq(providerCalls.id, id)))
      .limit(1);
    return c ?? null;
  },

  /**
   * RU-2: a responded call with the same request hash from an EARLIER run of the same task's rerun chain
   * (runs linked by `rerun_of_run_id`, 04 RU-2). An ordinary retry (T5/T12) starts a fresh chain and
   * never replays stored responses, so `invalid_output` and content failures get a new sample.
   */
  async findReusable(db: Db, scope: NovelScope, taskId: string, requestHash: string, chainRunIds: readonly string[], excludeRunId: string): Promise<ProviderCall | null> {
    const chain = chainRunIds.filter((id) => id !== excludeRunId);
    if (chain.length === 0) return null;
    const [c] = await db
      .select()
      .from(providerCalls)
      .where(
        and(
          eq(providerCalls.novelId, scope.novelId),
          eq(providerCalls.requestHash, requestHash),
          inArray(providerCalls.status, ["responded", "responded_late"]),
          like(providerCalls.idempotencyKey, `${taskId}:%`),
          inArray(providerCalls.runId, chain),
        ),
      )
      .orderBy(desc(providerCalls.createdAt))
      .limit(1);
    return c ?? null;
  },

  async listCalls(db: Db, scope: NovelScope, runId: string): Promise<ProviderCall[]> {
    return db
      .select()
      .from(providerCalls)
      .where(and(eq(providerCalls.novelId, scope.novelId), eq(providerCalls.runId, runId)))
      .orderBy(asc(providerCalls.seq));
  },
};
