/**
 * Provider connections (install level): status projection (never tokens), API key connect, OAuth login sessions,
 * one-time import of the Codex CLI session, active-method switch, disconnect. Every change is audited as
 * `secret.set` / `secret.deleted` (ids only, no values).
 *
 * Dev mode only (InstallConfig `dev_mode`): the subscription / OAuth methods (`claude_cli`, `chatgpt_oauth`,
 * `xai_oauth`). Outside dev mode they are listed with `availability: "dev_only"`, every route that would start a
 * login, import the Codex session, enable the Claude subscription or switch to such a method answers 422
 * `oauth_dev_only`, and `claude auth status` is never run. Stored sessions are kept (not deleted).
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LlmProviderId, ProviderConnectionMethod, ProviderOAuthSessionDto, ProviderStatusDto } from "@ncs/shared";
import { ConflictError, DomainValidationError, type ActorRef, type Platform } from "../../../platform/index.js";
import type { AuditService } from "../../audit/index.js";
import type { LlmAdapter, LlmCliStatus } from "../index.js";
import {
  CLAUDE_CODE_PROVIDER,
  DEV_ONLY_CODE,
  DEV_ONLY_REASON,
  LLM_PROVIDERS,
  PROVIDER_SPECS,
  apiKeySecretId,
  apiKeyShapeProblem,
  claudeCliEnabledId,
  isDevOnlyMethod,
  maskEmail,
  maskId,
  oauthMethodOf,
  oauthSecretId,
} from "../domain/providers.js";
import { parseSession, sessionView } from "../adapters/openai/chatgpt-auth.js";
import type { CredentialStore } from "./credentials.js";
import type { OauthLogins } from "./oauth-logins.js";

export interface ConnectionsDeps {
  platform: Platform;
  audit: AuditService;
  store: CredentialStore;
  logins: OauthLogins;
  env?: NodeJS.ProcessEnv;
  /** adapter registry (the `claude_code` adapter answers `claude auth status`) */
  getAdapter?(provider: string): LlmAdapter | undefined;
  /** cache of `claude auth status` (default 10 s; a refresh bypasses it) */
  cliStatusTtlMs?: number;
  /**
   * Called after a refreshed check finds the Claude subscription usable (connect / status refresh): the service makes
   * it the default provider when the user did not choose one and there is no Anthropic API key (no restart needed).
   */
  onClaudeCliUsable?(): Promise<unknown>;
}

export type ClaudeCliState = NonNullable<ProviderStatusDto["claudeCli"]>;

/** 422 `oauth_dev_only`: a subscription / OAuth method was used while the server is not in dev mode */
export function devOnlyError(method: ProviderConnectionMethod | string): DomainValidationError {
  return new DomainValidationError(DEV_ONLY_CODE, `이 연결 방식은 ${DEV_ONLY_REASON}`, { method, devMode: false });
}

/** availability fields of one method row */
export function methodAvailability(method: ProviderConnectionMethod, devMode: boolean): { availability: "available" | "dev_only"; unavailableReason: string | null } {
  return !devMode && isDevOnlyMethod(method) ? { availability: "dev_only", unavailableReason: DEV_ONLY_REASON } : { availability: "available", unavailableReason: null };
}

