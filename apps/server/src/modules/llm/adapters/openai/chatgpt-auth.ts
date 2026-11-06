/**
 * ChatGPT sign-in through OpenAI's public Codex CLI OAuth client — ported from ima2-gen
 * (lib/chatgptAuth.ts, lib/chatgptLogin.ts, lib/codexBackend/session.ts; origin: OpenCodex / codex_cli_rs).
 *
 * - browser flow: PKCE S256, loopback callback on 127.0.0.1:1455 (`http://localhost:1455/auth/callback` is the
 *   redirect registered for the Codex client), state checked before anything else;
 * - device flow: `/api/accounts/deviceauth/usercode` → user enters the code at `/codex/device` → poll
 *   `/api/accounts/deviceauth/token` → authorization code + verifier → normal code exchange;
 * - a login is kept only with access + refresh token + account id; refresh = JSON `grant_type=refresh_token`
 *   (refresh tokens rotate on use — NCS keeps its OWN session in the secrets store, never shares ~/.codex/auth.json).
 * Error messages carry `HTTP <status> <error code>` only, never response bodies or tokens.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { jwtClaims, trimSlash } from "../shared/http.js";

export const CHATGPT_OAUTH_ISSUER = "https://auth.openai.com";
export const CHATGPT_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CHATGPT_OAUTH_SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
export const CHATGPT_AUTH_NAMESPACE = "https://api.openai.com/auth";
export const CHATGPT_PROFILE_NAMESPACE = "https://api.openai.com/profile";
export const CHATGPT_CALLBACK_PORT = 1455;
export const CHATGPT_BROWSER_TTL_MS = 5 * 60_000;
export const CHATGPT_DEVICE_TTL_MS = 15 * 60_000;
const FETCH_TIMEOUT_MS = 30_000;

export interface ChatgptSession {
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  accountId: string;
  lastRefresh: string;
}

export interface ChatgptSessionView {
  email: string | null;
  plan: string | null;
  accountId: string;
  fedramp: boolean;
  /** access-token expiry (epoch ms) from the JWT, null when unknown */
  expiresAt: number | null;
}

export class ChatgptAuthError extends Error {
  constructor(
    message: string,
    /** OAuth error code when the server sent one (e.g. invalid_grant, refresh_token_reused) */
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ChatgptAuthError";
  }
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const ns = (p: Record<string, unknown> | null, key: string): Record<string, unknown> | null => {
  const v = p?.[key];
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
};

export function extractAccountId(idToken: string | null, accessToken: string | null): string | null {
  for (const t of [idToken, accessToken]) {
    const p = jwtClaims(t);
    if (!p) continue;
    const id =
      str(p.chatgpt_account_id) ??
      str(ns(p, CHATGPT_AUTH_NAMESPACE)?.chatgpt_account_id) ??
      (Array.isArray(p.organizations) ? str((p.organizations[0] as { id?: unknown } | undefined)?.id) : null);
    if (id) return id;
  }
  return null;
}

export function sessionView(s: ChatgptSession): ChatgptSessionView {
  const id = jwtClaims(s.idToken);
  const acc = jwtClaims(s.accessToken);
  const email = str(id?.email) ?? str(ns(id, CHATGPT_PROFILE_NAMESPACE)?.email) ?? str(acc?.email) ?? str(ns(acc, CHATGPT_PROFILE_NAMESPACE)?.email);
  const plan = str(id?.chatgpt_plan_type) ?? str(ns(id, CHATGPT_AUTH_NAMESPACE)?.chatgpt_plan_type) ?? str(ns(acc, CHATGPT_AUTH_NAMESPACE)?.chatgpt_plan_type);
  const fedramp = ns(id, CHATGPT_AUTH_NAMESPACE)?.chatgpt_account_is_fedramp === true || ns(acc, CHATGPT_AUTH_NAMESPACE)?.chatgpt_account_is_fedramp === true;
  const exp = typeof acc?.exp === "number" ? acc.exp * 1000 : null;
  return { email: email?.toLowerCase() ?? null, plan, accountId: s.accountId, fedramp, expiresAt: exp };
}

/** request headers bound to the session (Codex backend) */
export function chatgptHeaders(s: ChatgptSession): Record<string, string> {
  const h: Record<string, string> = { "chatgpt-account-id": s.accountId };
  if (sessionView(s).fedramp) h["X-OpenAI-Fedramp"] = "true";
  return h;
}

/** token endpoint response → session; rejects unless access + refresh + account id are present */
export function sessionFromTokenResponse(body: unknown, nowIso: string, previous?: ChatgptSession | null): ChatgptSession {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const accessToken = str(b.access_token);
  const refreshToken = str(b.refresh_token) ?? previous?.refreshToken ?? null;
  const idToken = str(b.id_token) ?? previous?.idToken ?? null;
  if (!accessToken || !refreshToken) throw new ChatgptAuthError("ChatGPT 로그인 응답에 토큰이 없습니다.");
  const accountId = extractAccountId(idToken, accessToken) ?? previous?.accountId ?? null;
  if (!accountId) throw new ChatgptAuthError("ChatGPT 계정 ID를 확인할 수 없습니다.");
  return { accessToken, refreshToken, idToken, accountId, lastRefresh: nowIso };
}

/** stored form = Codex auth.json-compatible `{auth_mode, tokens:{…}, last_refresh}` */
export function serializeSession(s: ChatgptSession): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: { id_token: s.idToken, access_token: s.accessToken, refresh_token: s.refreshToken, account_id: s.accountId },
    last_refresh: s.lastRefresh,
  });
}

