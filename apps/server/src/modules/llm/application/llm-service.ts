/** LlmService implementation: adapters registry, bindings/profiles CRUD (audited), connection test, gateway. */
import { AGENT_ROLE, labelKo, type AgentRole } from "@ncs/shared";
import { AppError, ConflictError, DomainValidationError, NotFoundError, SecretUndecryptableError, type ActorRef, type NovelScope, type Platform, type Tx } from "../../../platform/index.js";
import type { AuditService } from "../../audit/index.js";
import type { BudgetService } from "../../budget/index.js";
import type { SystemService } from "../../system/index.js";
import type {
  BindingPatch,
  LlmAdapter,
  LlmConnectionTestResult,
  LlmService,
  ModelUsage,
  ProviderProfile,
  ProviderProfilePatch,
  RoleModelBinding,
  RoleModelDefault,
} from "../index.js";
import { findModel, parseProfileModels } from "../domain/pricing.js";
import { addModel, claudeCliKnownModels, editModel, isEnabled, modelsOf, removeModel, resetModels, retiredModelIds } from "../domain/model-catalog.js";
import {
  ensureDefaultProviderProfile,
  ensureImageProviderProfile,
  ensureProviderProfile,
  findDefaultProfile,
  insertDefaultBindings,
  rebindUnconnectedTo,
  resolveRoleModel,
} from "../adapters/db/bootstrap.js";
import { CatalogError, listProviderModels } from "../adapters/catalog/list-models.js";
import { llmRepo as repo } from "../adapters/db/repository.js";
import { createLlmGateway, type GatewayDeps } from "./gateway.js";
import { providerCallTransition } from "../domain/provider-call.js";
import { CLAUDE_CODE_PROVIDER, LLM_CALL_PROVIDERS } from "../domain/providers.js";
import { CHATGPT_CALLBACK_PORT, CHATGPT_OAUTH_ISSUER } from "../adapters/openai/chatgpt-auth.js";
import { XAI_OAUTH_ISSUER } from "../adapters/xai/xai-auth.js";
import { createCredentialStore } from "./credentials.js";
import { createOauthLogins, type OauthLoginDeps } from "./oauth-logins.js";
import { createProviderConnections, devOnlyError } from "./connections.js";

/** inside a transaction: a model to retire is still used (turned into 409 model_in_use outside it) */
class ModelInUse extends Error {
  constructor(readonly usage: ModelUsage[]) {
    super("model_in_use");
  }
}

const labelOfRole = (role: AgentRole) => labelKo("agent_role", role);

export const ANTHROPIC_SECRET_ID = "llm.anthropic.api_key";

export interface LlmServiceDeps {
  platform: Platform;
  audit: AuditService;
  budget: BudgetService;
  system: SystemService;
  adapters?: LlmAdapter[];
  gateway?: Partial<Pick<GatewayDeps, "sleep" | "backoffSeconds">>;
  /** test seams for the OAuth login flows (poll floors) */
  oauth?: Partial<Pick<OauthLoginDeps, "xaiPollFloorMs" | "chatgptPollFloorMs">>;
  /** novel titles for "who uses this model" answers (module novel; llm never reads the novels table) */
  novelTitles?: () => Promise<Array<{ id: string; title: string }>>;
  /** 설계 추가 0011: the novel's web search setting (enabled + per-call cap) */
  webSearchPolicy?: GatewayDeps["webSearchPolicy"];
}

const CALL_PROVIDER_LABEL: Record<string, string> = {
  anthropic: "Claude API (Console 키)",
  claude_code: "Claude 구독 (Claude Code CLI)",
  openai: "GPT (OpenAI)",
  xai: "Grok (xAI)",
  google: "Gemini (Google)",
};

const bindingSnapshot = (b: RoleModelBinding) => ({
  providerProfileId: b.providerProfileId,
  modelId: b.modelId,
  maxOutputTokens: b.maxOutputTokens,
  fallbackModelId: b.fallbackModelId,
  fallbackEnabled: b.fallbackEnabled,
});

