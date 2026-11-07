/**
 * Anonymous-write protection (server only, framework-free: plain Request / Headers):
 *  - cookies: host-only (no Domain), Path=/, HttpOnly, SameSite=Lax (admin: Strict), Secure + `__Host-` prefix unless
 *    COOKIE_SECURE=false (http://localhost dev)
 *  - CSRF: double-submit token (cookie + `X-CSRF-Token` header, constant-time compare) AND an Origin check against
 *    PUBLIC_ORIGIN (+ https://*.vercel.app when ALLOW_PREVIEW_ORIGINS=true)
 *  - ip hash: HMAC-SHA256(ip, IP_HASH_SECRET) — the raw IP is never stored
 *  - rate limits: fixed windows counted in `<schema>.rate_limits` (works across serverless instances)
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { assertSchemaName, quoteIdent, type SqlClient } from "@ncs/public-schema";
import type { ReaderEnv } from "./env";

export type CookieName = "vid" | "csrf" | "admin";

export const cookieName = (env: Pick<ReaderEnv, "cookieSecure">, n: CookieName) => (env.cookieSecure ? `__Host-snowpage_${n}` : `snowpage_${n}`);

export const VISITOR_ID_RE = /^[A-Za-z0-9_-]{22,64}$/;
export const newToken = (bytes = 24) => randomBytes(bytes).toString("base64url");

export function parseCookies(header: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!out.has(k)) {
      try {
        out.set(k, decodeURIComponent(v));
      } catch {
        /* ignore malformed */
      }
    }
  }
  return out;
}

export function serializeCookie(env: Pick<ReaderEnv, "cookieSecure">, n: CookieName, value: string, maxAgeSec: number): string {
  const parts = [`${cookieName(env, n)}=${encodeURIComponent(value)}`, "Path=/", `Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`, "HttpOnly", n === "admin" ? "SameSite=Strict" : "SameSite=Lax"];
  if (env.cookieSecure) parts.push("Secure");
  return parts.join("; ");
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Origin of a state-changing request must be the public origin (or an allowed preview origin) */
export function originAllowed(env: Pick<ReaderEnv, "publicOrigin" | "allowPreviewOrigins">, origin: string | null): boolean {
  if (!origin || origin === "null") return false;
  if (origin === env.publicOrigin) return true;
  if (env.allowPreviewOrigins) {
    try {
      const u = new URL(origin);
      return u.protocol === "https:" && u.origin === origin && /^[a-z0-9-]+(\.[a-z0-9-]+)*\.vercel\.app$/i.test(u.hostname);
    } catch {
      return false;
    }
  }
  return false;
}

/** client IP on Vercel (x-real-ip / first x-forwarded-for hop set by the platform) */
export function clientIp(headers: Headers): string {
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;
  const fwd = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || "unknown";
}

export const ipHash = (secret: string, ip: string) => createHmac("sha256", secret).update(`ip:${ip}`).digest("hex").slice(0, 40);
export const bodyHash = (s: string) => createHmac("sha256", "snowpage-body").update(s).digest("hex").slice(0, 32);

// ── admin session cookie: `<expiresMs>.<hmac(ADMIN_TOKEN, expiresMs)>` (the token itself never goes in a cookie) ──
const adminMac = (token: string, exp: number) => createHmac("sha256", token).update(`snowpage-admin:${exp}`).digest("base64url");
export const ADMIN_SESSION_MS = 7 * 24 * 3600 * 1000;
export const adminCookieValue = (token: string, now: number) => {
  const exp = now + ADMIN_SESSION_MS;
  return `${exp}.${adminMac(token, exp)}`;
};
export function adminCookieValid(token: string, value: string | undefined, now: number): boolean {
  if (!value) return false;
  const i = value.indexOf(".");
  if (i <= 0) return false;
  const exp = Number(value.slice(0, i));
  if (!Number.isFinite(exp) || exp <= now || exp > now + ADMIN_SESSION_MS + 60_000) return false;
  return safeEqual(value.slice(i + 1), adminMac(token, exp));
}

// ── DB-backed fixed-window rate limits ──────────────────────────────────────
export interface RateRule {
  limit: number;
  windowMs: number;
}
const MIN = 60_000;
export const RULES = {
  newVisitorIp: { limit: 20, windowMs: 60 * MIN },
  commentVisitor: { limit: 5, windowMs: MIN },
  commentVisitorHour: { limit: 40, windowMs: 60 * MIN },
  commentIp: { limit: 15, windowMs: MIN },
  commentIpDay: { limit: 300, windowMs: 24 * 60 * MIN },
  likeVisitor: { limit: 60, windowMs: MIN },
  likeIp: { limit: 200, windowMs: MIN },
  rateVisitor: { limit: 30, windowMs: MIN },
  deleteVisitor: { limit: 20, windowMs: MIN },
  adminLoginIp: { limit: 10, windowMs: 10 * MIN },
} satisfies Record<string, RateRule>;
export type RuleName = keyof typeof RULES;

/** count one hit; false when over the limit of the current window */
export async function hitRateLimit(c: SqlClient, schema: string, name: RuleName, subject: string, now: number): Promise<boolean> {
  const rule = RULES[name];
  const s = quoteIdent(assertSchemaName(schema));
  const windowStart = new Date(Math.floor(now / rule.windowMs) * rule.windowMs).toISOString();
  const [r] = await c.query<{ count: number | string }>(
    `INSERT INTO ${s}.rate_limits (key, window_start, count) VALUES ($1, $2::timestamptz, 1)
     ON CONFLICT (key, window_start) DO UPDATE SET count = ${s}.rate_limits.count + 1 RETURNING count`,
    [`${name}:${subject}`, windowStart],
  );
  return Number(r?.count ?? 1) <= rule.limit;
}

/** drop windows older than a day (called now and then) */
export async function pruneRateLimits(c: SqlClient, schema: string, now: number): Promise<void> {
  const s = quoteIdent(assertSchemaName(schema));
  await c.query(`DELETE FROM ${s}.rate_limits WHERE window_start < $1::timestamptz`, [new Date(now - 2 * 24 * 60 * MIN).toISOString()]);
}
