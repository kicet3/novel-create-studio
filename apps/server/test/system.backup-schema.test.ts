/**
 * Backups / restore in an isolated app schema (Supabase project shared with other data):
 * the JSON engine reads only the app schema, restore goes into a NEW schema, other schemas stay untouched,
 * and "auto" falls back to JSON when pg_dump fails.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite, type Extensions } from "@electric-sql/pglite";
import { migrateDatabase, pgliteTarget, plainConnection, type DbConnection } from "@ncs/db";
import { readManifest, restoreBundle, RestoreError, writeBundle } from "../src/modules/system/adapters/backup/backup-engine.js";

async function contrib(): Promise<Extensions> {
  const ext: Extensions = {};
  try {
    ext.btree_gist = (await import("@electric-sql/pglite/contrib/btree_gist")).btree_gist;
    ext.pg_trgm = (await import("@electric-sql/pglite/contrib/pg_trgm")).pg_trgm;
  } catch {
    /* optional */
  }
  return ext;
}

const conn = (schema: string): DbConnection => ({
  ...plainConnection("postgres://postgres@localhost:5432/postgres"),
  provider: "supabase",
  schema,
  searchPath: `"${schema}", "extensions"`,
});

const publicRows = async (pg: PGlite) => (await pg.query<{ id: number; name: string }>(`SELECT id, name FROM public.existing_things ORDER BY id`)).rows;

describe("backup engine with an isolated app schema", () => {
  it("dumps only the app schema, restores into a new schema, never touches public", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ncs-bkp-schema-"));
    const pg = await PGlite.create({ extensions: await contrib() });
    try {
      await pg.exec(`
        CREATE SCHEMA extensions;
        CREATE TABLE public.existing_things (id int PRIMARY KEY, name text);
        INSERT INTO public.existing_things VALUES (1, 'keep me');
        CREATE TABLE public.novels (id text PRIMARY KEY, title text);
        INSERT INTO public.novels VALUES ('other-app', 'not ours');
        SET search_path = "ncs", "extensions";
      `);
      const target = pgliteTarget(pg);
      await migrateDatabase(target, conn("ncs"), { appVersion: "test" });
      await pg.exec(`INSERT INTO users (id, display_name) VALUES ('usr_01ARZ3NDEKTSV4RRFFQ69G5FAV', 'owner')`);

      const failingTool = { path: "/nonexistent/pg_dump", version: "17.0", major: 99 };
      const bundleDir = join(dir, "b1");
      const { manifest } = await writeBundle({
        target,
        bundleDir,
        storageRoot: join(dir, "files"),
        backupId: "bkp_01TEST",
        trigger: "manual",
        mode: "full",
        appVersion: "test",
        now: new Date(),
        engine: "auto",
        databaseUrl: "postgres://postgres@localhost:5432/postgres",
        connection: conn("ncs"),
        pgDumpTool: failingTool,
      });
      // pg_dump could not run → json fallback, app schema only
      expect(manifest.engine).toBe("json");
      expect(manifest.dbSchema).toBe("ncs");
      const tables = Object.keys((await readManifest(bundleDir)).db?.tables ?? {});
      expect(tables).toContain("novels");
      expect(tables).not.toContain("existing_things");
      expect(manifest.novelIds).not.toContain("other-app");

      // restore into the CURRENT schema is refused (not empty)
      await expect(restoreBundle({ target, bundleDir, appVersion: "test", connection: conn("ncs") })).rejects.toBeInstanceOf(RestoreError);

      // restore into a new schema of the same database
      await pg.exec(`SET search_path = "ncs_restore", "extensions"`);
      const res = await restoreBundle({ target, bundleDir, appVersion: "test", connection: conn("ncs_restore"), requireExtensions: ["btree_gist"] });
      expect(res.engine).toBe("json");
      const restored = (await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM ncs_restore.users`)).rows[0]!.n;
      const original = (await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM ncs.users`)).rows[0]!.n;
      expect(restored).toBe(original);

      expect(await publicRows(pg)).toEqual([{ id: 1, name: "keep me" }]);
      expect((await pg.query(`SELECT id FROM public.novels`)).rows).toEqual([{ id: "other-app" }]);
      const publicTables = (await pg.query<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).rows.map((r) => r.t);
      expect(publicTables).toEqual(["existing_things", "novels"]);
    } finally {
      await pg.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
