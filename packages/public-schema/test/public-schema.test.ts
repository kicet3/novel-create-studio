/**
 * Public schema (Supabase stand-in: an in-process PGlite with unrelated objects already in it):
 * migrations are idempotent and confined to the schema, RLS is on everywhere with no policies, content tables carry
 * only allow-listed columns, and the generated restricted-role SQL quotes identifiers and grants exactly what the
 * reader API needs.
 */
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PUBLIC_ALL_TABLES,
  PUBLIC_EPISODE_COLUMNS,
  PUBLIC_NOVEL_COLUMNS,
  PUBLIC_SCHEMA_LATEST_VERSION,
  ROLE_PASSWORD_PLACEHOLDER,
  applyPublicSchema,
  assertSchemaName,
  buildReaderRoleSql,
  isSafeRoleName,
  isSafeSchemaName,
  pgliteSqlClient,
  publicSchemaVersion,
  quoteIdent,
  type SqlClient,
} from "../src/index.js";

const SCHEMA = "ncs_public_t";

/** everything outside the app schema: namespaces, relations, functions, roles, extensions, policies */
async function outside(c: SqlClient, schema: string) {
  const q = (sql: string) => c.query(sql, [schema]);
  return JSON.stringify([
    await q("SELECT nspname FROM pg_namespace WHERE nspname <> $1 ORDER BY 1"),
    await q("SELECT n.nspname, c.relname, c.relkind, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname <> $1 AND n.nspname <> 'pg_toast' ORDER BY 1, 2"),
    await q("SELECT n.nspname, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname <> $1 AND n.nspname <> 'pg_toast' ORDER BY 1, 2"),
    await q("SELECT rolname FROM pg_roles WHERE $1::text IS NOT NULL ORDER BY 1"),
    await q("SELECT extname FROM pg_extension WHERE $1::text IS NOT NULL ORDER BY 1"),
    await q("SELECT schemaname, tablename, policyname FROM pg_policies WHERE schemaname <> $1 ORDER BY 1, 2, 3"),
    await q("SELECT count(*)::int AS n FROM public.other_app WHERE $1::text IS NOT NULL"),
  ]);
}

describe("identifiers", () => {
  it("accepts plain lowercase names and rejects reserved / unsafe ones", () => {
    for (const ok of ["ncs_public", "reader_site", "_x1"]) expect(isSafeSchemaName(ok), ok).toBe(true);
    for (const bad of ["public", "auth", "storage", "extensions", "graphql_public", "realtime", "vault", "pg_temp", "supabase_x", "Bad", "a-b", "a b", 'x"; DROP SCHEMA public; --', "", "x".repeat(64), "1abc"])
      expect(isSafeSchemaName(bad), bad).toBe(false);
    for (const bad of ["postgres", "anon", "authenticated", "service_role", "authenticator", "pg_read_all_data", "Reader"]) expect(isSafeRoleName(bad), bad).toBe(false);
    expect(() => assertSchemaName("public")).toThrow(/예약/);
    expect(quoteIdent('a"b')).toBe('"a""b"');
  });
});

