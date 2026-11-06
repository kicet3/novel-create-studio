/**
 * External DB connection resolution (plain PostgreSQL or Supabase).
 *
 * Supabase (supabase.com/docs/guides/database/connecting-to-postgres):
 * - direct `db.<ref>.supabase.co:5432` (IPv6 unless the IPv4 add-on) or the Supavisor session pooler
 *   `<cluster>.pooler.supabase.com:5432` (IPv4, user `postgres.<ref>`) — both keep a session, which this app needs
 *   (session advisory lock `instance_lock`, prepared statements);
 * - the transaction pooler (port 6543) drops session state → refused at boot;
 * - TLS: `sslmode=require` at least; verify-full with the downloadable CA (`ssl_ca_file`);
 * - the `public` schema is exposed through the Data API (PostgREST) → app objects live in a dedicated schema
 *   (default `ncs`) selected by the connection `search_path` = `<app schema>, <extensions schema>` only.
 *
 * Nothing here logs or returns the password: use `maskDatabaseUrl` / `redactDatabaseSecrets` for any output.
 */
import { readFileSync } from "node:fs";
import type { ConnectionOptions } from "node:tls";
import { databaseUrlHost, isSupabaseHost, type InstallConfig } from "@ncs/shared/config";

export type DatabaseProvider = "postgres" | "supabase";
/** how the URL reaches Postgres: direct server, Supavisor session / transaction pooler (null = unknown / not Supabase) */
export type PoolerMode = "direct" | "session" | "transaction" | null;
export type SslMode = "disable" | "allow" | "prefer" | "require" | "verify-ca" | "verify-full";

export const SUPABASE_DEFAULT_SCHEMA = "ncs";
export const SUPABASE_DEFAULT_POOL_MAX = 5;
export const DEFAULT_POOL_MAX = 10;
export const SUPABASE_TRANSACTION_POOLER_PORT = 6543;

export class DatabaseConfigError extends Error {
  constructor(
    message: string,
    readonly code: "transaction_pooler" | "public_schema" | "bad_url" | "ssl_ca" | "search_path" | "schema_foreign" | "extension",
  ) {
    super(message);
    this.name = "DatabaseConfigError";
  }
}

/** Everything needed to open (and describe) one DB connection. `url` carries the password: never log it. */
export interface DbConnection {
  url: string;
  provider: DatabaseProvider;
  /** dedicated app schema (null = the server's default search_path, i.e. public — embedded / plain external) */
  schema: string | null;
  /** schema where missing extensions are created (and that follows the app schema in search_path) */
  extensionsSchema: string;
  /** exact `search_path` sent at connect (null = server default) */
  searchPath: string | null;
  /** postgres.js `ssl` option (undefined = postgres.js reads `sslmode` from the URL / default off) */
  ssl: boolean | "require" | "allow" | "prefer" | "verify-full" | ConnectionOptions | undefined;
  /** effective TLS mode for display / libpq tools */
  sslMode: SslMode | null;
  sslCaFile: string | null;
  poolMax: number;
  pooler: PoolerMode;
  /** `user@host:port/db` with the user kept and the password removed (display only) */
  display: string;
  host: string | null;
  port: number | null;
}

/** Display-safe form `postgres://user:****@host:port/db` (query string dropped). */
export function maskDatabaseUrl(url: string): string {
  try {
    const u = new URL(url);
    const user = u.username ? `${maskRef(safeDecode(u.username))}${u.password ? ":****" : ""}@` : "";
    const host = maskHost(u.hostname.replace(/^\[|\]$/g, "")) ?? "";
    return `${u.protocol}//${user}${host.includes(":") ? `[${host}]` : host}${u.port ? `:${u.port}` : ""}${u.pathname}`;
  } catch {
    return "<잘못된 DB URL>";
  }
}

