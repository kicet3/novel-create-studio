/**
 * Database handles.
 * - createDb(url): postgres.js pool + drizzle (typed queries) + raw `sql`
 * - openDatabase(config): resolves embedded vs external (DATABASE_URL), starts embedded PG if needed,
 *   applies migrations (database.auto_migrate) and returns a handle that also stops embedded PG on close.
 */
import postgres, { type Sql } from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { resolveEmbeddedDataDir, type InstallConfig } from "@ncs/shared/config";
import * as schema from "../schema/index.js";
import { EmbeddedPostgresRuntime } from "./embedded.js";
import { runMigrations, type RunMigrationsResult } from "../migrate/runner.js";
import { postgresJsTarget } from "../migrate/targets.js";
import type { MigrationTarget } from "../migrate/runner.js";
import { asConnection, plainConnection, postgresJsOptions, resolveExternalConnection, type DbConnection } from "./provider.js";
import { assertAppSchemaUsable, hardenAppSchema, prepareAppSchema, type AppSchemaInspection } from "./app-schema.js";

export type Schema = typeof schema;
/** Driver-agnostic drizzle type: works with both postgres.js (runtime) and PGlite (tests). */
export type NcsDb = PgDatabase<PgQueryResultHKT, Schema>;
export type NcsPostgresDb = PostgresJsDatabase<Schema>;

export interface DbHandle {
  db: NcsPostgresDb;
  sql: Sql;
  /** carries the password: never log it (use `connection.display`) */
  url: string;
  connection: DbConnection;
  close(): Promise<void>;
}

export interface CreateDbOptions {
  max?: number;
  /** statement_timeout in ms (00 §7.2 db.statement_timeout_ms) */
  statementTimeoutMs?: number;
  onNotice?: (msg: string) => void;
}

/** `target`: a URL (server defaults) or a resolved connection (TLS, app-schema search_path, pool size). */
export function createDb(target: string | DbConnection, opts: CreateDbOptions = {}): DbHandle {
  const conn = asConnection(target);
  const pg = postgresJsOptions(conn);
  const sql = postgres(conn.url, {
    max: opts.max ?? conn.poolMax,
    onnotice: (n) => opts.onNotice?.(String(n.message ?? n)),
    ...(pg.ssl !== undefined ? { ssl: pg.ssl } : {}),
    connection: { ...pg.connection, ...(opts.statementTimeoutMs ? { statement_timeout: opts.statementTimeoutMs } : {}) },
  });
  const db = drizzle(sql, { schema });
  // drizzle makes the date/time serializers transparent (columns map Date → string themselves), so a Date
  // interpolated into a raw sql`` fragment would reach postgres.js as an object and fail. Serialize it here.
  const dateSerializer = (v: unknown) => (v instanceof Date ? v.toISOString() : v);
  for (const type of ["1184", "1082", "1083", "1114", "1182", "1185", "1115", "1231"]) {
    (sql.options.serializers as Record<string, (v: unknown) => unknown>)[type] = dateSerializer;
  }
  return {
    db,
    sql,
    url: conn.url,
    connection: conn,
    close: () => sql.end({ timeout: 5 }),
  };
}

export interface OpenDatabaseOptions {
  appVersion: string;
  migrate?: boolean;
  log?: (msg: string) => void;
}

export interface OpenedDatabase extends DbHandle {
  mode: "embedded" | "external";
  embedded: EmbeddedPostgresRuntime | null;
  migrations: RunMigrationsResult | null;
  /** external DBs: target-schema inspection done at open (search_path applied, schema empty or the app's) */
  schemaInspection: AppSchemaInspection | null;
}

/** The configured DB's connection (external: resolved + validated; embedded: needs the runtime's URL). */
export function resolveDatabaseConnection(config: InstallConfig, embeddedUrl?: string): DbConnection {
  if (config.database.mode === "external") return resolveExternalConnection(config.database);
  if (!embeddedUrl) throw new Error("embedded database URL is required");
  return plainConnection(embeddedUrl, config.database.pool_max ?? 10);
}

export interface MigrateDatabaseOptions {
  appVersion: string;
  log?: (msg: string) => void;
  /** runs after the app schema exists and before migrations (e.g. the `pre_migration` backup) */
  beforeMigrations?: () => Promise<void>;
}

/** prepare the app schema (external) → migrations → privileges hardening. The one migration path for every caller. */
export async function migrateDatabase(target: MigrationTarget, conn: DbConnection, opts: MigrateDatabaseOptions): Promise<RunMigrationsResult> {
  const isolated = !!conn.schema;
  if (isolated) await prepareAppSchema(target, conn, opts.log);
  await opts.beforeMigrations?.();
  const result = await runMigrations(target, { appVersion: opts.appVersion, requireExtensions: ["btree_gist"], log: opts.log });
  if (isolated) await hardenAppSchema(target, conn, opts.log);
  return result;
}

export async function openDatabase(config: InstallConfig, opts: OpenDatabaseOptions): Promise<OpenedDatabase> {
  let embedded: EmbeddedPostgresRuntime | null = null;
  let conn: DbConnection;
  if (config.database.mode === "external") {
    conn = resolveDatabaseConnection(config);
  } else {
    embedded = new EmbeddedPostgresRuntime({
      dataDir: resolveEmbeddedDataDir(config),
      port: config.database.embedded_port,
      onLog: (m) => opts.log?.(`[pg] ${m}`.trimEnd()),
      onError: (m) => opts.log?.(`[pg:err] ${String(m)}`.trimEnd()),
    });
    await embedded.start();
    conn = resolveDatabaseConnection(config, embedded.url);
  }
  const handle = createDb(conn, { statementTimeoutMs: 30_000 });
  let migrations: RunMigrationsResult | null = null;
  let schemaInspection: AppSchemaInspection | null = null;
  try {
    const target = postgresJsTarget(handle.sql);
    if (config.database.mode === "external") schemaInspection = await assertAppSchemaUsable(target, conn);
    if (opts.migrate ?? config.database.auto_migrate) {
      migrations = await migrateDatabase(target, conn, { appVersion: opts.appVersion, log: opts.log });
    }
  } catch (err) {
    await handle.close();
    await embedded?.stop();
    throw err;
  }
  return {
    ...handle,
    mode: embedded ? "embedded" : "external",
    embedded,
    migrations,
    schemaInspection,
    async close() {
      await handle.close();
      await embedded?.stop();
    },
  };
}
