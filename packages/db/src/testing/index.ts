/**
 * Test helpers: a fresh, fully migrated in-process PostgreSQL (PGlite) per call.
 *
 * Migrations are applied once to a template instance per worker; each createTestDb() clones it
 * (fast). btree_gist / pg_trgm contrib are loaded when the PGlite build provides them; when an
 * extension cannot be loaded the migration's guarded blocks skip the dependent constraints and
 * `extensions` tells the test which ones are active.
 */
import { PGlite, type Extensions } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "../schema/index.js";
import { loadMigrations, runMigrations, type MigrationFile } from "../migrate/runner.js";
import { pgliteTarget } from "../migrate/targets.js";

export interface TestDb {
  db: PgliteDatabase<typeof schema>;
  pg: PGlite;
  /** extensions installed in the database (e.g. ["btree_gist", "pg_trgm", "plpgsql"]) */
  extensions: string[];
  exec(sql: string): Promise<void>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

async function loadContrib(): Promise<Extensions> {
  const ext: Extensions = {};
  try {
    const m = await import("@electric-sql/pglite/contrib/btree_gist");
    ext.btree_gist = m.btree_gist;
  } catch {
    /* not available in this PGlite build */
  }
  try {
    const m = await import("@electric-sql/pglite/contrib/pg_trgm");
    ext.pg_trgm = m.pg_trgm;
  } catch {
    /* optional */
  }
  return ext;
}

let template: Promise<PGlite> | null = null;

async function buildTemplate(migrations?: MigrationFile[]): Promise<PGlite> {
  const extensions = await loadContrib();
  let pg: PGlite;
  try {
    pg = await PGlite.create({ extensions });
  } catch {
    pg = await PGlite.create();
  }
  await runMigrations(pgliteTarget(pg), { appVersion: "test", migrations: migrations ?? loadMigrations() });
  return pg;
}

export interface CreateTestDbOptions {
  /** custom migration list (bypasses the shared template) */
  migrations?: MigrationFile[];
}

export async function createTestDb(opts: CreateTestDbOptions = {}): Promise<TestDb> {
  let pg: PGlite;
  if (opts.migrations) {
    pg = await buildTemplate(opts.migrations);
  } else {
    template ??= buildTemplate();
    pg = (await (await template).clone()) as PGlite;
  }
  const db = drizzle({ client: pg, schema });
  const ext = await pg.query<{ extname: string }>("SELECT extname FROM pg_extension ORDER BY extname");
  return {
    db,
    pg,
    extensions: ext.rows.map((r) => r.extname),
    exec: async (sql) => {
      await pg.exec(sql);
    },
    query: async <T>(sql: string, params: unknown[] = []) => (await pg.query(sql, params)).rows as T[],
    close: () => pg.close(),
  };
}

export { seedNovel, seedUser, seedArc, type SeededNovel } from "./seed.js";