export function createProviderConnections(deps: ConnectionsDeps) {
  const { platform, audit, store, logins } = deps;
  const env = deps.env ?? process.env;
  const devMode = store.devMode;
  const requireDev = (method: ProviderConnectionMethod | string) => {
    if (!devMode) throw devOnlyError(method);
  };

  const record = (actor: ActorRef, action: "secret.set" | "secret.deleted", secretIds: string[], details: Record<string, unknown> = {}) =>
    platform.uow.run(async (tx) => {
      for (const secretId of secretIds) {
        await audit.record(tx, { novelId: null, actor, action, target: { type: "settings", id: `secret.${secretId}` }, details: { secretId, ...details } });
      }
    });

  // ── Claude subscription (Claude Code CLI): `claude auth status` only, cached briefly, single-flight ──
  const cliTtl = deps.cliStatusTtlMs ?? 10_000;
  let cliCache: { at: number; s: LlmCliStatus } | null = null;
  let cliInflight: Promise<LlmCliStatus> | null = null;
  async function cliProbe(refresh: boolean): Promise<LlmCliStatus> {
    const adapter = deps.getAdapter?.(CLAUDE_CODE_PROVIDER);
    if (!adapter?.status) return { installed: false, loggedIn: false, authMethod: null, message: "이 서버에는 Claude 구독(Claude Code CLI) 연결이 없습니다." };
    if (!refresh && cliCache && Date.now() - cliCache.at < cliTtl) return cliCache.s;
    cliInflight ??= adapter
      .status(AbortSignal.timeout(20_000))
      .catch((err: unknown): LlmCliStatus => ({ installed: false, loggedIn: false, authMethod: null, message: `Claude Code 상태를 확인하지 못했습니다: ${(err as Error).message}`.slice(0, 300) }))
      .then((st) => {
        cliCache = { at: Date.now(), s: st };
        return st;
      })
      .finally(() => (cliInflight = null));
    return cliInflight;
  }

  async function claudeCli(refresh = false): Promise<ClaudeCliState> {
    if (!devMode) {
      // production: the subscription lane is off and `claude auth status` is never spawned
      return { installed: false, loggedIn: false, authMethod: null, enabled: await store.claudeCliEnabled(), usable: false, message: `Claude 구독(Claude Code CLI)은 ${DEV_ONLY_REASON}`, checkedAt: new Date().toISOString() };
    }
    const [st, enabled] = await Promise.all([cliProbe(refresh), store.claudeCliEnabled()]);
    const subscription = st.installed && st.loggedIn && st.authMethod === "claude.ai";
    return {
      installed: st.installed,
      loggedIn: st.loggedIn,
      authMethod: st.authMethod,
      enabled,
      usable: enabled && subscription,
      message: !enabled ? "이 앱에서 Claude 구독 사용을 꺼 두었습니다. [연결]을 누르면 다시 씁니다(Claude Code 로그인은 그대로입니다)." : st.message,
      checkedAt: new Date(cliCache?.at ?? Date.now()).toISOString(),
    };
  }

  async function status(provider: LlmProviderId, opts: { refresh?: boolean } = {}): Promise<ProviderStatusDto> {
    const spec = PROVIDER_SPECS[provider];
    const key = await store.apiKey(provider);
    if (provider === "anthropic") {
      const cli = await claudeCli(opts.refresh);
      if (opts.refresh && cli.usable && deps.onClaudeCliUsable) {
        try {
          await deps.onClaudeCliUsable();
        } catch (err) {
          platform.log.warn({ err: (err as Error).message }, "switching the default LLM provider to the Claude subscription failed");
        }
      }
      return claudeStatus(key, cli);
    }
    const oauth = await store.oauthInfo(provider);
    const active = await store.activeMethod(provider);
    const oauthMethod = oauthMethodOf(provider);
    const methods = spec.methods.map((m) => ({
      method: m.method,
      flows: m.flows,
      label: m.label,
      official: m.official,
      experimental: m.experimental,
      note: m.note,
      ...methodAvailability(m.method, devMode),
      configured: m.method === "api_key" ? !!key : !!oauth,
      source: m.method === "api_key" ? (key?.source ?? null) : oauth ? ("secret" as const) : null,
    }));
    let health: ProviderStatusDto["health"] = "not_connected";
    if (active === "api_key") health = "healthy";
    else if (active && active === oauthMethod && oauth) {
      if (store.reauthRequired(provider)) health = "reauth_required";
      else if (!oauth.refreshable && oauth.expiresAt !== null && oauth.expiresAt <= Date.now()) health = "reauth_required";
      else health = "healthy";
    }
    const useOauth = active !== null && active === oauthMethod && !!oauth;
    return {
      provider,
      label: spec.label,
      connected: active !== null,
      activeMethod: active,
      methods,
      unsupported: spec.unsupported,
      health,
      account: useOauth ? { email: maskEmail(oauth!.email), plan: oauth!.plan, accountId: maskId(oauth!.accountId) } : null,
      expiresAt: useOauth && oauth!.expiresAt !== null ? new Date(oauth!.expiresAt).toISOString() : null,
      termsNote: spec.termsNote,
      imageGeneration: spec.imageGeneration,
      isDefault: platform.config.llm.provider === provider,
      claudeCli: null,
    };
  }

  /** Claude row: two independent lanes — Console API key (provider anthropic) and subscription CLI (provider claude_code) */
  function claudeStatus(key: Awaited<ReturnType<CredentialStore["apiKey"]>>, cli: ClaudeCliState): ProviderStatusDto {
    const spec = PROVIDER_SPECS.anthropic;
    const methods = spec.methods.map((m) => ({
      method: m.method,
      flows: m.flows,
      label: m.label,
      official: m.official,
      experimental: m.experimental,
      note: m.note,
      ...methodAvailability(m.method, devMode),
      configured: m.method === "api_key" ? !!key : cli.usable,
      source: m.method === "api_key" ? (key?.source ?? null) : null,
    }));
    const active = key ? "api_key" : cli.usable ? "claude_cli" : null;
    const cliNeedsAttention = devMode && cli.enabled && cli.loggedIn && cli.authMethod !== "claude.ai";
    return {
      provider: "anthropic",
      label: spec.label,
      connected: active !== null,
      activeMethod: active,
      methods,
      unsupported: spec.unsupported,
      health: active ? "healthy" : cliNeedsAttention ? "warning" : "not_connected",
      account: null,
      expiresAt: null,
      termsNote: spec.termsNote,
      imageGeneration: spec.imageGeneration,
      isDefault: platform.config.llm.provider === "anthropic" || platform.config.llm.provider === CLAUDE_CODE_PROVIDER,
      claudeCli: cli,
    };
  }

  return {
    status,
    // anthropic first: a refresh may switch the default provider, which every other row reports (isDefault)
    list: async (opts: { refresh?: boolean } = {}) => {
      const first = await status("anthropic", opts);
      const rest = await Promise.all(LLM_PROVIDERS.filter((p) => p !== "anthropic").map((p) => status(p, opts)));
      return LLM_PROVIDERS.map((p) => (p === "anthropic" ? first : rest.find((r) => r.provider === p)!));
    },
    claudeCli,
    devMode,
    /**
     * The provider's only connection is a dev-only method that production ignores: `claude_code` outside dev mode, or
     * an OAuth session without an API key (ChatGPT / xAI). Role bindings on such providers are rebound at boot.
     */
    async isDevOnlyConnection(provider: string): Promise<boolean> {
      if (devMode) return false;
      if (provider === CLAUDE_CODE_PROVIDER) return true;
      if (provider !== "openai" && provider !== "xai") return false;
      return !(await store.apiKey(provider)) && !!(await store.oauthInfo(provider));
    },
    async isConnected(provider: LlmProviderId): Promise<boolean> {
      if (provider === "anthropic" && (await claudeCli()).usable) return true;
      return (await store.activeMethod(provider)) !== null;
    },
    /** a calling provider (profile provider, incl. claude_code) has a usable connection */
    async isCallProviderConnected(provider: string): Promise<boolean> {
      if (provider === CLAUDE_CODE_PROVIDER) return (await claudeCli()).usable;
      if (provider === "anthropic" || provider === "openai" || provider === "xai" || provider === "google") return (await store.activeMethod(provider)) !== null;
      return !!(await store.resolve(provider).catch(() => null));
    },

    /** Claude subscription: switch the method on in this app and re-check `claude auth status`. Never starts a login. */
    async connectClaudeCli(actor: ActorRef): Promise<ProviderStatusDto> {
      requireDev("claude_cli");
      if (!(await store.claudeCliEnabled())) {
        await store.setClaudeCliEnabled(true);
        await record(actor, "secret.set", [claudeCliEnabledId], { provider: "anthropic", method: "claude_cli", enabled: true });
      }
      return status("anthropic", { refresh: true });
    },

    async setApiKey(provider: LlmProviderId, apiKey: string, actor: ActorRef): Promise<ProviderStatusDto> {
      const key = apiKey.trim();
      const shape = apiKeyShapeProblem(provider, key);
      if (shape) throw new DomainValidationError("invalid_api_key_format", shape);
      const replaced = !!(await store.apiKey(provider))?.source;
      await store.saveApiKey(provider, key, `${PROVIDER_SPECS[provider].label} API 키`);
      await record(actor, "secret.set", [apiKeySecretId(provider)], { provider, method: "api_key", replaced });
      return status(provider);
    },

    async setActiveMethod(provider: LlmProviderId, method: ProviderConnectionMethod, actor: ActorRef): Promise<ProviderStatusDto> {
      if (isDevOnlyMethod(method)) requireDev(method);
      const spec = PROVIDER_SPECS[provider];
      if (provider === "anthropic") {
        throw new DomainValidationError(
          "method_not_switchable",
          "Claude 구독과 Console API 키는 함께 연결해 둘 수 있습니다. 어느 쪽으로 호출할지는 작품 설정 → 역할별 모델에서 공급자(Claude 구독 / Claude API)를 고르세요.",
        );
      }
      if (!spec.methods.some((m) => m.method === method)) throw new DomainValidationError("method_unsupported", "이 공급자가 지원하지 않는 연결 방식입니다.");
      if (!(await store.resolveMethod(provider, method))) throw new DomainValidationError("method_not_configured", "이 방식으로 연결된 자격 증명이 없습니다. 먼저 연결하세요.");
      await store.setActiveMethod(provider, method);
      await record(actor, "secret.set", [`llm.${provider}.active_method`], { provider, method });
      return status(provider);
    },

    async disconnect(provider: LlmProviderId, method: ProviderConnectionMethod | undefined, actor: ActorRef): Promise<ProviderStatusDto> {
      if (provider === "anthropic" && (!method || method === "claude_cli") && (await store.claudeCliEnabled())) {
        // only deactivates the method in this app; the Claude Code CLI login is never touched
        await store.setClaudeCliEnabled(false);
        await record(actor, "secret.set", [claudeCliEnabledId], { provider: "anthropic", method: "claude_cli", enabled: false });
      }
      if (method === "claude_cli") {
        if (provider !== "anthropic") throw new DomainValidationError("method_unsupported", "이 공급자가 지원하지 않는 연결 방식입니다.");
        return status(provider);
      }
      const deleted = await store.clear(provider, method);
      if (deleted.length) await record(actor, "secret.deleted", deleted, { provider, method: method ?? "all" });
      if (!method || method === "api_key") {
        // an environment-variable key cannot be removed from here; say so instead of reporting "disconnected"
        const left = await store.apiKey(provider);
        if (left?.source === "env") {
          throw new ConflictError(
            "api_key_from_env",
            `환경 변수 ${left.envName}에 설정된 API 키는 여기서 해제할 수 없습니다. 서버 환경에서 ${left.envName}을(를) 제거하고 서버를 다시 시작하세요.${deleted.length ? " (저장된 자격 증명은 삭제했습니다.)" : ""}`,
            { envVar: left.envName, deleted: deleted.length },
          );
        }
      }
      return status(provider);
    },

    async startLogin(provider: LlmProviderId, flow: "browser" | "device", actor: ActorRef): Promise<ProviderOAuthSessionDto> {
      const oauthMethod = oauthMethodOf(provider);
      if (oauthMethod) requireDev(oauthMethod);
      return logins.start(provider, flow, actor.id);
    },
    getLogin: (provider: LlmProviderId, id: string) => logins.get(provider, id),
    cancelLogin: (provider: LlmProviderId, id: string) => logins.cancel(provider, id),

    /** audit hook for completed OAuth logins */
    async onOauthConnected(provider: LlmProviderId, actorId: string | null) {
      await record(actorId ? { type: "user", id: actorId } : { type: "system", id: "orchestrator" }, "secret.set", [oauthSecretId(provider)], { provider, method: oauthMethodOf(provider) });
    },

    /**
     * One-time COPY of the Codex CLI ChatGPT session ($CODEX_HOME/auth.json or ~/.codex/auth.json). Refresh tokens
     * rotate on use: after NCS refreshes, the Codex CLI session in that file is logged out (the UI warns). The file is
     * never written.
     */
    async importCodexSession(actor: ActorRef): Promise<ProviderStatusDto> {
      requireDev("chatgpt_oauth");
      const dir = env.CODEX_HOME || join(homedir(), ".codex");
      let raw: string;
      try {
        raw = await readFile(join(dir, "auth.json"), "utf8");
      } catch {
        throw new DomainValidationError("codex_auth_not_found", "Codex CLI 로그인 파일(~/.codex/auth.json)을 찾을 수 없습니다. `codex login`으로 로그인했는지, 자격 증명을 파일에 저장하는지 확인하세요.");
      }
      const session = parseSession(raw);
      if (!session) throw new DomainValidationError("codex_auth_invalid", "Codex CLI 로그인 파일에 ChatGPT 로그인 세션이 없습니다(API 키 로그인이거나 형식이 다릅니다).");
      await store.saveOpenaiSession({ ...session, lastRefresh: new Date().toISOString() });
      await record(actor, "secret.set", [oauthSecretId("openai")], { provider: "openai", method: "chatgpt_oauth", importedFrom: "codex_cli", plan: sessionView(session).plan });
      return status("openai");
    },
  };
}

export type ProviderConnections = ReturnType<typeof createProviderConnections>;
