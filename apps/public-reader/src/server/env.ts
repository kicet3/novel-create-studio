/**
 * snowpage environment (server only). Names are fixed (README / Vercel project settings):
 *
 *   DATABASE_URL (fallback POSTGRES_URL)  restricted reader role → Supabase transaction pooler (required at runtime)
 *   DB_SCHEMA            public schema the studio syncs into (default ncs_public)
 *   PUBLIC_ORIGIN        canonical origin, CSRF Origin check (default https://novel.snowlink.team)
 *   ADMIN_TOKEN          ≥ 24 chars; unset / too short → /admin disabled
 *   IP_HASH_SECRET       ≥ 32 chars; required for anonymous writes (likes / ratings / comments)
 *   COOKIE_SECURE        default true (Secure + __Host- cookies); false only for http://localhost dev
 *   BANNED_WORDS         optional comma list → matching comments are held (hidden)
 *   ALLOW_PREVIEW_ORIGINS default false; true also accepts https://*.vercel.app origins (preview deployments)
 *
 * Problems are reported by variable NAME only — never with the value.
 */
import { isSafeSchemaName, PUBLIC_SCHEMA_DEFAULT } from "@ncs/public-schema";

export const DEFAULT_PUBLIC_ORIGIN = "https://novel.snowlink.team";
export const ADMIN_TOKEN_MIN = 24;
export const IP_HASH_SECRET_MIN = 32;

export interface ReaderEnv {
  databaseUrl: string | null;
  schema: string;
  publicOrigin: string;
  adminToken: string | null;
  ipHashSecret: string | null;
  cookieSecure: boolean;
  bannedWords: string[];
  allowPreviewOrigins: boolean;
  /** human-readable problems (Korean, variable names only) */
  problems: string[];
}

export class EnvError extends Error {
  constructor(readonly problems: string[]) {
    super(`snowpage 환경 변수 설정을 확인하세요: ${problems.join(" / ")}`);
    this.name = "EnvError";
  }
}

type Env = Record<string, string | undefined>;

const bool = (v: string | undefined, dflt: boolean, name: string, problems: string[]): boolean => {
  if (v === undefined || v.trim() === "") return dflt;
  const s = v.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  problems.push(`${name} 는 true 또는 false 여야 합니다(기본값 ${dflt} 사용).`);
  return dflt;
};

function originOf(v: string | undefined, problems: string[]): string {
  const raw = v?.trim();
  if (!raw) return DEFAULT_PUBLIC_ORIGIN;
  try {
    const u = new URL(raw);
    if ((u.protocol === "https:" || u.protocol === "http:") && (u.pathname === "/" || u.pathname === "") && !u.search && !u.hash && !u.username && !u.password) return u.origin;
  } catch {
    /* reported below */
  }
  problems.push(`PUBLIC_ORIGIN 은 https://도메인 형태의 출처(경로 없음)여야 합니다(기본값 ${DEFAULT_PUBLIC_ORIGIN} 사용).`);
  return DEFAULT_PUBLIC_ORIGIN;
}

export function parseEnv(env: Env): ReaderEnv {
  const problems: string[] = [];
  let databaseUrl = env.DATABASE_URL?.trim() || env.POSTGRES_URL?.trim() || null;
  if (!databaseUrl) problems.push("DATABASE_URL(또는 POSTGRES_URL)이 없습니다 — 작품을 읽을 수 없습니다.");
  else if (!/^postgres(ql)?:\/\/\S+$/.test(databaseUrl)) {
    problems.push("DATABASE_URL 은 postgresql:// 로 시작해야 합니다.");
    databaseUrl = null;
  }
  let schema = env.DB_SCHEMA?.trim() || PUBLIC_SCHEMA_DEFAULT;
  if (!isSafeSchemaName(schema)) {
    problems.push(`DB_SCHEMA 가 올바른 스키마 이름이 아닙니다(영문 소문자·숫자·밑줄, 예약 스키마 불가) — 기본값 ${PUBLIC_SCHEMA_DEFAULT} 사용.`);
    schema = PUBLIC_SCHEMA_DEFAULT;
  }
  let adminToken = env.ADMIN_TOKEN?.trim() || null;
  if (adminToken && adminToken.length < ADMIN_TOKEN_MIN) {
    problems.push(`ADMIN_TOKEN 이 ${ADMIN_TOKEN_MIN}자보다 짧아 운영 화면을 껐습니다.`);
    adminToken = null;
  }
  let ipHashSecret = env.IP_HASH_SECRET?.trim() || null;
  if (!ipHashSecret) problems.push("IP_HASH_SECRET 이 없어 좋아요·평점·댓글 쓰기를 껐습니다.");
  else if (ipHashSecret.length < IP_HASH_SECRET_MIN) {
    problems.push(`IP_HASH_SECRET 이 ${IP_HASH_SECRET_MIN}자보다 짧아 좋아요·평점·댓글 쓰기를 껐습니다.`);
    ipHashSecret = null;
  }
  const bannedWords = (env.BANNED_WORDS ?? "")
    .split(",")
    .map((w) => normalizeForMatch(w))
    .filter((w) => w.length > 0);
  return {
    databaseUrl,
    schema,
    publicOrigin: originOf(env.PUBLIC_ORIGIN, problems),
    adminToken,
    ipHashSecret,
    cookieSecure: bool(env.COOKIE_SECURE, true, "COOKIE_SECURE", problems),
    bannedWords: [...new Set(bannedWords)],
    allowPreviewOrigins: bool(env.ALLOW_PREVIEW_ORIGINS, false, "ALLOW_PREVIEW_ORIGINS", problems),
    problems,
  };
}

/** NFKC, lowercase, no whitespace / zero-width characters (banned-word matching) */
export function normalizeForMatch(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[\s​-‍⁠﻿]+/g, "");
}

let cached: ReaderEnv | null = null;
let reported = false;

/** process env, parsed once; problems are logged once (names only) */
export function getEnv(): ReaderEnv {
  if (!cached) cached = parseEnv(process.env);
  if (!reported && cached.problems.length) {
    reported = true;
    for (const p of cached.problems) console.warn(`[snowpage] ${p}`);
  }
  return cached;
}

/** for code that needs the database */
export function requireDatabaseUrl(env: ReaderEnv): string {
  if (!env.databaseUrl) throw new EnvError(["DATABASE_URL(또는 POSTGRES_URL)을 설정하세요."]);
  return env.databaseUrl;
}
