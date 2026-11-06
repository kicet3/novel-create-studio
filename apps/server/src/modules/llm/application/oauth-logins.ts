/**
 * Web OAuth login sessions (start → poll → cancel), ported from ima2-gen routes/auth.ts:
 * - `start` resolves once the user prompt is ready (authorize URL / device code; ≤ 60 s) and returns it;
 * - a new start for a provider cancels its pending logins (the browser flow owns port 1455; one session per provider);
 * - finished sessions are kept 120 s for polling, at most 20 live sessions;
 * - the result is written only after a complete token response (ChatGPT: access + refresh + account id) and only
 *   if the login was not cancelled or superseded meanwhile.
 * Session ids are random; device codes / tokens are never logged or returned (only the user code to display).
 */
import { randomBytes } from "node:crypto";
import type { LlmProviderId, ProviderOAuthSessionDto } from "@ncs/shared";
import { AppError, DomainValidationError, NotFoundError, type Logger } from "../../../platform/index.js";
import { maskEmail } from "../domain/providers.js";
import {
  CHATGPT_BROWSER_TTL_MS,
  CHATGPT_DEVICE_TTL_MS,
  ChatgptAuthError,
  buildAuthorizeUrl,
  deviceRedirectUri,
  deviceVerificationUrl,
  exchangeCode,
  generatePkce,
  pollDeviceToken as pollChatgptDevice,
  requestDeviceCode as requestChatgptDeviceCode,
  sessionFromTokenResponse,
  sessionView,
  startCallbackServer,
} from "../adapters/openai/chatgpt-auth.js";
import { XaiAuthError, discover, pollDeviceToken as pollXaiDevice, requestDeviceCode as requestXaiDeviceCode, sessionFromToken } from "../adapters/xai/xai-auth.js";
import type { CredentialStore } from "./credentials.js";

export interface OauthLoginDeps {
  store: CredentialStore;
  log: Logger;
  openaiAuthBaseUrl: string;
  xaiAuthBaseUrl: string;
  /** ChatGPT browser-login loopback port (1455 registered for the Codex client; 0 = random for tests) */
  callbackPort: number;
  /** RFC 8628 floor for xAI polling (5 s); tests lower it */
  xaiPollFloorMs?: number;
  /** minimum ChatGPT device poll interval (1 s) */
  chatgptPollFloorMs?: number;
  /** called after a session was stored (audit, cache resets) */
  onConnected?(provider: LlmProviderId, actorId: string | null): Promise<void>;
  now?: () => number;
}

type Flow = "browser" | "device";
type Status = ProviderOAuthSessionDto["status"];

interface LoginSession {
  id: string;
  provider: LlmProviderId;
  flow: Flow;
  status: Status;
  verificationUrl: string | null;
  userCode: string | null;
  expiresAt: number;
  message: string | null;
  accountEmail: string | null;
  ac: AbortController;
  finishedAt: number | null;
}

const PROMPT_TIMEOUT_MS = 60_000;
const KEEP_FINISHED_MS = 120_000;
const MAX_SESSIONS = 20;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });

function userMessage(err: unknown): string {
  if (err instanceof ChatgptAuthError || err instanceof XaiAuthError) return err.message;
  if (err instanceof TypeError) return "인증 서버에 연결할 수 없습니다. 네트워크를 확인하세요.";
  return "로그인 중 오류가 발생했습니다.";
}

