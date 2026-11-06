/** LlmService implementation: adapters registry, bindings/profiles CRUD (audited), connection test, gateway. */
import type { AgentRole } from "@ncs/shared";
import { DomainValidationError, NotFoundError, SecretUndecryptableError, type ActorRef, type NovelScope, type Platform, type Tx } from "../../../platform/index.js";
import type { AuditService } from "../../audit/index.js";
import type { BudgetService } from "../../budget/index.js";
import type { SystemService } from "../../system/index.js";
import type { BindingPatch, LlmAdapter, LlmConnectionTestResult, LlmService, ProviderProfile, ProviderProfilePatch, RoleModelBinding } from "../index.js";
import { findModel, parseProfileModels } from "../domain/pricing.js";
import { ensureDefaultProviderProfile, ensureImageProviderProfile, ensureProviderProfile, insertDefaultBindings, rebindUnconnectedTo } from "../adapters/db/bootstrap.js";
import { llmRepo as repo } from "../adapters/db/repository.js";
import { createLlmGateway, type GatewayDeps } from "./gateway.js";
import { providerCallTransition } from "../domain/provider-call.js";
import { CLAUDE_CODE_PROVIDER, LLM_CALL_PROVIDERS } from "../domain/providers.js";
import { CHATGPT_CALLBACK_PORT, CHATGPT_OAUTH_ISSUER } from "../adapters/openai/chatgpt-auth.js";
import { XAI_OAUTH_ISSUER } from "../adapters/xai/xai-auth.js";
import { createCredentialStore } from "./credentials.js";
import { createOauthLogins, type OauthLoginDeps } from "./oauth-logins.js";
import { createProviderConnections, devOnlyError } from "./connections.js";

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
}

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
    ...deps.gateway,
  });

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
    createDefaultBindings: (tx, scope) => insertDefaultBindings(platform, tx, scope),
    getBinding,
    listBindings: (scope) => repo.listBindings(uow.db, scope),

    async updateBinding(scope, role, patch: BindingPatch, actor: ActorRef) {
      return uow.run(async (tx) => {
        const before = await repo.getBinding(tx.db, scope, role, true);
        if (!before) throw new NotFoundError("역할 모델 지정", role);
        const profile = await repo.getProfile(tx.db, patch.providerProfileId ?? before.providerProfileId);
        if (!profile) throw new NotFoundError("공급자 프로필", patch.providerProfileId ?? before.providerProfileId);
        if (!profile.isActive || profile.providerKind !== "llm") throw new DomainValidationError("provider_profile_inactive", "사용할 수 없는 공급자 프로필입니다.");
        if (!adapters.has(profile.provider)) throw new DomainValidationError("provider_unavailable", `이 서버에서 쓸 수 없는 공급자입니다: ${profile.provider}`);
        if (!devMode && profile.provider === CLAUDE_CODE_PROVIDER) throw devOnlyError("claude_cli");
        const modelId = patch.modelId ?? before.modelId;
        const model = findModel(profile.models, modelId);
        if (!model) throw new DomainValidationError("model_not_in_profile", `공급자 프로필에 없는 모델입니다: ${modelId}`);
        const maxOutputTokens = patch.maxOutputTokens ?? before.maxOutputTokens;
        const adapter = adapters.get(profile.provider);
        const cap = model.max_output_tokens ?? adapter?.capabilities(modelId).maxOutputTokens;
        if (cap !== undefined && maxOutputTokens > cap) throw new DomainValidationError("max_output_tokens_exceeded", `이 모델의 출력 토큰 상한(${cap})을 넘을 수 없습니다.`);
        // moving to another provider drops a fallback model that the new profile does not list
        const keptFallback = before.fallbackModelId && findModel(profile.models, before.fallbackModelId) ? before.fallbackModelId : null;
        const fallbackModelId = patch.fallbackModelId === undefined ? keptFallback : patch.fallbackModelId;
        if (fallbackModelId && !findModel(profile.models, fallbackModelId)) throw new DomainValidationError("model_not_in_profile", `공급자 프로필에 없는 대체 모델입니다: ${fallbackModelId}`);
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
      return uow.run(async (tx) => {
        const before = await repo.getProfile(tx.db, profileId);
        if (!before) throw new NotFoundError("공급자 프로필", profileId);
        const set: Partial<ProviderProfile> = {};
        if (patch.models) {
          const models = parseProfileModels(patch.models);
          if (models.length !== patch.models.length || !models.length) throw new DomainValidationError("invalid_models", "모델 목록 형식이 올바르지 않습니다.");
          set.models = models;
        }
        if (patch.priceSourceUrl !== undefined) set.priceSourceUrl = patch.priceSourceUrl;
        if (patch.retentionPolicyUrl !== undefined) set.retentionPolicyUrl = patch.retentionPolicyUrl;
        if (patch.isActive !== undefined) set.isActive = patch.isActive;
        if (patch.verifiedAt) set.verifiedAt = patch.verifiedAt;
        else if (patch.models || patch.priceSourceUrl) set.verifiedAt = clock.date();
        const at = clock.date();
        let after: ProviderProfile;
        let rebound = 0;
        if ((patch.models || patch.priceSourceUrl !== undefined) && before.isActive) {
          // 03 §10 / INV-PP-01: a price change is a NEW version row (the ledger keeps the version it was priced with);
          // the old row is deactivated and every binding on it moves to the new version
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
          after = (await repo.updateProfile(tx.db, profileId, set, at))!;
        }
        await audit.record(tx, {
          novelId: null,
          actor,
          action: "provider_profile.changed",
          target: { type: "settings", id: after.id },
          before: { id: before.id, versionNo: before.versionNo, models: before.models, priceSourceUrl: before.priceSourceUrl, isActive: before.isActive },
          after: { id: after.id, versionNo: after.versionNo, models: after.models, priceSourceUrl: after.priceSourceUrl, isActive: after.isActive },
          details: after.id !== before.id ? { newVersion: true, reboundBindings: rebound } : undefined,
        });
        return after;
      });
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
