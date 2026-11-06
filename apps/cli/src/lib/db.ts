/** Raw DB access for CLI commands that must not boot the full server core (migrate, restore). */
import {
  assertAppSchemaUsable,
  createDb,
  EmbeddedPostgresRuntime,
  postgresJsTarget,
  resolveDatabaseConnection,
  type AppSchemaInspection,
  type DbConnection,
  type DbHandle,
  type MigrationTarget,
} from "@ncs/db";
import type { InstallConfig } from "@ncs/shared";
import { embeddedDataDir } from "./config.js";

export interface RawDb {
  mode: "embedded" | "external";
  /** carries the password: never print it (use `connection.display`) */
  url: string;
  connection: DbConnection;
  /** external DBs: target schema checked (search_path applied, schema empty or the app's) */
  schemaInspection: AppSchemaInspection | null;
  handle: DbHandle;
  target: MigrationTarget;
  embedded: EmbeddedPostgresRuntime | null;
  close(): Promise<void>;
}

export function embeddedRuntime(config: InstallConfig, opts: { dataDir?: string; database?: string } = {}): EmbeddedPostgresRuntime {
  return new EmbeddedPostgresRuntime({ dataDir: opts.dataDir ?? embeddedDataDir(config), port: config.database.embedded_port, database: opts.database });
}

/** Replace the database name of a postgres URL. */
export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${encodeURIComponent(database)}`;
  return u.toString();
}

export function databaseNameOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, "")) || "postgres";
}

/** Open the configured DB without migrating. Embedded PG is started (or attached) as needed. */
export async function openRawDb(config: InstallConfig, opts: { start?: boolean } = {}): Promise<RawDb> {
  let embedded: EmbeddedPostgresRuntime | null = null;
  let conn: DbConnection;
  if (config.database.mode === "external") {
    if (!config.database.url) throw new Error("database.mode=external 인데 database.url(DATABASE_URL)이 없습니다.");
    conn = resolveDatabaseConnection(config);
  } else {
    embedded = embeddedRuntime(config);
    if (opts.start ?? true) await embedded.start();
    conn = resolveDatabaseConnection(config, embedded.url);
  }
  const handle = createDb(conn, { max: 2 });
  const target = postgresJsTarget(handle.sql);
  let schemaInspection: AppSchemaInspection | null = null;
  if (config.database.mode === "external") {
    try {
      schemaInspection = await assertAppSchemaUsable(target, conn);
    } catch (err) {
      await handle.close();
      await embedded?.stop();
      throw err;
    }
  }
  return {
    mode: embedded ? "embedded" : "external",
    url: conn.url,
    connection: conn,
    schemaInspection,
    handle,
    target,
    embedded,
    async close() {
      await handle.close();
      await embedded?.stop();
    },
  };
}

export async function withAdmin<T>(url: string, fn: (sql: DbHandle["sql"]) => Promise<T>): Promise<T> {
  const h = createDb(withDatabase(url, "postgres"), { max: 1 });
  try {
    return await fn(h.sql);
  } finally {
    await h.close();
  }
}

export const qi = (name: string) => `"${name.replace(/"/g, '""')}"`;