export function createOauthLogins(deps: OauthLoginDeps) {
  const now = deps.now ?? Date.now;
  const sessions = new Map<string, LoginSession>();

  const dto = (s: LoginSession): ProviderOAuthSessionDto => {
    if (s.status === "pending" && now() > s.expiresAt) finish(s, "expired", "로그인 시간이 지났습니다. 다시 시작하세요.");
    return {
      sessionId: s.id,
      provider: s.provider,
      flow: s.flow,
      status: s.status,
      verificationUrl: s.status === "pending" ? s.verificationUrl : null,
      userCode: s.status === "pending" ? s.userCode : null,
      expiresAt: new Date(s.expiresAt).toISOString(),
      message: s.message,
      accountEmail: s.accountEmail,
    };
  };

  function finish(s: LoginSession, status: Status, message: string | null = null) {
    if (s.status !== "pending") return;
    s.status = status;
    s.message = message;
    s.finishedAt = now();
    s.ac.abort();
    const t = setTimeout(() => sessions.delete(s.id), KEEP_FINISHED_MS);
    t.unref?.();
  }

  function reap() {
    for (const s of sessions.values()) {
      if (s.status === "pending" && now() > s.expiresAt) finish(s, "expired", "로그인 시간이 지났습니다. 다시 시작하세요.");
      if (s.finishedAt !== null && now() - s.finishedAt > KEEP_FINISHED_MS) sessions.delete(s.id);
    }
  }

  /** runs the flow; calls `prompt()` once the user-facing URL/code is known */
  async function run(s: LoginSession, actorId: string | null, prompt: () => void): Promise<void> {
    const signal = s.ac.signal;
    if (s.provider === "openai" && s.flow === "browser") {
      const { verifier, challenge } = generatePkce();
      const state = randomBytes(32).toString("base64url");
      const cb = await startCallbackServer(deps.callbackPort, state, signal);
      try {
        s.verificationUrl = buildAuthorizeUrl(deps.openaiAuthBaseUrl, { state, challenge, redirectUri: cb.redirectUri });
        s.expiresAt = now() + CHATGPT_BROWSER_TTL_MS;
        prompt();
        const code = await Promise.race([cb.code, sleep(Math.max(0, s.expiresAt - now()), signal).then(() => Promise.reject(new ChatgptAuthError("로그인 시간이 지났습니다.", "expired")))]);
        const body = await exchangeCode(deps.openaiAuthBaseUrl, { code, verifier, redirectUri: cb.redirectUri, signal });
        await complete(s, actorId, async () => {
          const session = sessionFromTokenResponse(body, new Date(now()).toISOString());
          await deps.store.saveOpenaiSession(session);
          return sessionView(session).email;
        });
      } finally {
        cb.close();
      }
      return;
    }
    if (s.provider === "openai" && s.flow === "device") {
      const dc = await requestChatgptDeviceCode(deps.openaiAuthBaseUrl, signal);
      s.verificationUrl = deviceVerificationUrl(deps.openaiAuthBaseUrl);
      s.userCode = dc.userCode;
      s.expiresAt = now() + CHATGPT_DEVICE_TTL_MS;
      prompt();
      const interval = Math.max(dc.intervalMs, deps.chatgptPollFloorMs ?? 1000);
      for (;;) {
        await sleep(interval, signal);
        if (now() > s.expiresAt) throw new ChatgptAuthError("로그인 시간이 지났습니다.", "expired");
        const r = await pollChatgptDevice(deps.openaiAuthBaseUrl, { deviceAuthId: dc.deviceAuthId, userCode: dc.userCode, signal });
        if (!r) continue;
        const redirectUri = deviceRedirectUri(deps.openaiAuthBaseUrl);
        const body = await exchangeCode(deps.openaiAuthBaseUrl, { code: r.code, verifier: r.verifier, redirectUri, signal });
        await complete(s, actorId, async () => {
          const session = sessionFromTokenResponse(body, new Date(now()).toISOString());
          await deps.store.saveOpenaiSession(session);
          return sessionView(session).email;
        });
        return;
      }
    }
    if (s.provider === "xai" && s.flow === "device") {
      const ep = await discover(deps.xaiAuthBaseUrl, signal);
      if (!ep.deviceEndpoint) throw new XaiAuthError("xAI 인증 서버가 기기 코드 로그인을 제공하지 않습니다.");
      const dc = await requestXaiDeviceCode(ep.deviceEndpoint, signal);
      s.verificationUrl = dc.verificationUrl;
      s.userCode = dc.userCode;
      s.expiresAt = now() + dc.expiresInMs;
      prompt();
      let interval = Math.max(dc.intervalMs, deps.xaiPollFloorMs ?? 5000);
      let failures = 0;
      for (;;) {
        await sleep(interval, signal);
        if (now() > s.expiresAt) throw new XaiAuthError("기기 코드가 만료되었습니다. 다시 시작하세요.", "expired_token");
        const r = await pollXaiDevice(ep.tokenEndpoint, dc.deviceCode, signal);
        if (r.kind === "pending") {
          failures = 0;
          continue;
        }
        if (r.kind === "slow_down") {
          interval += 5000;
          continue;
        }
        if (r.kind === "retryable") {
          if (++failures >= 3) throw new XaiAuthError("xAI 인증 서버 응답이 계속 실패해 로그인을 중단했습니다.");
          continue;
        }
        await complete(s, actorId, async () => {
          const session = sessionFromToken(r.body, ep.tokenEndpoint, now());
          await deps.store.saveXaiSession(session);
          return session.email;
        });
        return;
      }
    }
    throw new DomainValidationError("oauth_flow_unsupported", "이 공급자는 해당 로그인 방식을 지원하지 않습니다.");
  }

  async function complete(s: LoginSession, actorId: string | null, save: () => Promise<string | null>) {
    // cancelled or superseded while exchanging → never overwrite a newer login
    if (s.status !== "pending" || s.ac.signal.aborted) return;
    const email = await save();
    s.accountEmail = maskEmail(email);
    finish(s, "complete");
    await deps.onConnected?.(s.provider, actorId).catch((err: unknown) => deps.log.warn({ err: (err as Error).message }, "oauth onConnected hook failed"));
  }

  return {
    async start(provider: LlmProviderId, flow: Flow, actorId: string | null): Promise<ProviderOAuthSessionDto> {
      const supported = (provider === "openai" && (flow === "browser" || flow === "device")) || (provider === "xai" && flow === "device");
      if (!supported) throw new DomainValidationError("oauth_flow_unsupported", "이 공급자는 해당 로그인 방식을 지원하지 않습니다.");
      reap();
      for (const s of sessions.values()) if (s.provider === provider && s.status === "pending") finish(s, "cancelled", "새 로그인을 시작해 이 로그인은 취소되었습니다.");
      if (sessions.size >= MAX_SESSIONS) throw new AppError(429, "too_many_logins", "진행 중인 로그인이 너무 많습니다. 잠시 후 다시 시도하세요.");
      const s: LoginSession = {
        id: randomBytes(16).toString("base64url"),
        provider,
        flow,
        status: "pending",
        verificationUrl: null,
        userCode: null,
        expiresAt: now() + PROMPT_TIMEOUT_MS,
        message: null,
        accountEmail: null,
        ac: new AbortController(),
        finishedAt: null,
      };
      sessions.set(s.id, s);
      let prompted!: () => void;
      const ready = new Promise<void>((r) => (prompted = r));
      const done = run(s, actorId, () => prompted()).catch((err: unknown) => {
        if (s.status === "pending") {
          const msg = userMessage(err);
          finish(s, err instanceof ChatgptAuthError && err.code === "expired" ? "expired" : "error", msg);
          deps.log.warn({ provider, flow, code: (err as { code?: string }).code }, "oauth login failed");
        }
      });
      const timeout = new Promise<"timeout">((r) => {
        const t = setTimeout(() => r("timeout"), PROMPT_TIMEOUT_MS);
        t.unref?.();
      });
      const first = await Promise.race([ready.then(() => "ready" as const), done.then(() => "done" as const), timeout]);
      if (first === "timeout") finish(s, "error", "인증 서버 응답이 없어 로그인을 시작하지 못했습니다.");
      if (s.status === "error" && !s.verificationUrl) {
        throw new AppError(502, "oauth_start_failed", s.message ?? "로그인을 시작하지 못했습니다.");
      }
      return dto(s);
    },

    get(provider: LlmProviderId, id: string): ProviderOAuthSessionDto {
      const s = sessions.get(id);
      if (!s || s.provider !== provider) throw new NotFoundError("로그인 세션", id);
      return dto(s);
    },

    cancel(provider: LlmProviderId, id: string): void {
      const s = sessions.get(id);
      if (!s || s.provider !== provider) throw new NotFoundError("로그인 세션", id);
      finish(s, "cancelled", "로그인을 취소했습니다.");
    },

    /** server stop: abort pending logins (closes the loopback listener) */
    stopAll(): void {
      for (const s of sessions.values()) finish(s, "cancelled", "서버가 종료되었습니다.");
    },
  };
}

export type OauthLogins = ReturnType<typeof createOauthLogins>;
