/**
 * Writer connection to the public site database (the user's Supabase project). Small postgres.js pool, statements
 * unprepared (works through the Supabase transaction pooler too), TLS required for Supabase hosts unless the URL sets
 * `sslmode`. The URL carries the password: it is never logged — errors go through `sanitizePublicDbError`.
 */
import postgres from "postgres";
import { redactDatabaseSecrets } from "@ncs/db";
import { postgresJsSqlClient, type SqlClient } from "@ncs/public-schema";

export interface PublicDbConnection {
  client: SqlClient;
  close(): Promise<void>;
}

/** test seam: tests connect to an in-process PGlite standing in for Supabase */
export type PublicDbConnector = (url: string) => PublicDbConnection;

const isSupabaseHost = (host: string) => /(^|\.)supabase\.(co|com|net)$/i.test(host);

export function hostOfUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, "") || null;
  } catch {
    return null;
  }
}

export const postgresPublicDbConnector: PublicDbConnector = (url) => {
  let ssl: "require" | undefined;
  try {
    const u = new URL(url);
    if (!u.searchParams.get("sslmode") && isSupabaseHost(u.hostname)) ssl = "require";
  } catch {
    /* postgres.js reports a bad URL itself (sanitized by the caller) */
  }
  const sql = postgres(url, {
    prepare: false,
    max: 2,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => undefined,
    connection: { application_name: "ncs-studio-publisher" },
    ...(ssl ? { ssl } : {}),
  });
  return { client: postgresJsSqlClient(sql as never), close: () => sql.end({ timeout: 5 }) };
};

const CODE_MESSAGES: Record<string, string> = {
  ECONNREFUSED: "연결이 거부되었습니다. 주소·포트를 확인하세요.",
  ENOTFOUND: "호스트를 찾을 수 없습니다. 주소를 확인하세요.",
  EAI_AGAIN: "호스트 이름을 확인하지 못했습니다(네트워크 확인).",
  ETIMEDOUT: "연결 시간이 초과되었습니다.",
  CONNECT_TIMEOUT: "연결 시간이 초과되었습니다.",
  ECONNRESET: "연결이 끊어졌습니다.",
  "28P01": "인증에 실패했습니다. 사용자·비밀번호를 확인하세요.",
  "28000": "접속이 허용되지 않았습니다(사용자·TLS 설정 확인).",
  "3D000": "데이터베이스가 없습니다.",
  "42501": "권한이 없습니다. 쓰기 연결에는 스키마를 만들 수 있는 사용자(예: postgres)를 쓰세요.",
  "3F000": "스키마가 없습니다.",
};

/** user-facing, secret-free message for any error from the public DB path */
export function sanitizePublicDbError(err: unknown, url: string | null): string {
  const e = err as { code?: unknown; message?: unknown } | null;
  const code = typeof e?.code === "string" ? e.code : null;
  let detail = typeof e?.message === "string" ? e.message : String(err);
  detail = redactDatabaseSecrets(detail, url);
  // any other connection string that might appear (e.g. from a driver message)
  detail = detail.replace(/postgres(?:ql)?:\/\/\S+/gi, "postgresql://****").replace(/password=\S+/gi, "password=****");
  if (detail.length > 300) detail = `${detail.slice(0, 300)}…`;
  const known = code ? CODE_MESSAGES[code] : undefined;
  return `공개 사이트 DB: ${known ?? detail}${known && code ? ` (${code})` : ""}`;
}
