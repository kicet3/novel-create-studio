/**
 * xAI account sign-in, RFC 8628 device code — ported from ima2-gen (lib/xaiAuth.ts, lib/xaiDeviceLogin.ts).
 * NOT documented by xAI for third-party apps (the Grok CLI public client is reused) → labelled experimental in the UI.
 *
 * - discovery `<issuer>/.well-known/openid-configuration`; endpoints are trusted only when https on auth.x.ai /
 *   accounts.x.ai (or on the configured issuer's own origin — tests / proxies);
 * - device code: form `client_id, scope` → `device_code, user_code, verification_uri(_complete), expires_in, interval`;
 * - poll: `grant_type=urn:ietf:params:oauth:grant-type:device_code`, interval ≥ 5 s (RFC floor), `slow_down` +5 s,
 *   3 consecutive transport/429/5xx failures abort, deadline = expires_in;
 * - refresh: form `grant_type=refresh_token` (rotation optional: keep the old refresh token when none is returned),
 *   up to 3 attempts on 429/5xx/network honouring Retry-After (cap 60 s).
 */
import { jwtClaims, trimSlash } from "../shared/http.js";

export const XAI_OAUTH_ISSUER = "https://auth.x.ai";
export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";
export const XAI_TOKEN_REFRESH_SKEW_MS = 120_000;
export const XAI_TERMINAL_OAUTH_ERRORS = new Set(["invalid_grant", "refresh_token_reused", "revoked_token"]);
const TRUSTED_HOSTS = new Set(["auth.x.ai", "accounts.x.ai"]);
const TIMEOUT_MS = 30_000;
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export interface XaiSession {
  accessToken: string;
  refreshToken: string | null;
  /** epoch ms (raw; skew applied at compare time); null = unknown (a 401 is the signal) */
  expiresAt: number | null;
  tokenEndpoint: string;
  email: string | null;
  accountId: string | null;
}

export interface XaiEndpoints {
  tokenEndpoint: string;
  deviceEndpoint: string | null;
}

export class XaiAuthError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "XaiAuthError";
  }
  get terminal(): boolean {
    return !!this.code && XAI_TERMINAL_OAUTH_ERRORS.has(this.code);
  }
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const sig = (signal: AbortSignal | undefined, ms = TIMEOUT_MS) => (signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms));
const form = (o: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
  body: new URLSearchParams(o).toString(),
});

/** https on auth.x.ai / accounts.x.ai, or the configured issuer's own origin; never userinfo in the URL */
export function trustedEndpoint(raw: unknown, issuer: string): string | null {
  const s = str(raw);
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.username || u.password) return null;
    const iss = new URL(issuer);
    if (u.origin === iss.origin) return u.toString();
    if (u.protocol === "https:" && TRUSTED_HOSTS.has(u.hostname)) return u.toString();
  } catch {
    /* invalid */
  }
  return null;
}

export async function discover(issuer: string, signal?: AbortSignal): Promise<XaiEndpoints> {
  const res = await fetch(`${trimSlash(issuer)}/.well-known/openid-configuration`, { headers: { accept: "application/json" }, signal: sig(signal) });
  if (!res.ok) throw new XaiAuthError(`xAI 인증 서버 설정을 가져오지 못했습니다 (HTTP ${res.status}).`, undefined, res.status);
  const j = (await res.json()) as Record<string, unknown>;
  const tokenEndpoint = trustedEndpoint(j.token_endpoint, issuer);
  if (!tokenEndpoint) throw new XaiAuthError("xAI 인증 서버 설정에 신뢰할 수 있는 토큰 주소가 없습니다.");
  return { tokenEndpoint, deviceEndpoint: trustedEndpoint(j.device_authorization_endpoint, issuer) };
}

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresInMs: number;
  intervalMs: number;
}

export async function requestDeviceCode(endpoint: string, signal?: AbortSignal): Promise<DeviceCode> {
  const res = await fetch(endpoint, { ...form({ client_id: XAI_OAUTH_CLIENT_ID, scope: XAI_OAUTH_SCOPE }), signal: sig(signal, 15_000) });
  if (!res.ok) throw await oauthError(res, "xAI 기기 코드 요청 실패");
  const j = (await res.json()) as Record<string, unknown>;
  const deviceCode = str(j.device_code);
  const userCode = str(j.user_code);
  const verificationUrl = str(j.verification_uri_complete) ?? str(j.verification_uri);
  if (!deviceCode || !userCode || !verificationUrl) throw new XaiAuthError("xAI 기기 코드 응답 형식이 올바르지 않습니다.");
  const exp = Number(j.expires_in);
  const iv = Number(j.interval);
  return {
    deviceCode,
    userCode,
    verificationUrl,
    expiresInMs: (Number.isFinite(exp) && exp > 0 ? exp : 600) * 1000,
    intervalMs: (Number.isFinite(iv) && iv > 0 ? iv : 5) * 1000,
  };
}

