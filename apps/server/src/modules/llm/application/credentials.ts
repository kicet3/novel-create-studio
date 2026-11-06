/**
 * Credential store + resolver per provider (secrets store `local_encrypted`; tokens never logged / returned).
 *
 * Secrets: `llm.<p>.api_key` (env fallback ANTHROPIC_API_KEY / OPENAI_API_KEY / XAI_API_KEY / GEMINI_API_KEY),
 * `llm.<p>.oauth_session` (openai: Codex auth.json-compatible JSON; xai: XaiSession JSON),
 * `llm.<p>.active_method` (which configured method calls use; default = the most recently connected).
 *
 * OAuth refresh (ported from ima2-gen lib/codexBackend/session.ts and lib/xaiAuth.ts):
 * - the session is re-read from the store on every use (a new login may have replaced it);
 * - a near-expiry token (ChatGPT 60 s, xAI 120 s) is refreshed before use; a 401 forces one refresh;
 * - single-flight per provider; before spending the refresh token the stored access token is compared with the
 *   failed one (someone else already rotated → use theirs), and after refreshing it is compared again (a newer login
 *   landed meanwhile → the new login wins, the refresh result is dropped);
 * - a terminal refresh error (invalid_grant / refresh_token_reused / revoked_token) marks the session
 *   `reauth_required` (30 s negative cache for xAI) — the session is not deleted (the user decides).
 *
 * Dev mode (InstallConfig `dev_mode`): outside dev mode the subscription / OAuth methods (ChatGPT, xAI sign-in,
 * Claude subscription via `claude -p`) never resolve — only API keys count. Stored OAuth sessions are kept untouched
 * (they work again when the server runs in dev mode).
 */
import { createHash } from "node:crypto";
import type { LlmProviderId, ProviderConnectionMethod } from "@ncs/shared";
import { SecretUndecryptableError, type Logger, type SecretProvider } from "../../../platform/index.js";
import type { LlmCredential } from "../index.js";
import { CLAUDE_CODE_PROVIDER, PROVIDER_SPECS, activeMethodSecretId, apiKeySecretId, claudeCliEnabledId, isLlmProviderId, oauthMethodOf, oauthSecretId } from "../domain/providers.js";
import { ChatgptAuthError, chatgptHeaders, parseSession, refreshTokens, serializeSession, sessionFromTokenResponse, sessionView, type ChatgptSession } from "../adapters/openai/chatgpt-auth.js";
import { XAI_TOKEN_REFRESH_SKEW_MS, XaiAuthError, parseXaiSession, refreshXaiToken, serializeXaiSession, type XaiSession } from "../adapters/xai/xai-auth.js";

export interface CredentialEndpoints {
  openaiAuthBaseUrl: string;
  xaiAuthBaseUrl: string;
}

