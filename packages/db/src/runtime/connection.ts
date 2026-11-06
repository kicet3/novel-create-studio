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

export type Schema = typeof schema;
/** Driver-agnostic drizzle type: works with both postgres.js (runtime) and PGlite (tests). */
export type NcsDb = PgDatabase<PgQueryResultHKT, Schema>;
export type NcsPostgresDb = PostgresJsDatabase<Schema>;

export interface DbHandle {
  db: NcsPostgresDb;
  sql: Sql;
  url: string;
  close(): Promise<void>;
}

export interface CreateDbOptions {
  max?: number;
  /** statement_timeout in ms (00 §7.2 db.statement_timeout_ms) */
  statementTimeoutMs?: number;
  onNotice?: (msg: string) => void;
}

export function createDb(url: string, opts: CreateDbOptions = {}): DbHandle {
  const sql = postgres(url, {
    max: opts.max ?? 10,
    onnotice: (n) => opts.onNotice?.(String(n.message ?? n)),
    connection: opts.statementTimeoutMs ? { statement_timeout: opts.statementTimeoutMs } : {},
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
    url,
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
}

export async function openDatabase(config: InstallConfig, opts: OpenDatabaseOptions): Promise<OpenedDatabase> {
  let embedded: EmbeddedPostgresRuntime | null = null;
  let url: string;
  if (config.database.mode === "external") {
    if (!config.database.url) throw new Error("database.mode=external requires database.url / DATABASE_URL");
    url = config.database.url;
  } else {
    embedded = new EmbeddedPostgresRuntime({
      dataDir: resolveEmbeddedDataDir(config),
      port: config.database.embedded_port,
      onLog: (m) => opts.log?.(`[pg] ${m}`.trimEnd()),
      onError: (m) => opts.log?.(`[pg:err] ${String(m)}`.trimEnd()),
    });
    await embedded.start();
    url = embedded.url;
  }
  const handle = createDb(url, { statementTimeoutMs: 30_000 });
  let migrations: RunMigrationsResult | null = null;
  try {
    if (opts.migrate ?? config.database.auto_migrate) {
      migrations = await runMigrations(postgresJsTarget(handle.sql), {
        appVersion: opts.appVersion,
        requireExtensions: ["btree_gist"],
        log: opts.log,
      });
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
    async close() {
      await handle.close();
      await embedded?.stop();
    },
  };
}