async function oauthError(res: Response, prefix: string): Promise<XaiAuthError> {
  let code: string | undefined;
  try {
    const j = (await res.json()) as { error?: unknown };
    code = str(j.error)?.replace(/[^\w.-]/g, "").slice(0, 60);
  } catch {
    /* no body */
  }
  return new XaiAuthError(`${prefix} (HTTP ${res.status}${code ? ` ${code}` : ""})`, code, res.status);
}

export type PollResult = { kind: "pending" } | { kind: "slow_down" } | { kind: "retryable"; status?: number } | { kind: "token"; body: unknown };

export async function pollDeviceToken(tokenEndpoint: string, deviceCode: string, signal?: AbortSignal): Promise<PollResult> {
  let res: Response;
  try {
    res = await fetch(tokenEndpoint, { ...form({ grant_type: DEVICE_GRANT, client_id: XAI_OAUTH_CLIENT_ID, device_code: deviceCode }), signal: sig(signal, 10_000) });
  } catch (err) {
    if (signal?.aborted) throw err;
    return { kind: "retryable" };
  }
  if (res.ok) return { kind: "token", body: await res.json() };
  let code: string | null = null;
  try {
    code = str(((await res.json()) as { error?: unknown }).error);
  } catch {
    /* no body */
  }
  if (code === "authorization_pending") return { kind: "pending" };
  if (code === "slow_down") return { kind: "slow_down" };
  if (res.status === 429 || res.status >= 500) return { kind: "retryable", status: res.status };
  const safe = code?.replace(/[^\w.-]/g, "").slice(0, 60);
  throw new XaiAuthError(
    safe === "access_denied" ? "xAI 로그인이 거부되었습니다." : safe === "expired_token" ? "기기 코드가 만료되었습니다. 다시 시작하세요." : `xAI 기기 로그인 실패 (${safe ?? `HTTP ${res.status}`})`,
    safe,
    res.status,
  );
}

export function sessionFromToken(body: unknown, tokenEndpoint: string, now: number, previous?: XaiSession | null): XaiSession {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const accessToken = str(b.access_token);
  if (!accessToken) throw new XaiAuthError("xAI 로그인 응답에 토큰이 없습니다.");
  const exp = Number(b.expires_in);
  const idToken = str(b.id_token);
  const claims = jwtClaims(idToken) ?? jwtClaims(accessToken);
  return {
    accessToken,
    refreshToken: str(b.refresh_token) ?? previous?.refreshToken ?? null,
    expiresAt: Number.isFinite(exp) && exp > 0 ? now + exp * 1000 : null,
    tokenEndpoint,
    email: str(claims?.email)?.toLowerCase() ?? previous?.email ?? null,
    accountId: str(claims?.sub) ?? previous?.accountId ?? null,
  };
}

export function serializeXaiSession(s: XaiSession): string {
  return JSON.stringify(s);
}

export function parseXaiSession(json: string | null): XaiSession | null {
  if (!json) return null;
  try {
    const o = JSON.parse(json) as Partial<XaiSession>;
    if (!str(o.accessToken) || !str(o.tokenEndpoint)) return null;
    return {
      accessToken: o.accessToken!,
      refreshToken: str(o.refreshToken),
      expiresAt: typeof o.expiresAt === "number" ? o.expiresAt : null,
      tokenEndpoint: o.tokenEndpoint!,
      email: str(o.email),
      accountId: str(o.accountId),
    };
  } catch {
    return null;
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });

/** refresh with up to 3 attempts on 429/5xx/network (Retry-After honoured, capped 60 s) */
export async function refreshXaiToken(s: XaiSession, issuer: string, opts: { now: () => number; signal?: AbortSignal; sleepMs?: (ms: number) => number } = { now: Date.now }): Promise<XaiSession> {
  if (!s.refreshToken) throw new XaiAuthError("xAI 세션을 갱신할 수 없습니다. 다시 로그인하세요.", "no_refresh_token");
  const endpoint = trustedEndpoint(s.tokenEndpoint, issuer) ?? (await discover(issuer, opts.signal)).tokenEndpoint;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res: Response;
    try {
      res = await fetch(endpoint, { ...form({ grant_type: "refresh_token", client_id: XAI_OAUTH_CLIENT_ID, refresh_token: s.refreshToken }), signal: sig(opts.signal) });
    } catch (err) {
      if (opts.signal?.aborted || (err instanceof Error && err.name === "TimeoutError")) throw err;
      lastErr = err;
      await sleep((opts.sleepMs ?? ((x) => x))(attempt === 1 ? 100 : 250), opts.signal);
      continue;
    }
    if (res.ok) return sessionFromToken(await res.json(), endpoint, opts.now(), s);
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const ra = Number(res.headers.get("retry-after"));
      await res.body?.cancel().catch(() => {});
      await sleep((opts.sleepMs ?? ((x) => x))(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 60_000) : attempt === 1 ? 100 : 250), opts.signal);
      continue;
    }
    throw await oauthError(res, "xAI 세션 갱신 실패");
  }
  throw lastErr instanceof Error ? lastErr : new XaiAuthError("xAI 세션 갱신 실패");
}
