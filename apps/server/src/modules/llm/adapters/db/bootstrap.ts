/**
 * Bootstrap: default ProviderProfile for InstallConfig `llm.provider` + per-role RoleModelBindings (N1).
 * Prices come from domain/pricing.ts (provider list prices). An existing profile whose
 * models still carry null prices (contracts-phase rows) is filled in place.
 */
import { and, asc, eq, inArray, ne } from "@ncs/db/orm";
import { providerProfiles, roleModelBindings } from "@ncs/db/schema";
import { AGENT_ROLE, DEFAULT_MODELS, DEFAULTS, type AgentRole } from "@ncs/shared";
import type { Db, NovelScope, Platform, Tx } from "../../../../platform/index.js";
import type { ProviderProfile, RoleModelBinding } from "../../index.js";
import { PROVIDER_PRICE_SOURCE, PROVIDER_ROLE_DEFAULTS, defaultProfileModels, isPriced, parseProfileModels } from "../../domain/pricing.js";

/** Every role defaults to Claude Opus 5.5; the user can switch a role to Sonnet/Haiku in 설정 → 역할별 모델. */
export const DEFAULT_ROLE_MODELS: Record<AgentRole, string> = Object.fromEntries(AGENT_ROLE.map((r) => [r, DEFAULT_MODELS.opus])) as Record<AgentRole, string>;

export function defaultMaxOutputTokens(role: AgentRole): number {
  if (role === "writer") return DEFAULTS["llm.max_output_tokens.writer"];
  if (role === "concept_partner") return DEFAULTS["llm.max_output_tokens.concept_partner"];
  return DEFAULTS["llm.max_output_tokens.default"];
}

export async function findDefaultProfile(db: Db, provider: string): Promise<ProviderProfile | null> {
  const [p] = await db
    .select()
    .from(providerProfiles)
    .where(and(eq(providerProfiles.provider, provider), eq(providerProfiles.providerKind, "llm"), eq(providerProfiles.isActive, true)))
    .orderBy(asc(providerProfiles.createdAt))
    .limit(1);
  return p ?? null;
}

export async function ensureDefaultProviderProfile(platform: Platform): Promise<ProviderProfile> {
  return ensureProviderProfile(platform, platform.config.llm.provider);
}

/** active profile for `provider` (created with the default priced models when missing; null prices filled in place) */
export async function ensureProviderProfile(platform: Platform, provider: string): Promise<ProviderProfile> {
  const existing = await findDefaultProfile(platform.uow.db, provider);
  if (existing) {
    const models = parseProfileModels(existing.models);
    const defaults = new Map(defaultProfileModels(provider).map((m) => [m.id, m]));
    if (models.length && models.some((m) => !isPriced(m) && isPriced(defaults.get(m.id)))) {
      const filled = models.map((m) => (isPriced(m) ? m : { ...(defaults.get(m.id) ?? m), ...Object.fromEntries(Object.entries(m).filter(([, v]) => v !== null)) }));
      const [u] = await platform.uow.db
        .update(providerProfiles)
        .set({ models: filled, verifiedAt: platform.clock.date(), updatedAt: platform.clock.date() })
        .where(eq(providerProfiles.id, existing.id))
        .returning();
      return u!;
    }
    return existing;
  }
  const [p] = await platform.uow.db
    .insert(providerProfiles)
    .values({
      id: platform.ids.next("prv"),
      providerKind: "llm",
      provider,
      versionNo: 1,
      models: defaultProfileModels(provider),
      priceSourceUrl: PROVIDER_PRICE_SOURCE[provider] ?? "about:unknown",
      verifiedAt: platform.clock.date(),
    })
    .returning();
  return p!;
}

export async function insertDefaultBindings(platform: Platform, tx: Tx, scope: NovelScope): Promise<RoleModelBinding[]> {
  const profile = await findDefaultProfile(tx.db, platform.config.llm.provider);
  if (!profile) throw new Error("default provider profile missing (llm.ensureDefaultProviderProfile not run)");
  return tx.db
    .insert(roleModelBindings)
    .values(
      AGENT_ROLE.map((role) => ({
        id: platform.ids.next("rmb"),
        novelId: scope.novelId,
        agentRole: role,
        providerProfileId: profile.id,
        modelId: defaultRoleModel(profile.provider, role),
        maxOutputTokens: defaultMaxOutputTokens(role),
      })),
    )
    .returning();
}

/** default model of `role` on `provider` (premium tier for planning roles, standard for the rest) */
export function defaultRoleModel(provider: string, role: AgentRole): string {
  const d = PROVIDER_ROLE_DEFAULTS[provider];
  if (!d) return DEFAULT_ROLE_MODELS[role] ?? DEFAULT_MODELS.opus;
  return PREMIUM_ROLES.has(role) ? d.premium : d.standard;
}
const PREMIUM_ROLES = new Set<AgentRole>(["showrunner", "planner", "writer"] as AgentRole[]);