export interface CredentialStoreDeps {
  secrets: SecretProvider;
  log: Logger;
  endpoints: CredentialEndpoints;
  /** InstallConfig `dev_mode`: false → OAuth sessions and the Claude subscription are ignored for calls */
  devMode: boolean;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

export interface ApiKeyInfo {
  key: string;
  source: "secret" | "env";
  /** name of the environment variable the key came from (source "env") */
  envName?: string;
}

export type OauthSessionInfo =
  | { provider: "openai"; session: ChatgptSession; email: string | null; plan: string | null; accountId: string; expiresAt: number | null; refreshable: boolean }
  | { provider: "xai"; session: XaiSession; email: string | null; plan: null; accountId: string | null; expiresAt: number | null; refreshable: boolean };

const CHATGPT_SKEW_MS = 60_000;
const XAI_NEGATIVE_TTL_MS = 30_000;
const TERMINAL = /invalid_grant|refresh_token_reused|revoked_token|no_refresh_token|expired/i;

export function createCredentialStore(deps: CredentialStoreDeps) {
  const { secrets, log } = deps;
  const now = deps.now ?? Date.now;
  const env = deps.env ?? process.env;
  const inflight = new Map<string, Promise<unknown>>();
  /** provider → time a terminal refresh failure was seen (re-login needed) */
  const reauth = new Map<string, number>();
  /** provider → fingerprint (sha256) of the refresh token the provider rejected terminally; never sent again */
  const deadRefresh = new Map<string, string>();
  const fingerprint = (t: string) => createHash("sha256").update(t).digest("hex");

  /** a decrypt failure (CFG-8: master key missing / different) is surfaced, never reported as "not registered" */
  const read = (id: string) =>
    secrets.get(id).catch((err: unknown) => {
      if (err instanceof SecretUndecryptableError) throw err;
      return null;
    });

  async function apiKey(provider: string): Promise<ApiKeyInfo | null> {
    const stored = await read(apiKeySecretId(provider));
    if (stored) return { key: stored, source: "secret" };
    if (!isLlmProviderId(provider)) return null;
    for (const name of PROVIDER_SPECS[provider].apiKeyEnv) {
      const v = env[name];
      if (v) return { key: v, source: "env", envName: name };
    }
    return null;
  }

  async function openaiSession(): Promise<ChatgptSession | null> {
    return parseSession(await read(oauthSecretId("openai")));
  }
  async function xaiSession(): Promise<XaiSession | null> {
    return parseXaiSession(await read(oauthSecretId("xai")));
  }

  async function oauthInfo(provider: LlmProviderId): Promise<OauthSessionInfo | null> {
    if (provider === "openai") {
      const s = await openaiSession();
      if (!s) return null;
      const v = sessionView(s);
      return { provider, session: s, email: v.email, plan: v.plan, accountId: v.accountId, expiresAt: v.expiresAt, refreshable: !!s.refreshToken };
    }
    if (provider === "xai") {
      const s = await xaiSession();
      if (!s) return null;
      return { provider, session: s, email: s.email, plan: null, accountId: s.accountId, expiresAt: s.expiresAt, refreshable: !!s.refreshToken };
    }
    return null;
  }

  async function activeMethod(provider: LlmProviderId): Promise<ProviderConnectionMethod | null> {
    const oauth = oauthMethodOf(provider);
    const hasKey = !!(await apiKey(provider));
    const hasOauth = deps.devMode && !!oauth && !!(await oauthInfo(provider));
    const pref = (await read(activeMethodSecretId(provider))) as ProviderConnectionMethod | null;
    if (pref === "api_key" && hasKey) return "api_key";
    if (pref && pref === oauth && hasOauth) return pref;
    if (hasKey) return "api_key";
    if (hasOauth) return oauth;
    return null;
  }

  function singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = inflight.get(key) as Promise<T> | undefined;
    if (hit) return hit;
    const p = fn().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  /** refresh the ChatGPT session whose access token `failed` was rejected / is expiring */
  function refreshOpenai(failed: string): Promise<ChatgptSession | null> {
    return singleFlight("openai", async () => {
      const before = await openaiSession();
      if (!before) return null;
      if (before.accessToken !== failed) return before;
      // the stored refresh token was already rejected terminally (invalid_grant / refresh_token_reused …):
      // do not resend it — a new login / Codex import replaces the session and lifts this.
      if (deadRefresh.get("openai") === fingerprint(before.refreshToken)) return null;
      let body: unknown;
      try {
        body = await refreshTokens(deps.endpoints.openaiAuthBaseUrl, before.refreshToken);
      } catch (err) {
        if (err instanceof ChatgptAuthError && (TERMINAL.test(err.code ?? "") || err.status === 400 || err.status === 401)) {
          reauth.set("openai", now());
          deadRefresh.set("openai", fingerprint(before.refreshToken));
        }
        log.warn({ provider: "openai", code: err instanceof ChatgptAuthError ? err.code : undefined }, "ChatGPT session refresh failed");
        return null;
      }
      const after = await openaiSession();
      if (!after || after.accessToken !== failed) return after;
      const next = sessionFromTokenResponse(body, new Date(now()).toISOString(), after);
      await secrets.set(oauthSecretId("openai"), serializeSession(next), "ChatGPT 로그인 세션");
      reauth.delete("openai");
      deadRefresh.delete("openai");
      return next;
    });
  }

  function refreshXai(failed: string): Promise<XaiSession | null> {
    return singleFlight("xai", async () => {
      const seen = reauth.get("xai");
      const before = await xaiSession();
      if (!before) return null;
      if (before.accessToken !== failed) return before;
      if (seen !== undefined && now() - seen < XAI_NEGATIVE_TTL_MS) return null;
      let next: XaiSession;
      try {
        next = await refreshXaiToken(before, deps.endpoints.xaiAuthBaseUrl, { now });
      } catch (err) {
        if (err instanceof XaiAuthError && (err.terminal || err.code === "no_refresh_token")) reauth.set("xai", now());
        log.warn({ provider: "xai", code: err instanceof XaiAuthError ? err.code : undefined }, "xAI session refresh failed");
        return null;
      }
      const after = await xaiSession();
      if (!after || after.accessToken !== failed) return after;
      await secrets.set(oauthSecretId("xai"), serializeXaiSession(next), "xAI 로그인 세션");
      reauth.delete("xai");
      return next;
    });
  }

  function openaiCredential(s: ChatgptSession): LlmCredential {
    return {
      method: "chatgpt_oauth",
      token: s.accessToken,
      headers: chatgptHeaders(s),
      refresh: async () => {
        const n = await refreshOpenai(s.accessToken);
        return n ? openaiCredential(n) : null;
      },
    };
  }

  function xaiCredential(s: XaiSession): LlmCredential {
    return {
      method: "xai_oauth",
      token: s.accessToken,
      refresh: async () => {
        const n = await refreshXai(s.accessToken);
        return n ? xaiCredential(n) : null;
      },
    };
  }

  /** credential for one method (refreshing a near-expiry OAuth token first) */
  async function resolveMethod(provider: string, method: ProviderConnectionMethod): Promise<LlmCredential | null> {
    if (method === "api_key") {
      const k = await apiKey(provider);
      return k ? { method: "api_key", token: k.key } : null;
    }
    if (!deps.devMode) return null;
    if (method === "chatgpt_oauth" && provider === "openai") {
      let s = await openaiSession();
      if (!s) return null;
      const exp = sessionView(s).expiresAt;
      if (exp !== null && exp - CHATGPT_SKEW_MS <= now()) s = (await refreshOpenai(s.accessToken)) ?? s;
      return openaiCredential(s);
    }
    if (method === "xai_oauth" && provider === "xai") {
      let s = await xaiSession();
      if (!s) return null;
      if (s.expiresAt !== null && s.expiresAt - XAI_TOKEN_REFRESH_SKEW_MS <= now() && s.refreshToken) s = (await refreshXai(s.accessToken)) ?? s;
      return xaiCredential(s);
    }
    return null;
  }

  /** Claude subscription method switched on in this app (default on; "0" = deactivated by the user). Not a credential. */
  async function claudeCliEnabled(): Promise<boolean> {
    return (await read(claudeCliEnabledId).catch(() => null)) !== "0";
  }

  return {
    devMode: deps.devMode,
    apiKey,
    oauthInfo,
    activeMethod,
    resolveMethod,
    claudeCliEnabled,
    async setClaudeCliEnabled(enabled: boolean) {
      await secrets.set(claudeCliEnabledId, enabled ? "1" : "0", "Claude 구독(Claude Code CLI) 사용 여부");
    },
    /** credential of the provider's active method */
    async resolve(provider: string): Promise<LlmCredential | null> {
      // the CLI keeps its own login; the app passes only a fixed marker (no Claude.ai credential is read or stored)
      if (provider === CLAUDE_CODE_PROVIDER) return deps.devMode && (await claudeCliEnabled()) ? { method: "claude_cli", token: "claude-cli" } : null;
      if (!isLlmProviderId(provider)) {
        const k = await read(apiKeySecretId(provider));
        return k ? { method: "api_key", token: k } : null;
      }
      const m = await activeMethod(provider);
      return m ? resolveMethod(provider, m) : null;
    },
    reauthRequired(provider: string): boolean {
      return reauth.has(provider);
    },
    async saveApiKey(provider: LlmProviderId, key: string, label: string) {
      await secrets.set(apiKeySecretId(provider), key, label);
      await secrets.set(activeMethodSecretId(provider), "api_key", "AI 연결 방식 선택");
    },
    async saveOpenaiSession(s: ChatgptSession) {
      await secrets.set(oauthSecretId("openai"), serializeSession(s), "ChatGPT 로그인 세션");
      await secrets.set(activeMethodSecretId("openai"), "chatgpt_oauth", "AI 연결 방식 선택");
      reauth.delete("openai");
      deadRefresh.delete("openai");
    },
    async saveXaiSession(s: XaiSession) {
      await secrets.set(oauthSecretId("xai"), serializeXaiSession(s), "xAI 로그인 세션");
      await secrets.set(activeMethodSecretId("xai"), "xai_oauth", "AI 연결 방식 선택");
      reauth.delete("xai");
    },
    async setActiveMethod(provider: LlmProviderId, method: ProviderConnectionMethod) {
      await secrets.set(activeMethodSecretId(provider), method, "AI 연결 방식 선택");
    },
    /** deletes stored credentials of one method (or all); returns deleted secret ids */
    async clear(provider: LlmProviderId, method?: ProviderConnectionMethod): Promise<string[]> {
      const ids: string[] = [];
      if (!method || method === "api_key") ids.push(apiKeySecretId(provider));
      if ((!method || method === oauthMethodOf(provider)) && oauthMethodOf(provider)) ids.push(oauthSecretId(provider));
      if (!method) ids.push(activeMethodSecretId(provider));
      const deleted: string[] = [];
      for (const id of ids) if (await secrets.delete(id)) deleted.push(id);
      if (!method || method !== "api_key") {
        reauth.delete(provider);
        deadRefresh.delete(provider);
      }
      return deleted;
    },
  };
}

export type CredentialStore = ReturnType<typeof createCredentialStore>;