export function parseSession(json: string | null): ChatgptSession | null {
  if (!json) return null;
  try {
    const o = JSON.parse(json) as { tokens?: Record<string, unknown>; last_refresh?: unknown };
    const t = o.tokens ?? {};
    const accessToken = str(t.access_token);
    const refreshToken = str(t.refresh_token);
    const idToken = str(t.id_token);
    const accountId = str(t.account_id) ?? extractAccountId(idToken, accessToken);
    if (!accessToken || !refreshToken || !accountId) return null;
    return { accessToken, refreshToken, idToken, accountId, lastRefresh: str(o.last_refresh) ?? new Date(0).toISOString() };
  } catch {
    return null;
  }
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(64).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthorizeUrl(issuer: string, p: { state: string; challenge: string; redirectUri: string }): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: CHATGPT_OAUTH_CLIENT_ID,
    redirect_uri: p.redirectUri,
    scope: CHATGPT_OAUTH_SCOPE,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state: p.state,
    originator: "codex_cli_rs",
  });
  return `${trimSlash(issuer)}/oauth/authorize?${q}`;
}

function timeoutSignal(signal: AbortSignal | undefined, ms = FETCH_TIMEOUT_MS): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

async function oauthError(res: Response): Promise<ChatgptAuthError> {
  let code: string | undefined;
  try {
    const j = (await res.json()) as { error?: unknown; error_description?: unknown };
    const e = j.error;
    code = typeof e === "string" ? e : e && typeof e === "object" ? str((e as { code?: unknown }).code) ?? undefined : undefined;
  } catch {
    /* no body */
  }
  const safe = code?.replace(/[^\w.-]/g, "").slice(0, 60);
  return new ChatgptAuthError(`ChatGPT 인증 서버 오류 (HTTP ${res.status}${safe ? ` ${safe}` : ""})`, safe, res.status);
}

export async function exchangeCode(issuer: string, p: { code: string; verifier: string; redirectUri: string; signal?: AbortSignal }): Promise<unknown> {
  const res = await fetch(`${trimSlash(issuer)}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CHATGPT_OAUTH_CLIENT_ID,
      code: p.code,
      code_verifier: p.verifier,
      redirect_uri: p.redirectUri,
    }).toString(),
    signal: timeoutSignal(p.signal),
  });
  if (!res.ok) throw await oauthError(res);
  return res.json();
}

export async function refreshTokens(issuer: string, refreshToken: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(`${trimSlash(issuer)}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CHATGPT_OAUTH_CLIENT_ID }),
    signal: timeoutSignal(signal),
  });
  if (!res.ok) throw await oauthError(res);
  return res.json();
}