export function createLlmService(deps: LlmServiceDeps): LlmService {
  const { platform, audit } = deps;
  const { uow, clock, ids } = platform;
  const adapters = new Map<string, LlmAdapter>();
  for (const a of deps.adapters ?? []) adapters.set(a.provider, a);

  const endpoints = platform.config.llm.endpoints;
  /** InstallConfig dev_mode: subscription / OAuth connection methods are usable only in dev mode */
  const devMode = platform.config.dev_mode;
  const credentials = createCredentialStore({
    devMode,
    secrets: deps.system.secrets,
    log: platform.log,
    endpoints: { openaiAuthBaseUrl: endpoints.openai_auth_base_url ?? CHATGPT_OAUTH_ISSUER, xaiAuthBaseUrl: endpoints.xai_auth_base_url ?? XAI_OAUTH_ISSUER },
  });
  let onConnected: (provider: Parameters<NonNullable<OauthLoginDeps["onConnected"]>>[0], actorId: string | null) => Promise<void> = async () => {};
  const logins = createOauthLogins({
    store: credentials,
    log: platform.log,
    openaiAuthBaseUrl: endpoints.openai_auth_base_url ?? CHATGPT_OAUTH_ISSUER,
    xaiAuthBaseUrl: endpoints.xai_auth_base_url ?? XAI_OAUTH_ISSUER,
    callbackPort: endpoints.openai_login_callback_port ?? CHATGPT_CALLBACK_PORT,
    onConnected: (p, a) => onConnected(p, a),
    ...deps.oauth,
  });
  let applying: Promise<boolean> | null = null;
  const providers = createProviderConnections({
    platform,
    audit,
    store: credentials,
    logins,
    getAdapter: (p) => adapters.get(p),
    onClaudeCliUsable: () => service.applyClaudeSubscriptionDefault(),
  });
  onConnected = (p, a) => providers.onOauthConnected(p, a);

  const getProfile = async (id: string): Promise<ProviderProfile> => {
    const p = await repo.getProfile(uow.db, id);
    if (!p) throw new NotFoundError("공급자 프로필", id);
    return p;
  };

  const getBinding = async (scope: NovelScope, role: AgentRole, tx?: Tx): Promise<RoleModelBinding> => {
    const b = await repo.getBinding(tx?.db ?? uow.db, scope, role);
    if (!b) throw new NotFoundError("역할 모델 지정", role);
    return b;
  };

  const modelCalls = createLlmGateway({
    platform,
    budget: deps.budget,
    getBinding: (scope, role) => getBinding(scope, role),
    getProfile,
    getAdapter: (p) => adapters.get(p),
    resolveCredential: (p) => credentials.resolve(p),
    ...(deps.webSearchPolicy ? { webSearchPolicy: deps.webSearchPolicy } : {}),
    ...deps.gateway,
  });

  /** a provider this server can call: adapter registered, and the subscription CLI only in dev mode */
  const usableProvider = (provider: string) => adapters.has(provider) && (devMode || provider !== CLAUDE_CODE_PROVIDER);

  /** binding / default target: active llm profile, callable provider, model listed and switched on */
  const assertBindableModel = async (profile: ProviderProfile, modelId: string) => {
    if (!profile.isActive || profile.providerKind !== "llm") throw new DomainValidationError("provider_profile_inactive", "사용할 수 없는 공급자 프로필입니다.");
    if (!adapters.has(profile.provider)) throw new DomainValidationError("provider_unavailable", `이 서버에서 쓸 수 없는 공급자입니다: ${profile.provider}`);
    if (!devMode && profile.provider === CLAUDE_CODE_PROVIDER) throw devOnlyError("claude_cli");
    const model = findModel(profile.models, modelId);
    if (!model) throw new DomainValidationError("model_not_in_profile", `공급자 프로필에 없는 모델입니다: ${modelId}`);
    if (!isEnabled(model)) throw new DomainValidationError("model_disabled", `꺼 둔 모델입니다: ${model.label ?? modelId}. 설치 설정 → 모델에서 다시 켜세요.`);
  };

  /** 422 `provider_not_connected` when the provider has no usable connection (Claude 구독: CLI signed in + on, dev mode) */
  const assertProviderConnected = async (provider: string) => {
    if (await providers.isCallProviderConnected(provider)) return;
    throw new DomainValidationError(
      "provider_not_connected",
      `${CALL_PROVIDER_LABEL[provider] ?? provider} 연결이 없습니다. 설치 설정 → AI 계정 연결에서 먼저 연결하세요.`,
      { provider },
    );
  };

  /** who still uses `modelIds` of `profile` (bindings of every novel + 새 작품 기본 모델) */
  const modelUsage = async (tx: Tx, profile: ProviderProfile, modelIds: readonly string[]): Promise<ModelUsage[]> => {
    if (!modelIds.length) return [];
    const bindings = await repo.bindingsUsingModels(tx.db, profile.id, modelIds);
    const defaults = (await repo.listRoleDefaults(tx.db)).filter((d) => d.provider === profile.provider && modelIds.includes(d.modelId));
    if (!bindings.length && !defaults.length) return [];
    return modelIds
      .map((modelId) => ({
        modelId,
        bindings: bindings
          .filter((b) => b.modelId === modelId || b.fallbackModelId === modelId)
          .map((b) => ({ novelId: b.novelId, novelTitle: null, agentRole: b.agentRole as AgentRole, asFallback: b.modelId !== modelId })),
        defaults: defaults.filter((d) => d.modelId === modelId).map((d) => d.agentRole as AgentRole),
      }))
      .filter((u) => u.bindings.length || u.defaults.length);
  };

  /**
   * One profile change. A change of models / price source is a NEW version row (03 §10 / INV-PP-01: the ledger keeps
   * the version it was priced with — older rows are never edited); the old row is deactivated and every binding moves
   * to the new version. Removing or switching off a model that a binding or a 새 작품 기본 모델 uses → 409 model_in_use.
   */
  const changeProfile = async (tx: Tx, before: ProviderProfile, patch: ProviderProfilePatch, actor: ActorRef, op?: Record<string, unknown>): Promise<ProviderProfile> => {
    const set: Partial<ProviderProfile> = {};
    if (patch.models) {
      const models = parseProfileModels(patch.models);
      if (models.length !== patch.models.length || !models.length) throw new DomainValidationError("invalid_models", "모델 목록 형식이 올바르지 않습니다.");
      if (new Set(models.map((m) => m.id)).size !== models.length) throw new DomainValidationError("invalid_models", "같은 모델 ID가 두 번 들어 있습니다.");
      const usage = await modelUsage(tx, before, retiredModelIds(before.models, models));
      if (usage.length) throw new ModelInUse(usage);
      set.models = models;
    }
    const newVersion = !!patch.models || patch.priceSourceUrl !== undefined;
    // INV-PP-01: an old (inactive) version is history — never edit its models / prices in place
    if (newVersion && !before.isActive) throw new ConflictError("profile_outdated", "이 공급자 프로필은 이미 새 버전으로 바뀌었습니다. 목록을 새로 고친 뒤 다시 시도하세요.");
    if (patch.isActive === false && before.isActive) {
      // switching the whole profile off = retiring every model of it (bindings / 새 작품 기본 모델 would point at it)
      const usage = await modelUsage(tx, before, modelsOf(before.models).map((m) => m.id));
      if (usage.length) throw new ModelInUse(usage);
    }
    if (patch.isActive === true && !before.isActive) {
      const other = (await repo.listProfiles(tx.db)).find((p) => p.id !== before.id && p.isActive && p.providerKind === before.providerKind && p.provider === before.provider);
      if (other) throw new ConflictError("profile_outdated", "같은 공급자의 다른 버전이 이미 켜져 있습니다. 목록을 새로 고친 뒤 다시 시도하세요.", { activeProfileId: other.id });
    }
    if (patch.priceSourceUrl !== undefined) set.priceSourceUrl = patch.priceSourceUrl;
    if (patch.retentionPolicyUrl !== undefined) set.retentionPolicyUrl = patch.retentionPolicyUrl;
    if (patch.isActive !== undefined) set.isActive = patch.isActive;
    if (patch.verifiedAt) set.verifiedAt = patch.verifiedAt;
    else if (patch.models || patch.priceSourceUrl) set.verifiedAt = clock.date();
    const at = clock.date();
    let after: ProviderProfile;
    let rebound = 0;
    if (newVersion) {
      after = await repo.insertProfile(tx.db, {
        ...before,
        ...set,
        id: ids.next("prv"),
        versionNo: (await repo.maxProfileVersion(tx.db, before.providerKind, before.provider)) + 1,
        isActive: set.isActive ?? true,
        createdAt: at,
        updatedAt: at,
      });
      await repo.updateProfile(tx.db, before.id, { isActive: false }, at);
      rebound = await repo.repointBindings(tx.db, before.id, after.id, at);
    } else {
      after = (await repo.updateProfile(tx.db, before.id, set, at))!;
    }
    await audit.record(tx, {
      novelId: null,
      actor,
      action: "provider_profile.changed",
      target: { type: "settings", id: after.id },
      before: { id: before.id, versionNo: before.versionNo, models: before.models, priceSourceUrl: before.priceSourceUrl, isActive: before.isActive },
      after: { id: after.id, versionNo: after.versionNo, models: after.models, priceSourceUrl: after.priceSourceUrl, isActive: after.isActive },
      details: after.id !== before.id || op ? { ...(after.id !== before.id ? { newVersion: true, reboundBindings: rebound } : {}), ...op } : undefined,
    });
    return after;
  };

  /** ModelInUse (thrown inside the transaction) → 409 model_in_use with novel titles (read after the rollback) */
  const inUseAsConflict = async <T>(p: Promise<T>): Promise<T> => {
    try {
      return await p;
    } catch (err) {
      if (!(err instanceof ModelInUse)) throw err;
      const titles = new Map(((await deps.novelTitles?.().catch(() => [])) ?? []).map((n) => [n.id, n.title]));
      const usage = err.usage.map((u) => ({ ...u, bindings: u.bindings.map((b) => ({ ...b, novelTitle: titles.get(b.novelId) ?? null })) }));
      const who = usage
        .flatMap((u) => [
          ...u.bindings.map((b) => `${b.novelTitle ?? b.novelId} · ${labelOfRole(b.agentRole)}${b.asFallback ? "(대체)" : ""}`),
          ...u.defaults.map((r) => `새 작품 기본 · ${labelOfRole(r)}`),
        ])
        .slice(0, 6)
        .join(", ");
      throw new ConflictError("model_in_use", `사용 중인 모델은 지우거나 끌 수 없습니다(${usage.map((u) => u.modelId).join(", ")}): ${who}. 먼저 그 역할의 모델을 바꾸세요.`, { usage });
    }
  };

  /** model-list edit on the ACTIVE llm profile `profileId` (stale id → 409 profile_outdated: reload and retry) */
  const editModels = (profileId: string, actor: ActorRef, edit: (p: ProviderProfile) => unknown[], op: Record<string, unknown>) =>
    inUseAsConflict(uow.run(async (tx) => {
      const before = await repo.getProfile(tx.db, profileId, true);
      if (!before || before.providerKind !== "llm") throw new NotFoundError("공급자 프로필", profileId);
      if (!before.isActive) throw new ConflictError("profile_outdated", "이 공급자 프로필은 이미 새 버전으로 바뀌었습니다. 목록을 새로 고친 뒤 다시 시도하세요.");
      return changeProfile(tx, before, { models: edit(before) }, actor, op);
    }));

  const service: LlmService = {
    modelCalls,
    providers,
    stop: () => logins.stopAll(),
    resolveCredential: (provider) => credentials.resolve(provider),
    ensureImageProviderProfile: (provider, models, priceSourceUrl) => ensureImageProviderProfile(platform, provider, models, priceSourceUrl),
    registerAdapter(adapter) {
      adapters.set(adapter.provider, adapter);
    },
    getAdapter: (provider) => adapters.get(provider),
    createDefaultBindings: (tx, scope, connected) => insertDefaultBindings(platform, tx, scope, (p) => usableProvider(p) && (!connected || connected.has(p))),
    async roleDefaultConnections() {
      const out = new Set<string>();
      for (const provider of new Set((await repo.listRoleDefaults(uow.db)).map((r) => r.provider))) {
        if (usableProvider(provider) && (await providers.isCallProviderConnected(provider).catch(() => false))) out.add(provider);
      }
      return out;
    },
    getBinding,
    listBindings: (scope) => repo.listBindings(uow.db, scope),

    async updateBinding(scope, role, patch: BindingPatch, actor: ActorRef) {
      // connection state reads secrets through uow.db: check it BEFORE the transaction (one PGlite connection)
      const pre = await repo.getBinding(uow.db, scope, role);
      if (pre) {
        const targetId = patch.providerProfileId ?? pre.providerProfileId;
        const targetModel = patch.modelId ?? pre.modelId;
        const p = targetId !== pre.providerProfileId || targetModel !== pre.modelId ? await repo.getProfile(uow.db, targetId) : null;
        if (p && p.isActive && p.providerKind === "llm" && usableProvider(p.provider) && isEnabled(findModel(p.models, targetModel))) await assertProviderConnected(p.provider);
      }
      return uow.run(async (tx) => {
        // lock order profile → binding, like a model edit (changeProfile locks the profile, then repoints bindings):
        // a concurrent remove / switch-off of the target model either sees this binding or this change sees the new list
        const targetId = patch.providerProfileId ?? pre?.providerProfileId;
        const locked = targetId ? await repo.getProfile(tx.db, targetId, true) : null;
        const before = await repo.getBinding(tx.db, scope, role, true);
        if (!before) throw new NotFoundError("역할 모델 지정", role);
        const profile = locked && locked.id === (patch.providerProfileId ?? before.providerProfileId) ? locked : await repo.getProfile(tx.db, patch.providerProfileId ?? before.providerProfileId, true);
        if (!profile) throw new NotFoundError("공급자 프로필", patch.providerProfileId ?? before.providerProfileId);
        const moved = profile.id !== before.providerProfileId;
        // an unchanged profile (e.g. only max output tokens) needs no re-validation of the profile itself
        if ((moved && !profile.isActive) || profile.providerKind !== "llm") throw new DomainValidationError("provider_profile_inactive", "사용할 수 없는 공급자 프로필입니다.");
        if (!adapters.has(profile.provider)) throw new DomainValidationError("provider_unavailable", `이 서버에서 쓸 수 없는 공급자입니다: ${profile.provider}`);
        if (!devMode && profile.provider === CLAUDE_CODE_PROVIDER) throw devOnlyError("claude_cli");
        const modelId = patch.modelId ?? before.modelId;
        const model = findModel(profile.models, modelId);
        if (!model) throw new DomainValidationError("model_not_in_profile", `공급자 프로필에 없는 모델입니다: ${modelId}`);
        const retarget = profile.id !== before.providerProfileId || modelId !== before.modelId;
        if (retarget && !isEnabled(model)) throw new DomainValidationError("model_disabled", `꺼 둔 모델입니다: ${model.label ?? modelId}. 설치 설정 → 모델에서 다시 켜세요.`);
        const adapter = adapters.get(profile.provider);
        const cap = model.max_output_tokens ?? adapter?.capabilities(modelId).maxOutputTokens;
        // a model switch without an explicit limit keeps the role's limit, clamped to the new model's cap (the model
        // pickers send only the model; a smaller cap must not turn the switch into a 422)
        const maxOutputTokens = patch.maxOutputTokens ?? (retarget && cap !== undefined ? Math.min(before.maxOutputTokens, cap) : before.maxOutputTokens);
        if (cap !== undefined && maxOutputTokens > cap) throw new DomainValidationError("max_output_tokens_exceeded", `이 모델의 출력 토큰 상한(${cap})을 넘을 수 없습니다.`);
        // moving to another provider drops a fallback model that the new profile does not list
        const keptFallback = before.fallbackModelId && findModel(profile.models, before.fallbackModelId) ? before.fallbackModelId : null;
        const fallbackModelId = patch.fallbackModelId === undefined ? keptFallback : patch.fallbackModelId;
        if (fallbackModelId && !findModel(profile.models, fallbackModelId)) throw new DomainValidationError("model_not_in_profile", `공급자 프로필에 없는 대체 모델입니다: ${fallbackModelId}`);
        if (fallbackModelId && fallbackModelId !== before.fallbackModelId && !isEnabled(findModel(profile.models, fallbackModelId))) throw new DomainValidationError("model_disabled", `꺼 둔 대체 모델입니다: ${fallbackModelId}`);
        const fallbackEnabled = patch.fallbackEnabled ?? (before.fallbackEnabled && !!fallbackModelId);
        if (fallbackEnabled && !fallbackModelId) throw new DomainValidationError("fallback_model_required", "대체 모델을 켜려면 대체 모델을 지정하세요.");
        const after = await repo.updateBinding(tx.db, scope, before.id, { providerProfileId: profile.id, modelId, maxOutputTokens, fallbackModelId, fallbackEnabled }, clock.date());
        await audit.record(tx, {
          novelId: scope.novelId,
          actor,
          action: "model_binding.changed",
          target: { type: "settings", id: before.id },
          before: { role, ...bindingSnapshot(before) },
          after: { role, ...bindingSnapshot(after) },
        });
        return after;
      });
    },

    listProviderProfiles: () => repo.listProfiles(uow.db),
    getProviderProfile: getProfile,
    ensureDefaultProviderProfile: () => ensureDefaultProviderProfile(platform),

    applyClaudeSubscriptionDefault(opts = {}) {
      applying ??= (async () => {
        const llm = platform.config.llm;
        // production: the Claude subscription is never detected nor made the default (`claude auth status` not run)
        if (!devMode) return false;
        if (llm.provider_explicit || llm.provider === CLAUDE_CODE_PROVIDER) return false;
        if (await credentials.resolve("anthropic").catch(() => null)) return false;
        if (!(await providers.claudeCli(opts.refreshCli ?? false)).usable) return false;
        (llm as { provider: string }).provider = CLAUDE_CODE_PROVIDER;
        await ensureProviderProfile(platform, CLAUDE_CODE_PROVIDER);
        const moved = await rebindUnconnectedTo(platform, CLAUDE_CODE_PROVIDER, (p) => providers.isCallProviderConnected(p));
        platform.log.info({ provider: CLAUDE_CODE_PROVIDER, moved }, "no Anthropic API key and Claude Code is signed in with a Claude subscription: default LLM provider = claude_code");
        return true;
      })().finally(() => (applying = null));
      return applying;
    },

    async updateProviderProfile(profileId, patch: ProviderProfilePatch, actor) {
      return inUseAsConflict(
        uow.run(async (tx) => {
          const before = await repo.getProfile(tx.db, profileId, true);
          if (!before) throw new NotFoundError("공급자 프로필", profileId);
          return changeProfile(tx, before, patch, actor);
        }),
      );
    },

    addProfileModel: (profileId, input, actor) => editModels(profileId, actor, (p) => addModel(p.models, input), { op: "add", modelId: input.id }),
    editProfileModel: (profileId, modelId, patch, actor) => editModels(profileId, actor, (p) => editModel(p.models, modelId, patch), { op: "edit", modelId }),
    removeProfileModel: (profileId, modelId, actor) => editModels(profileId, actor, (p) => removeModel(p.models, modelId), { op: "remove", modelId }),
    resetProfileModels: (profileId, actor) => editModels(profileId, actor, (p) => resetModels(p.provider), { op: "reset" }),

    async listAvailableModels(provider, signal) {
      const profile = await findDefaultProfile(uow.db, provider);
      const have = new Set(modelsOf(profile?.models).map((m) => m.id));
      if (provider === CLAUDE_CODE_PROVIDER) {
        // the subscription CLI is never asked (no `claude` spawn): the ids `claude --model` documents
        return { provider, source: "fixed", items: claudeCliKnownModels().map((m) => ({ id: m.id, label: m.label, maxContextTokens: null, maxOutputTokens: null, inProfile: have.has(m.id) })) };
      }
      const credential = await credentials.resolve(provider).catch(() => null);
      if (!credential || credential.method !== "api_key") {
        throw new DomainValidationError("model_list_unavailable", `${CALL_PROVIDER_LABEL[provider] ?? provider}에 API 키가 연결돼 있어야 모델 목록을 불러올 수 있습니다. 직접 모델 ID를 입력해 추가할 수도 있습니다.`);
      }
      const ep = platform.config.llm.endpoints;
      try {
        const items = await listProviderModels(provider, credential.token, { anthropic: ep.anthropic_api_base_url, openai: ep.openai_api_base_url, xai: ep.xai_api_base_url, google: ep.google_api_base_url }, signal);
        return { provider, source: "api", items: items.map((m) => ({ ...m, inProfile: have.has(m.id) })) };
      } catch (err) {
        if (err instanceof CatalogError) throw new AppError(502, "model_list_failed", err.message);
        throw err;
      }
    },

    async listRoleDefaults() {
      const rows = new Map((await repo.listRoleDefaults(uow.db)).map((r) => [r.agentRole, r]));
      // a default of a provider that lost its connection is not used for new novels (createDefaultBindings): show it
      const connected = await service.roleDefaultConnections();
      const configured = await findDefaultProfile(uow.db, platform.config.llm.provider);
      const profiles = new Map<string, ProviderProfile | null>();
      const out: RoleModelDefault[] = [];
      for (const role of AGENT_ROLE) {
        const r = rows.get(role);
        if (r) {
          if (!profiles.has(r.provider)) profiles.set(r.provider, await findDefaultProfile(uow.db, r.provider));
          const p = profiles.get(r.provider);
          out.push({ agentRole: role, provider: r.provider, modelId: r.modelId, source: "custom", usable: connected.has(r.provider) && !!p && isEnabled(findModel(p.models, r.modelId)) });
        } else {
          const provider = platform.config.llm.provider;
          out.push({ agentRole: role, provider, modelId: configured ? resolveRoleModel(configured, role) : "", source: "builtin", usable: !!configured });
        }
      }
      return out;
    },

    async setRoleDefaults(items, actor) {
      for (const it of items) {
        const profile = await findDefaultProfile(uow.db, it.provider);
        if (!profile) throw new DomainValidationError("provider_profile_inactive", `사용할 수 있는 공급자 프로필이 없습니다: ${it.provider}`);
        await assertBindableModel(profile, it.modelId);
      }
      for (const provider of new Set(items.map((i) => i.provider))) await assertProviderConnected(provider);
      await uow.run(async (tx) => {
        const before = await repo.listRoleDefaults(tx.db);
        // re-check inside the transaction (a concurrent model edit may have removed / switched off the model)
        for (const it of items) {
          const profile = await findDefaultProfile(tx.db, it.provider);
          if (!profile) throw new DomainValidationError("provider_profile_inactive", `사용할 수 있는 공급자 프로필이 없습니다: ${it.provider}`);
          await assertBindableModel(profile, it.modelId);
        }
        const now = clock.date();
        for (const it of items) await repo.upsertRoleDefault(tx.db, it, now);
        await audit.record(tx, {
          novelId: null,
          actor,
          action: "settings.changed",
          target: { type: "settings", id: "llm.role_model_defaults" },
          before: Object.fromEntries(before.map((r) => [r.agentRole, `${r.provider}/${r.modelId}`])),
          after: Object.fromEntries(items.map((r) => [r.agentRole, `${r.provider}/${r.modelId}`])),
          details: { setting: "role_model_defaults" },
        });
      });
      return service.listRoleDefaults();
    },

    async resetRoleDefaults(role, actor) {
      await uow.run(async (tx) => {
        const before = (await repo.listRoleDefaults(tx.db)).filter((r) => !role || r.agentRole === role);
        if (!before.length) return;
        await repo.deleteRoleDefaults(tx.db, role);
        await audit.record(tx, {
          novelId: null,
          actor,
          action: "settings.changed",
          target: { type: "settings", id: "llm.role_model_defaults" },
          before: Object.fromEntries(before.map((r) => [r.agentRole, `${r.provider}/${r.modelId}`])),
          after: Object.fromEntries(before.map((r) => [r.agentRole, null])),
          details: { setting: "role_model_defaults", reset: role ?? "all" },
        });
      });
      return service.listRoleDefaults();
    },

    listProviderCalls: (scope, runId) => repo.listCalls(uow.db, scope, runId),

    async recoverInterruptedRun(tx, scope, runId) {
      let unknown = 0;
      let abandoned = 0;
      const now = clock.date();
      for (const c of await repo.listCalls(tx.db, scope, runId)) {
        if (c.status === "sent") {
          const t = providerCallTransition("P5");
          const u = await repo.casCall(tx.db, scope, c.id, t.from, { status: t.to, errorFamily: "timeout" }, now);
          if (!u) continue;
          unknown++;
          try {
            await deps.budget.closeUnknown(tx, scope, u.id, u.reservationId);
          } catch (err) {
            if (!(err instanceof DomainValidationError) || err.code !== "call_meta_required") throw err;
            // reservation predates persisted call meta: derive it from the call row + the provider's newest profile
            const profiles = (await repo.listProfiles(tx.db)).filter((p) => p.provider === u.provider);
            const profile = profiles[profiles.length - 1];
            if (!profile) throw err;
            await deps.budget.closeUnknown(tx, scope, u.id, u.reservationId, {
              provider: u.provider,
              modelId: u.modelId,
              providerProfileId: profile.id,
              providerProfileVersion: profile.versionNo,
            });
          }
        } else if (c.status === "prepared") {
          const t = providerCallTransition("P6");
          const u = await repo.casCall(tx.db, scope, c.id, t.from, { status: t.to }, now);
          if (!u) continue;
          abandoned++;
          await deps.budget.release(tx, scope, u.reservationId);
        }
      }
      return { unknown, abandoned };
    },

    async runUsage(scope, runId) {
      const calls = await repo.listCalls(uow.db, scope, runId);
      let inputTokens = 0;
      let outputTokens = 0;
      let subscriptionEstimateMicros = 0;
      const models = new Set<string>();
      for (const c of calls) {
        const u = c.usage as { inputTokens?: number; outputTokens?: number; reportedCostMicros?: number } | null;
        inputTokens += u?.inputTokens ?? 0;
        outputTokens += u?.outputTokens ?? 0;
        if (typeof u?.reportedCostMicros === "number" && adapters.get(c.provider)?.capabilities(c.modelId).billing === "subscription") subscriptionEstimateMicros += u.reportedCostMicros;
        models.add(c.modelId);
      }
      const costMicros = await deps.budget
        .listCostEvents(scope, { runId })
        .then((evs) => evs.reduce((s, e) => s + Number(e.amountMicros), 0))
        .catch(() => 0);
      return { calls: calls.length, inputTokens, outputTokens, costMicros, modelsUsed: [...models], subscriptionEstimateMicros };
    },

    async testConnection(input = {}): Promise<LlmConnectionTestResult> {
      const provider = input.provider ?? platform.config.llm.provider;
      const adapter = adapters.get(provider);
      const checkedAt = clock.date();
      if (!adapter) return { provider, modelId: input.modelId ?? null, status: "fail", errorFamily: "internal", message: `등록되지 않은 공급자입니다: ${provider}`, checkedAt };
      // production: the subscription CLI is never run (no `claude -p` / `claude auth status`)
      if (provider === CLAUDE_CODE_PROVIDER && !devMode) throw devOnlyError("claude_cli");
      if (provider === CLAUDE_CODE_PROVIDER && !(await credentials.claudeCliEnabled())) {
        return { provider, modelId: input.modelId ?? null, status: "fail", errorFamily: "auth_failed", message: "이 앱에서 Claude 구독 사용을 꺼 두었습니다. 설정 → AI 계정 연결에서 다시 연결하세요.", checkedAt };
      }
      let credential: Awaited<ReturnType<typeof credentials.resolve>>;
      try {
        credential = await credentials.resolve(provider);
      } catch (err) {
        if (err instanceof SecretUndecryptableError) return { provider, modelId: input.modelId ?? null, status: "fail", errorFamily: "auth_failed", message: err.message, checkedAt };
        throw err;
      }
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), provider === CLAUDE_CODE_PROVIDER ? 25_000 : 15_000);
      try {
        const r = await adapter.testEnvironment({ apiKey: credential?.token ?? "", credential: credential ?? undefined, modelId: input.modelId, signal: input.signal ?? ac.signal });
        return { provider, modelId: input.modelId ?? null, status: r.status, errorFamily: r.errorFamily ?? null, message: r.message, checkedAt };
      } finally {
        clearTimeout(timer);
      }
    },
  };

  // health check llm_key (install scope, FR-SET-03): the default provider always (it may change at boot: Claude
  // subscription detection), every other provider while connected (claude_code: CLI signed in + enabled in the app).
  // Outside dev mode `llm.claude_code` is not registered at all (the CLI is never spawned).
  const configured = platform.config.llm.provider;
  const checked = [configured, ...LLM_CALL_PROVIDERS.filter((p) => p !== configured)].filter((p) => devMode || p !== CLAUDE_CODE_PROVIDER);
  for (const provider of checked) {
    deps.system.registerHealthCheck({
      name: `llm.${provider}`,
      kind: "llm_key",
      scope: "install",
      isActive: async () => provider === platform.config.llm.provider || (await providers.isCallProviderConnected(provider)),
      async run({ signal }) {
        const r = await service.testConnection({ provider, signal });
        return { status: r.status, message: r.message, details: { provider: r.provider, errorFamily: r.errorFamily } };
      },
    });
  }

  return service;
}