/** Remove the URL and its password (raw and percent-decoded) from any text before it is shown or logged. */
export function redactDatabaseSecrets(text: string, url: string | null | undefined): string {
  if (!url) return text;
  let out = text.split(url).join(maskDatabaseUrl(url));
  try {
    const u = new URL(url);
    for (const p of new Set([u.password, safeDecode(u.password)])) if (p && p.length >= 3) out = out.split(p).join("****");
  } catch {
    /* unparsable: nothing else to redact */
  }
  return out;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function detectProvider(url: string, explicit?: DatabaseProvider): DatabaseProvider {
  return explicit ?? (isSupabaseHost(databaseUrlHost(url)) ? "supabase" : "postgres");
}

export function portOf(url: string): number | null {
  try {
    const u = new URL(url);
    return u.port ? Number(u.port) : 5432;
  } catch {
    return null;
  }
}

export function detectPoolerMode(url: string, provider: DatabaseProvider): PoolerMode {
  const host = databaseUrlHost(url);
  const port = portOf(url);
  if (port === SUPABASE_TRANSACTION_POOLER_PORT && (provider === "supabase" || isSupabaseHost(host))) return "transaction";
  if (/[?&]pgbouncer=true\b/i.test(url)) return "transaction";
  if (!host || !isSupabaseHost(host)) return null;
  return /\.pooler\.supabase\.com$/.test(host) ? "session" : "direct";
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

export interface ResolveConnectionOptions {
  /** read the CA file (tests) */
  readFile?: (path: string) => Buffer | string;
}

/**
 * Resolve `config.database` (external mode) into connection options. Throws DatabaseConfigError for a
 * transaction-pooler URL, Supabase + public schema (unless allowed) or an unreadable CA file.
 */
export function resolveExternalConnection(database: InstallConfig["database"], opts: ResolveConnectionOptions = {}): DbConnection {
  const url = database.url;
  if (!url) throw new DatabaseConfigError("database.mode=external 은 database.url(DATABASE_URL)이 필요합니다.", "bad_url");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DatabaseConfigError("DATABASE_URL 을 해석할 수 없습니다. postgresql://user:password@host:5432/postgres 형식인지, 비밀번호의 특수 문자를 퍼센트 인코딩했는지 확인하세요.", "bad_url");
  }
  const provider = detectProvider(url, database.provider);
  const pooler = detectPoolerMode(url, provider);
  if (pooler === "transaction") {
    throw new DatabaseConfigError(
      "Supabase 트랜잭션 풀러(포트 6543)는 쓸 수 없습니다: 이 앱은 세션 advisory lock 과 prepared statement 를 써서 세션이 유지되는 연결이 필요합니다. " +
        "Supabase 대시보드 Connect 의 Direct connection(db.<ref>.supabase.co:5432, IPv6) 또는 Session pooler(<region>.pooler.supabase.com:5432, IPv4, 사용자 postgres.<ref>) 주소를 쓰세요.",
      "transaction_pooler",
    );
  }
  const supabase = provider === "supabase";
  const schema = database.schema ?? (supabase ? SUPABASE_DEFAULT_SCHEMA : null);
  if (supabase && schema === "public" && !database.allow_public_schema) {
    throw new DatabaseConfigError(
      "Supabase 에서는 public 스키마에 앱 테이블을 만들지 않습니다(Data API 로 노출됨). NCS_DB_SCHEMA 를 비우거나(기본 ncs) 다른 이름을 쓰세요. 꼭 public 을 쓰려면 NCS_DB_ALLOW_PUBLIC_SCHEMA=1.",
      "public_schema",
    );
  }
  const extensionsSchema = database.extensions_schema ?? "extensions";
  const searchPath = schema ? (schema === extensionsSchema ? quoteIdent(schema) : `${quoteIdent(schema)}, ${quoteIdent(extensionsSchema)}`) : null;

  // TLS: CA file → verify-full; explicit sslmode in the URL wins otherwise; Supabase defaults to require
  const urlMode = (parsed.searchParams.get("sslmode") ?? "").toLowerCase() as SslMode | "";
  let ssl: DbConnection["ssl"];
  let sslMode: SslMode | null = urlMode || null;
  const caFile = database.ssl_ca_file ?? null;
  if (caFile) {
    let ca: Buffer | string;
    try {
      ca = (opts.readFile ?? readFileSync)(caFile);
    } catch (err) {
      throw new DatabaseConfigError(`DB TLS CA 파일을 읽을 수 없습니다(${caFile}): ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`, "ssl_ca");
    }
    ssl = { ca, rejectUnauthorized: true, servername: parsed.hostname.replace(/^\[|\]$/g, "") || undefined };
    sslMode = "verify-full";
  } else if (urlMode) {
    // postgres.js reads sslmode from the URL; Supabase never downgrades below require except an explicit `disable`
    // (local `supabase start` stack has no TLS)
    if (supabase && (urlMode === "allow" || urlMode === "prefer")) {
      ssl = "require";
      sslMode = "require";
    } else ssl = undefined;
  } else if (supabase) {
    ssl = "require";
    sslMode = "require";
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "") || null;
  const port = parsed.port ? Number(parsed.port) : 5432;
  return {
    url,
    provider,
    schema,
    extensionsSchema,
    searchPath,
    ssl,
    sslMode,
    sslCaFile: caFile,
    poolMax: database.pool_max ?? (supabase ? SUPABASE_DEFAULT_POOL_MAX : DEFAULT_POOL_MAX),
    pooler,
    display: maskDatabaseUrl(url),
    host,
    port,
  };
}

/** Connection for an embedded / ad-hoc URL (no schema isolation, server defaults). */
export function plainConnection(url: string, poolMax = DEFAULT_POOL_MAX): DbConnection {
  let host: string | null = null;
  let port: number | null = null;
  try {
    const u = new URL(url);
    host = u.hostname || null;
    port = u.port ? Number(u.port) : 5432;
  } catch {
    /* keep nulls */
  }
  return {
    url,
    provider: "postgres",
    schema: null,
    extensionsSchema: "extensions",
    searchPath: null,
    ssl: undefined,
    sslMode: null,
    sslCaFile: null,
    poolMax,
    pooler: null,
    display: maskDatabaseUrl(url),
    host,
    port,
  };
}

export const asConnection = (c: string | DbConnection): DbConnection => (typeof c === "string" ? plainConnection(c) : c);

/** postgres.js options derived from a connection (pool size, TLS, search_path startup parameter). */
export function postgresJsOptions(conn: DbConnection): { ssl?: DbConnection["ssl"]; connection: Record<string, string> } {
  const out: { ssl?: DbConnection["ssl"]; connection: Record<string, string> } = { connection: {} };
  if (conn.ssl !== undefined) out.ssl = conn.ssl;
  if (conn.searchPath) {
    out.connection.search_path = conn.searchPath;
    // the same setting via `options` too: some poolers (Supavisor) read search_path from there. Schema names are
    // validated ([a-z_][a-z0-9_]*), so the unquoted, space-free form is exact.
    if (conn.schema) out.connection.options = `-c search_path=${conn.schema === conn.extensionsSchema ? conn.schema : `${conn.schema},${conn.extensionsSchema}`}`;
  }
  return out;
}

/** Environment for libpq tools (pg_dump / pg_restore): TLS mode + CA; the password goes via PGPASSWORD elsewhere. */
export function libpqEnv(conn: DbConnection): Record<string, string> {
  const env: Record<string, string> = {};
  if (conn.sslCaFile) {
    env.PGSSLMODE = "verify-full";
    env.PGSSLROOTCERT = conn.sslCaFile;
  } else if (conn.sslMode) env.PGSSLMODE = conn.sslMode;
  return env;
}

/** Public, password-free description (system info / health / doctor). */
export interface DatabaseDescription {
  provider: DatabaseProvider;
  host: string | null;
  port: number | null;
  schema: string | null;
  pooler: PoolerMode;
  sslMode: SslMode | null;
  poolMax: number;
}

export function describeConnection(conn: DbConnection): DatabaseDescription {
  return { provider: conn.provider, host: maskHost(conn.host), port: conn.port, schema: conn.schema, pooler: conn.pooler, sslMode: conn.sslMode, poolMax: conn.poolMax };
}

/** `db.abcdefghijkl.supabase.co` → `db.abc…ijkl.supabase.co`: enough to recognise the project, not to copy it. */
export function maskHost(host: string | null): string | null {
  if (!host) return null;
  return host.replace(/^(db\.)([a-z0-9]{12,})(\.supabase\.co)$/i, (_m, pre: string, ref: string, suf: string) => `${pre}${shortRef(ref)}${suf}`);
}

const shortRef = (ref: string) => `${ref.slice(0, 3)}…${ref.slice(-4)}`;
/** Supavisor user `postgres.<project ref>` → `postgres.abc…wxyz` */
const maskRef = (user: string) => user.replace(/^([a-z_][a-z0-9_]*\.)([a-z0-9]{12,})$/i, (_m, pre: string, ref: string) => `${pre}${shortRef(ref)}`);