// ── device code ──
export async function requestDeviceCode(issuer: string, signal?: AbortSignal): Promise<{ deviceAuthId: string; userCode: string; intervalMs: number }> {
  const res = await fetch(`${trimSlash(issuer)}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: CHATGPT_OAUTH_CLIENT_ID }),
    signal: timeoutSignal(signal),
  });
  if (res.status === 404) {
    throw new ChatgptAuthError("이 ChatGPT 계정은 기기 코드 로그인이 꺼져 있습니다. ChatGPT 설정 → 보안에서 켜거나 브라우저 로그인을 쓰세요.", "device_code_disabled", 404);
  }
  if (!res.ok) throw await oauthError(res);
  const j = (await res.json()) as { device_auth_id?: unknown; user_code?: unknown; usercode?: unknown; interval?: unknown };
  const deviceAuthId = str(j.device_auth_id);
  const userCode = str(j.user_code) ?? str(j.usercode);
  if (!deviceAuthId || !userCode) throw new ChatgptAuthError("기기 코드 응답 형식이 올바르지 않습니다.");
  const sec = Number(j.interval);
  const intervalMs = Number.isFinite(sec) && sec > 0 ? Math.min(Math.max(Math.round(sec * 1000), 1000), CHATGPT_DEVICE_TTL_MS) : 5000;
  return { deviceAuthId, userCode, intervalMs };
}

export const deviceVerificationUrl = (issuer: string) => `${trimSlash(issuer)}/codex/device`;
export const deviceRedirectUri = (issuer: string) => `${trimSlash(issuer)}/deviceauth/callback`;

/** one poll: null = still pending (403/404), else the authorization code + verifier to exchange */
export async function pollDeviceToken(issuer: string, p: { deviceAuthId: string; userCode: string; signal?: AbortSignal }): Promise<{ code: string; verifier: string } | null> {
  const res = await fetch(`${trimSlash(issuer)}/api/accounts/deviceauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_auth_id: p.deviceAuthId, user_code: p.userCode }),
    signal: timeoutSignal(p.signal),
  });
  if (res.status === 403 || res.status === 404) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.ok) throw await oauthError(res);
  const j = (await res.json()) as { authorization_code?: unknown; code_verifier?: unknown };
  const code = str(j.authorization_code);
  const verifier = str(j.code_verifier);
  if (!code || !verifier) throw new ChatgptAuthError("기기 코드 승인 응답 형식이 올바르지 않습니다.");
  return { code, verifier };
}

// ── browser loopback callback ──
const PAGE = (title: string, body: string) =>
  `<!doctype html><html lang="ko"><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;padding:2rem"><h1>${title}</h1><p>${body}</p></body></html>`;

export interface CallbackServer {
  redirectUri: string;
  /** resolves with the authorization code; rejects on error / abort */
  code: Promise<string>;
  close(): void;
}

/**
 * Starts the loopback listener (127.0.0.1:port). State is checked FIRST, also on error callbacks — otherwise any web
 * page could navigate the browser to the loopback URL and end or hijack the login.
 */
export async function startCallbackServer(port: number, state: string, signal: AbortSignal): Promise<CallbackServer> {
  let resolveCode!: (c: string) => void;
  let rejectCode!: (e: Error) => void;
  const code = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });
  code.catch(() => {});
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/auth/callback") {
      res.writeHead(404).end();
      return;
    }
    if (url.searchParams.get("state") !== state) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(PAGE("로그인 확인 실패", "요청 상태 값이 맞지 않습니다. Novel Studio에서 로그인을 다시 시작하세요."));
      return;
    }
    const err = url.searchParams.get("error");
    if (err) {
      const safe = err.replace(/[^\w.-]/g, "").slice(0, 60);
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(PAGE("로그인 취소", "ChatGPT 로그인이 완료되지 않았습니다. 이 창을 닫으세요."));
      rejectCode(new ChatgptAuthError(`ChatGPT 로그인이 거부되었습니다 (${safe || "error"}).`, safe));
      return;
    }
    const c = url.searchParams.get("code");
    if (!c) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(PAGE("로그인 확인 실패", "인증 코드가 없습니다."));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE("로그인 완료", "ChatGPT 로그인을 마쳤습니다. 이 창을 닫고 Novel Studio로 돌아가세요."));
    resolveCode(c);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", (e: NodeJS.ErrnoException) =>
      reject(
        e.code === "EADDRINUSE"
          ? new ChatgptAuthError(`포트 ${port}이(가) 사용 중입니다(다른 Codex 로그인이 실행 중일 수 있습니다). 기기 코드 로그인을 쓰세요.`, "port_in_use")
          : e,
      ),
    );
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const actual = (server.address() as AddressInfo).port;
  const close = () => {
    server.closeAllConnections?.();
    server.close();
  };
  const onAbort = () => {
    rejectCode(new ChatgptAuthError("로그인이 취소되었습니다.", "cancelled"));
    close();
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return { redirectUri: `http://localhost:${actual}/auth/callback`, code, close };
}