describe("public schema migrations", () => {
  let pg: PGlite;
  let c: SqlClient;

  beforeAll(async () => {
    pg = await PGlite.create();
    c = pgliteSqlClient(pg);
    // the user's Supabase project already has other things in it
    await pg.exec(`
      CREATE TABLE public.other_app (id int PRIMARY KEY, secret text);
      INSERT INTO public.other_app VALUES (1, 'theirs');
      CREATE SCHEMA other_schema;
      CREATE TABLE other_schema.t (x int);
      CREATE FUNCTION public.other_fn() RETURNS int LANGUAGE sql AS 'SELECT 1';
    `);
  });
  afterAll(async () => {
    await pg?.close();
  });

  it("applies once, is idempotent, and changes nothing outside its schema", async () => {
    const before = await outside(c, SCHEMA);
    expect(await publicSchemaVersion(c, SCHEMA)).toBeNull();
    const first = await applyPublicSchema(c, SCHEMA);
    expect(first).toEqual({ schema: SCHEMA, applied: [1], version: PUBLIC_SCHEMA_LATEST_VERSION });
    const second = await applyPublicSchema(c, SCHEMA);
    expect(second.applied).toEqual([]);
    expect(second.version).toBe(PUBLIC_SCHEMA_LATEST_VERSION);
    expect(await outside(c, SCHEMA)).toBe(before);
    const tables = await c.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1", [SCHEMA]);
    expect(tables.map((t) => t.table_name)).toEqual([...PUBLIC_ALL_TABLES].sort());
  });

  it("refuses an unsafe schema name before sending any SQL", async () => {
    const calls: string[] = [];
    const spy: SqlClient = { query: async (t) => (calls.push(t), []), exec: async (t) => void calls.push(t), transaction: (fn) => fn(spy) };
    await expect(applyPublicSchema(spy, "public")).rejects.toThrow();
    await expect(applyPublicSchema(spy, 'x"; DROP TABLE public.other_app; --')).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("enables RLS on every table with no policies (Supabase API roles get nothing)", async () => {
    const rls = await c.query<{ relname: string; relrowsecurity: boolean }>(
      "SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'r' ORDER BY 1",
      [SCHEMA],
    );
    expect(rls.length).toBe(PUBLIC_ALL_TABLES.length);
    for (const r of rls) expect(r.relrowsecurity, r.relname).toBe(true);
    expect(await c.query("SELECT policyname FROM pg_policies WHERE schemaname = $1", [SCHEMA])).toEqual([]);
  });

  it("content tables have only the allow-listed public columns", async () => {
    const cols = async (t: string) =>
      (await c.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY 1", [SCHEMA, t])).map((r) => r.column_name);
    expect(await cols("novels")).toEqual([...PUBLIC_NOVEL_COLUMNS].sort());
    expect(await cols("episodes")).toEqual([...PUBLIC_EPISODE_COLUMNS].sort());
  });

  it("restricted role SQL: quoted identifiers, idempotent, grants only what the reader needs", async () => {
    const snippet = buildReaderRoleSql({ schema: SCHEMA });
    expect(snippet).toContain(`PASSWORD '${ROLE_PASSWORD_PLACEHOLDER}'`);
    expect(snippet).toContain(`GRANT USAGE ON SCHEMA "${SCHEMA}" TO "ncs_public_reader";`);
    expect(snippet).toContain(`GRANT SELECT ON "${SCHEMA}".novels, "${SCHEMA}".episodes TO "ncs_public_reader";`);
    expect(snippet).toMatch(/Exposed schemas/);
    expect(snippet).not.toMatch(/GRANT[^;]*\bpublic\./);
    expect(() => buildReaderRoleSql({ schema: "public" })).toThrow();
    expect(() => buildReaderRoleSql({ schema: SCHEMA, role: "postgres" })).toThrow();
    // a quote in the password cannot break out of the literal
    expect(buildReaderRoleSql({ schema: SCHEMA, password: "a'b" })).toContain("PASSWORD 'a''b'");

    const sql = buildReaderRoleSql({ schema: SCHEMA, password: "test-only-pw-1234567890" });
    await pg.exec(sql);
    await pg.exec(sql); // re-runnable
    const policies = await c.query<{ tablename: string; cmd: string; roles: string }>("SELECT tablename, cmd, roles::text AS roles FROM pg_policies WHERE schemaname = $1 ORDER BY 1", [SCHEMA]);
    expect(policies.find((p) => p.tablename === "novels")).toMatchObject({ cmd: "SELECT", roles: "{ncs_public_reader}" });
    expect(policies.find((p) => p.tablename === "comments")).toMatchObject({ cmd: "ALL", roles: "{ncs_public_reader}" });
    expect(policies.some((p) => p.tablename === "schema_migrations")).toBe(false);

    await pg.exec(`INSERT INTO ${SCHEMA}.novels (slug, title, content_hash) VALUES ('n1', 't', 'h')`);
    await pg.exec("SET ROLE ncs_public_reader");
    try {
      expect(await c.query(`SELECT slug FROM ${SCHEMA}.novels`)).toEqual([{ slug: "n1" }]);
      await expect(c.query(`INSERT INTO ${SCHEMA}.novels (slug, title, content_hash) VALUES ('n2', 't', 'h')`)).rejects.toThrow(/permission denied/);
      await expect(c.query(`UPDATE ${SCHEMA}.episodes SET body = 'x'`)).rejects.toThrow(/permission denied/);
      await expect(c.query(`DELETE FROM ${SCHEMA}.novels`)).rejects.toThrow(/permission denied/);
      await c.query(`INSERT INTO ${SCHEMA}.visitors (id) VALUES ('abcdefghijklmnopqrstuvwxyz')`);
      const [row] = await c.query<{ id: number }>(
        `INSERT INTO ${SCHEMA}.comments (novel_slug, episode_no, visitor_id, body, body_hash, ip_hash) VALUES ('n1', 1, 'abcdefghijklmnopqrstuvwxyz', 'hi', 'h', 'i') RETURNING id`,
      );
      expect(Number(row!.id)).toBeGreaterThan(0);
      await expect(c.query(`SELECT * FROM ${SCHEMA}.schema_migrations`)).rejects.toThrow(/permission denied/);
      await expect(c.query("SELECT * FROM public.other_app")).rejects.toThrow(/permission denied/);
      await expect(c.query(`CREATE TABLE ${SCHEMA}.evil (x int)`)).rejects.toThrow(/permission denied/);
    } finally {
      await pg.exec("RESET ROLE");
    }
  });
});