/**
 * Bindings that point at a profile of a provider this server cannot call (e.g. a profile of a provider this version
 * no longer ships) are moved to the default profile of the configured provider, with that role's
 * default model; those profiles are deactivated. Profiles of other usable providers are left alone (a novel may bind
 * roles to any connected provider). Idempotent; returns moved count.
 */
export async function rebindToConfiguredProvider(platform: Platform, usable: (provider: string) => boolean = (p) => p === platform.config.llm.provider): Promise<number> {
  const provider = platform.config.llm.provider;
  return platform.uow.run(async (tx) => {
    const target = await findDefaultProfile(tx.db, provider);
    if (!target) return 0;
    const all = await tx.db
      .select({ id: providerProfiles.id, provider: providerProfiles.provider, isActive: providerProfiles.isActive })
      .from(providerProfiles)
      .where(and(eq(providerProfiles.providerKind, "llm"), ne(providerProfiles.provider, provider)));
    const foreign = all.filter((f) => !usable(f.provider));
    if (!foreign.length) return 0;
    const ids = foreign.map((f) => f.id);
    const stale = await tx.db.select().from(roleModelBindings).where(inArray(roleModelBindings.providerProfileId, ids));
    const now = platform.clock.date();
    for (const b of stale) {
      await tx.db
        .update(roleModelBindings)
        .set({ providerProfileId: target.id, modelId: defaultRoleModel(provider, b.agentRole as AgentRole), fallbackModelId: null, fallbackEnabled: false, updatedAt: now })
        .where(eq(roleModelBindings.id, b.id));
    }
    const active = foreign.filter((f) => f.isActive).map((f) => f.id);
    if (active.length) await tx.db.update(providerProfiles).set({ isActive: false, updatedAt: now }).where(inArray(providerProfiles.id, active));
    return stale.length;
  });
}

/**
 * Active `provider_kind='image'` profile of `provider` (module imaging owns the catalog, llm owns the table).
 * Created from `models` when missing; models missing from an existing profile are appended (prices of models
 * already stored are kept — the user may have edited them).
 */
export async function ensureImageProviderProfile(platform: Platform, provider: string, models: Array<{ id: string } & Record<string, unknown>>, priceSourceUrl: string): Promise<ProviderProfile> {
  const db = platform.uow.db;
  const [existing] = await db
    .select()
    .from(providerProfiles)
    .where(and(eq(providerProfiles.provider, provider), eq(providerProfiles.providerKind, "image"), eq(providerProfiles.isActive, true)))
    .orderBy(asc(providerProfiles.createdAt))
    .limit(1);
  if (existing) {
    const stored = Array.isArray(existing.models) ? (existing.models as Array<{ id?: unknown }>) : [];
    const have = new Set(stored.map((m) => m.id));
    const missing = models.filter((m) => !have.has(m.id));
    if (!missing.length) return existing;
    const [u] = await db
      .update(providerProfiles)
      .set({ models: [...stored, ...missing], updatedAt: platform.clock.date() })
      .where(eq(providerProfiles.id, existing.id))
      .returning();
    return u!;
  }
  const [p] = await db
    .insert(providerProfiles)
    .values({ id: platform.ids.next("prv"), providerKind: "image", provider, versionNo: 1, models, priceSourceUrl, verifiedAt: platform.clock.date() })
    .onConflictDoNothing()
    .returning();
  if (p) return p;
  return ensureImageProviderProfile(platform, provider, models, priceSourceUrl);
}

/**
 * Bindings whose profile's provider has no usable connection (`connected(provider)` false) move to the active profile
 * of `provider` with that role's default model. Unlike rebindToConfiguredProvider, profiles stay active (the user may
 * connect that provider later and bind roles to it again). Idempotent; returns moved count.
 */
export async function rebindUnconnectedTo(platform: Platform, provider: string, connected: (provider: string) => Promise<boolean>): Promise<number> {
  const target = await findDefaultProfile(platform.uow.db, provider);
  if (!target) return 0;
  const others = await platform.uow.db
    .select({ id: providerProfiles.id, provider: providerProfiles.provider })
    .from(providerProfiles)
    .where(and(eq(providerProfiles.providerKind, "llm"), ne(providerProfiles.provider, provider)));
  const status = new Map<string, boolean>();
  for (const o of others) if (!status.has(o.provider)) status.set(o.provider, await connected(o.provider));
  const ids = others.filter((o) => !status.get(o.provider)).map((o) => o.id);
  if (!ids.length) return 0;
  return platform.uow.run(async (tx) => {
    const stale = await tx.db.select().from(roleModelBindings).where(inArray(roleModelBindings.providerProfileId, ids));
    const now = platform.clock.date();
    for (const b of stale) {
      await tx.db
        .update(roleModelBindings)
        .set({ providerProfileId: target.id, modelId: defaultRoleModel(provider, b.agentRole as AgentRole), fallbackModelId: null, fallbackEnabled: false, updatedAt: now })
        .where(eq(roleModelBindings.id, b.id));
    }
    return stale.length;
  });
}
