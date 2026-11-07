/**
 * Identifiers of the public schema. The schema and role names are interpolated into SQL (DDL cannot take bind
 * parameters), so they are validated against a strict pattern AND always double-quoted.
 */

export const PUBLIC_SCHEMA_DEFAULT = "ncs_public";
export const PUBLIC_READER_ROLE_DEFAULT = "ncs_public_reader";

/** lowercase letter or `_` first, then lowercase letters, digits, `_`; at most 63 bytes (PostgreSQL NAMEDATALEN - 1) */
export const SAFE_IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Schemas that belong to PostgreSQL or Supabase (or are exposed by its Data API by default): the public site must
 * never put its tables there, and must never touch them.
 */
const RESERVED_SCHEMAS = new Set([
  "public",
  "information_schema",
  "auth",
  "storage",
  "extensions",
  "graphql",
  "graphql_public",
  "realtime",
  "vault",
  "pgbouncer",
  "pgsodium",
  "pgsodium_masks",
  "net",
  "cron",
  "supabase_functions",
  "supabase_migrations",
  "_realtime",
  "_analytics",
  "pgmq",
  "pgmq_public",
]);

export function isSafeSchemaName(s: unknown): s is string {
  return typeof s === "string" && SAFE_IDENT_RE.test(s) && !s.startsWith("pg_") && !s.startsWith("supabase") && !RESERVED_SCHEMAS.has(s);
}

const RESERVED_ROLES = new Set(["postgres", "anon", "authenticated", "service_role", "authenticator", "public", "supabase_admin", "dashboard_user", "pgbouncer"]);

export function isSafeRoleName(s: unknown): s is string {
  return typeof s === "string" && SAFE_IDENT_RE.test(s) && !s.startsWith("pg_") && !s.startsWith("supabase") && !RESERVED_ROLES.has(s);
}

export class PublicSchemaNameError extends Error {
  constructor(readonly what: "schema" | "role", value: string) {
    super(
      what === "schema"
        ? `공개 사이트 스키마 이름이 올바르지 않습니다(${JSON.stringify(value.slice(0, 80))}): 영문 소문자·숫자·밑줄(_), 63자 이내, public·auth·storage 등 Supabase/PostgreSQL 예약 스키마는 쓸 수 없습니다.`
        : `역할 이름이 올바르지 않습니다(${JSON.stringify(value.slice(0, 80))}): 영문 소문자·숫자·밑줄(_), 63자 이내, postgres·anon·authenticated 등 예약 역할은 쓸 수 없습니다.`,
    );
  }
}

export function assertSchemaName(s: string): string {
  if (!isSafeSchemaName(s)) throw new PublicSchemaNameError("schema", String(s));
  return s;
}

export function assertRoleName(s: string): string {
  if (!isSafeRoleName(s)) throw new PublicSchemaNameError("role", String(s));
  return s;
}

/** SQL identifier quoting ("" doubles an embedded quote). Callers validate first; this is the second fence. */
export function quoteIdent(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/** SQL string literal quoting ('' doubles an embedded quote) */
export function quoteLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
