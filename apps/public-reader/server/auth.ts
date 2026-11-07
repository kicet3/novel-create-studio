/**
 * Reader identity: 닉네임 + 비밀번호. Passwords: scrypt (N=2^15, r=8, p=1, 16-byte salt, 32-byte key), compared in
 * constant time. Sessions: 32 random bytes in an httpOnly SameSite=Lax cookie; only the SHA-256 of the token is
 * stored. CSRF: double-submit token (cookie `ncs_csrf` + header `X-CSRF-Token`) AND an Origin / Referer check.
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const KEY_LEN = 32;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password.normalize("NFC"), salt, KEY_LEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, keyB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(keyB64, "base64url");
  if (expected.length !== KEY_LEN) return false;
  const key = scryptSync(password.normalize("NFC"), Buffer.from(saltB64, "base64url"), KEY_LEN, { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return timingSafeEqual(key, expected);
}

/** a hash to verify against when the nickname does not exist (same cost: no user enumeration by timing) */
export const DUMMY_HASH = hashPassword(randomBytes(12).toString("hex"));

export const newToken = () => randomBytes(32).toString("base64url");
export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

/** constant-time string equality (different lengths → false) */
export function safeEqual(a: string, b: string): boolean {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y) && a.length === b.length;
}

export const SESSION_COOKIE = "ncs_rs";
export const CSRF_COOKIE = "ncs_csrf";
export const CSRF_HEADER = "x-csrf-token";
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!/^[\w.-]+$/.test(k) || k in out) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      /* ignore malformed */
    }
  }
  return out;
}

export function cookie(name: string, value: string, o: { httpOnly?: boolean; maxAgeSec?: number; secure?: boolean }): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Lax"];
  if (o.httpOnly) parts.push("HttpOnly");
  if (o.secure) parts.push("Secure");
  if (o.maxAgeSec !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(o.maxAgeSec))}`);
  return parts.join("; ");
}

/**
 * State-changing requests must carry the CSRF token from the cookie in the header, and when the browser sends an
 * Origin (or Referer) it must be this site's own origin (`allowedOrigins`, else the request's Host).
 */
export function csrfOk(o: { method: string; cookieToken: string | undefined; headerToken: string | undefined; origin: string | undefined; referer: string | undefined; host: string | undefined; allowedOrigins: readonly string[] }): boolean {
  if (o.method === "GET" || o.method === "HEAD") return true;
  if (!o.cookieToken || !o.headerToken || o.cookieToken.length < 16 || !safeEqual(o.cookieToken, o.headerToken)) return false;
  const source = o.origin && o.origin !== "null" ? o.origin : o.referer;
  if (!source) return true; // non-browser client: the double-submit token still had to match
  let origin: string;
  try {
    origin = new URL(source).origin;
  } catch {
    return false;
  }
  if (o.allowedOrigins.length) return o.allowedOrigins.includes(origin);
  try {
    return !!o.host && new URL(origin).host === o.host;
  } catch {
    return false;
  }
}

// ── input rules ──────────────────────────────────────────────────────────
const RESERVED = new Set(["admin", "administrator", "root", "system", "운영자", "관리자", "작가", "공식", "moderator", "staff"]);

/** 닉네임: 2–16자, 한글·영문·숫자·밑줄(_)·점(.)·하이픈(-), 공백·이모지 불가, 예약어 불가 */
export function checkNickname(raw: unknown): { ok: true; nickname: string; key: string } | { ok: false; message: string } {
  if (typeof raw !== "string") return { ok: false, message: "닉네임을 입력해 주세요." };
  const nickname = raw.normalize("NFC").trim();
  if ([...nickname].length < 2 || [...nickname].length > 16) return { ok: false, message: "닉네임은 2~16자로 정해 주세요." };
  if (!/^[\p{Script=Hangul}A-Za-z0-9_.-]+$/u.test(nickname)) return { ok: false, message: "닉네임에는 한글·영문·숫자·밑줄(_)·점(.)·하이픈(-)만 쓸 수 있습니다." };
  if (/^[._-]|[._-]$/.test(nickname)) return { ok: false, message: "닉네임은 기호로 시작하거나 끝날 수 없습니다." };
  const key = nickname.toLowerCase();
  if (RESERVED.has(key)) return { ok: false, message: "쓸 수 없는 닉네임입니다." };
  return { ok: true, nickname, key };
}

export function checkPassword(raw: unknown): { ok: true; password: string } | { ok: false; message: string } {
  if (typeof raw !== "string") return { ok: false, message: "비밀번호를 입력해 주세요." };
  if (raw.length < 8 || raw.length > 128) return { ok: false, message: "비밀번호는 8~128자로 정해 주세요." };
  return { ok: true, password: raw };
}

/** comment text: plain text only — control characters dropped, line breaks normalized, at most 2 blank lines */
export function cleanCommentBody(raw: unknown): { ok: true; body: string } | { ok: false; message: string } {
  if (typeof raw !== "string") return { ok: false, message: "내용을 입력해 주세요." };
  const body = raw
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁦-⁩]/g, "")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
  if (!body) return { ok: false, message: "내용을 입력해 주세요." };
  if ([...body].length > 1000) return { ok: false, message: "댓글은 1000자까지 쓸 수 있습니다." };
  return { ok: true, body };
}
