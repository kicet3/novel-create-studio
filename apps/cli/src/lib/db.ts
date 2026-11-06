/** Raw DB access for CLI commands that must not boot the full server core (migrate, restore). */
import { createDb, EmbeddedPostgresRuntime, postgresJsTarget, type DbHandle, type MigrationTarget } from "@ncs/db";
import type { InstallConfig } from "@ncs/shared";
import { embeddedDataDir } from "./config.js";

export interface RawDb {
  mode: "embedded" | "external";
  url: string;
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
  let url: string;
  if (config.database.mode === "external") {
    if (!config.database.url) throw new Error("database.mode=external 인데 database.url(DATABASE_URL)이 없습니다.");
    url = config.database.url;
  } else {
    embedded = embeddedRuntime(config);
    if (opts.start ?? true) await embedded.start();
    url = embedded.url;
  }
  const handle = createDb(url, { max: 2 });
  return {
    mode: embedded ? "embedded" : "external",
    url,
    handle,
    target: postgresJsTarget(handle.sql),
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
