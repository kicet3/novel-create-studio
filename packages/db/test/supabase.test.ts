import { describe, expect, it } from "vitest";
import { PGlite, type Extensions } from "@electric-sql/pglite";
import { parseInstallConfig, installConfigFromEnv, installConfigSchema } from "@ncs/shared/config";
import {
  assertAppSchemaUsable,
  DatabaseConfigError,
  describeConnection,
  detectPoolerMode,
  detectProvider,
  inspectAppSchema,
  libpqEnv,
  loadMigrations,
  maskDatabaseUrl,
  migrateDatabase,
  pgliteTarget,
  plainConnection,
  postgresJsOptions,
  redactDatabaseSecrets,
  resolveExternalConnection,
  type DbConnection,
} from "../src/index.js";

const PASS = "s3cr#t/pa:ss";
const ENC = encodeURIComponent(PASS);
const REF = "abcdefghijklmnopqrst";
const DIRECT = `postgresql://postgres:${ENC}@db.${REF}.supabase.co:5432/postgres`;
const SESSION = `postgresql://postgres.${REF}:${ENC}@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres`;
const TXN = `postgresql://postgres.${REF}:${ENC}@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres`;

const db = (url: string, extra: Record<string, unknown> = {}) => parseInstallConfig({ database: { mode: "external", url, ...extra } }).database;

describe("Supabase connection resolution", () => {
  it("detects Supabase from the host and the explicit provider", () => {
    expect(detectProvider(DIRECT)).toBe("supabase");
    expect(detectProvider(SESSION)).toBe("supabase");
    expect(detectProvider("postgres://u:p@10.0.0.5:5432/app")).toBe("postgres");
    expect(detectProvider("postgres://u:p@127.0.0.1:55322/postgres", "supabase")).toBe("supabase");
    expect(detectPoolerMode(DIRECT, "supabase")).toBe("direct");
    expect(detectPoolerMode(SESSION, "supabase")).toBe("session");
    expect(detectPoolerMode(TXN, "supabase")).toBe("transaction");
    expect(detectPoolerMode("postgres://u:p@h:5432/d?pgbouncer=true", "postgres")).toBe("transaction");
  });

  it("refuses the transaction pooler (6543) with a Korean message naming direct / session pooler", () => {
    let err: unknown;
    try {
      resolveExternalConnection(db(TXN));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DatabaseConfigError);
    expect((err as DatabaseConfigError).code).toBe("transaction_pooler");
    expect((err as Error).message).toMatch(/6543/);
    expect((err as Error).message).toMatch(/Session pooler/);
    expect((err as Error).message).not.toContain(PASS);
    // explicit provider + local port 6543 is refused too
    expect(() => resolveExternalConnection(db("postgres://u:p@127.0.0.1:6543/postgres", { provider: "supabase" }))).toThrow(DatabaseConfigError);
  });

  it("Supabase: schema ncs, search_path = app schema + extensions (no public), TLS require, pool 5", () => {
    const c = resolveExternalConnection(db(SESSION));
    expect(c.provider).toBe("supabase");
    expect(c.schema).toBe("ncs");
    expect(c.searchPath).toBe(`"ncs", "extensions"`);
    expect(c.searchPath).not.toMatch(/public/);
    expect(c.ssl).toBe("require");
    expect(c.sslMode).toBe("require");
    expect(c.poolMax).toBe(5);
    expect(postgresJsOptions(c)).toEqual({ ssl: "require", connection: { search_path: `"ncs", "extensions"`, options: "-c search_path=ncs,extensions" } });
    expect(libpqEnv(c)).toEqual({ PGSSLMODE: "require" });
  });

  it("env overlay: NCS_DB_PROVIDER / NCS_DB_SCHEMA / NCS_DB_POOL_MAX / NCS_DB_SSL_CA_FILE / NCS_DB_EXTENSIONS_SCHEMA", () => {
    const cfg = parseInstallConfig(
      installConfigFromEnv({
        DATABASE_URL: "postgres://postgres:pw@127.0.0.1:55322/postgres?sslmode=disable",
        NCS_DB_PROVIDER: "supabase",
        NCS_DB_SCHEMA: "novel_app",
        NCS_DB_POOL_MAX: "3",
        NCS_DB_EXTENSIONS_SCHEMA: "ext",
      }),
    );
    const c = resolveExternalConnection(cfg.database);
    expect(c.provider).toBe("supabase");
    expect(c.schema).toBe("novel_app");
    expect(c.searchPath).toBe(`"novel_app", "ext"`);
    expect(c.poolMax).toBe(3);
    // explicit sslmode=disable (local `supabase start`) is honoured; prefer/allow are upgraded
    expect(c.ssl).toBeUndefined();
    expect(c.sslMode).toBe("disable");
    expect(resolveExternalConnection(db(`${SESSION}?sslmode=prefer`)).ssl).toBe("require");

    const withCa = resolveExternalConnection(db(DIRECT, { ssl_ca_file: "/x/prod-ca-2021.crt" }), { readFile: () => "PEM" });
    expect(withCa.sslMode).toBe("verify-full");
    expect(withCa.ssl).toMatchObject({ ca: "PEM", rejectUnauthorized: true, servername: `db.${REF}.supabase.co` });
    expect(libpqEnv(withCa)).toEqual({ PGSSLMODE: "verify-full", PGSSLROOTCERT: "/x/prod-ca-2021.crt" });
    expect(() => resolveExternalConnection(db(DIRECT, { ssl_ca_file: "/nope" }), { readFile: () => { throw Object.assign(new Error("x"), { code: "ENOENT" }); } })).toThrow(/CA/);
  });

  it("refuses public for Supabase unless explicitly allowed; plain PostgreSQL keeps the server default", () => {
    expect(installConfigSchema.safeParse({ database: { mode: "external", url: DIRECT, schema: "public" } }).success).toBe(false); // CFG-7
    expect(() => resolveExternalConnection({ ...db(DIRECT), schema: "public" })).toThrow(/public/);
    expect(resolveExternalConnection(db(DIRECT, { schema: "public", allow_public_schema: true })).schema).toBe("public");
    const plain = resolveExternalConnection(db("postgres://app:pw@10.0.0.5:5432/app"));
    expect(plain).toMatchObject({ provider: "postgres", schema: null, searchPath: null, ssl: undefined, poolMax: 10 });
    expect(installConfigSchema.safeParse({ database: { mode: "external", url: DIRECT, schema: "Bad-Name" } }).success).toBe(false);
  });

  it("never exposes the password: masking, redaction, description", () => {
    for (const url of [DIRECT, SESSION]) {
      const masked = maskDatabaseUrl(url);
      expect(masked).not.toContain(PASS);
      expect(masked).not.toContain(ENC);
      expect(masked).not.toContain(REF);
      expect(masked).toContain(":****@");
      const c = resolveExternalConnection(db(url));
      expect(JSON.stringify(describeConnection(c))).not.toContain(PASS);
      expect(JSON.stringify(describeConnection(c))).not.toContain(REF);
      expect(c.display).toBe(masked);
    }
    expect(maskDatabaseUrl(DIRECT)).toBe("postgresql://postgres:****@db.abc…qrst.supabase.co:5432/postgres");
    const msg = `connect failed: ${DIRECT} (password ${PASS}, enc ${ENC})`;
    const red = redactDatabaseSecrets(msg, DIRECT);
    expect(red).not.toContain(PASS);
    expect(red).not.toContain(ENC);
    expect(maskDatabaseUrl("not a url")).not.toContain("not a url");
  });
});

// ── schema isolation on a real (in-process) PostgreSQL ─────────────────────────────────────────

async function contrib(): Promise<Extensions> {
  const ext: Extensions = {};
  try {
    ext.btree_gist = (await import("@electric-sql/pglite/contrib/btree_gist")).btree_gist;
  } catch {
    /* optional */
  }
  try {
    ext.pg_trgm = (await import("@electric-sql/pglite/contrib/pg_trgm")).pg_trgm;
  } catch {
    /* optional */
  }
  return ext;
}

/** a "Supabase-like" database: extensions schema, Data API roles, pre-existing objects in public */
async function supabaseLike(): Promise<PGlite> {
  const pg = await PGlite.create({ extensions: await contrib() });
  await pg.exec(`
    CREATE SCHEMA extensions;
    DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    CREATE TABLE public.existing_things (id int PRIMARY KEY, name text);
    INSERT INTO public.existing_things VALUES (1, 'keep me');
    CREATE FUNCTION public.existing_fn() RETURNS int LANGUAGE sql AS 'SELECT 42';
    CREATE TABLE public.novels (id text PRIMARY KEY);
    GRANT SELECT ON public.existing_things TO anon;
  `);
  return pg;
}

const conn = (schema = "ncs"): DbConnection => ({
  ...plainConnection("postgres://postgres@localhost:5432/postgres"),
  provider: "supabase",
  schema,
  searchPath: `"${schema}", "extensions"`,
});

const publicSnapshot = async (pg: PGlite) =>
  (
    await pg.query<{ o: string }>(
      `SELECT kind || ':' || name AS o FROM (
         SELECT 'rel' AS kind, relname::text AS name FROM pg_class WHERE relnamespace = 'public'::regnamespace
         UNION ALL SELECT 'fn', proname::text FROM pg_proc WHERE pronamespace = 'public'::regnamespace
         UNION ALL SELECT 'type', typname::text FROM pg_type WHERE typnamespace = 'public'::regnamespace) x ORDER BY 1`,
    )
  ).rows.map((r) => r.o);

describe("app schema isolation (PGlite)", () => {
  it("migrates only into the app schema, leaves public untouched, revokes Data API roles, enables RLS; idempotent", async () => {
    const pg = await supabaseLike();
    const before = await publicSnapshot(pg);
    await pg.exec(`SET search_path = "ncs", "extensions"`);
    const target = pgliteTarget(pg);
    const c = conn();

    const insp = await inspectAppSchema(target, c);
    expect(insp).toMatchObject({ schema: "ncs", exists: false, appOwned: false });
    expect(insp.plan.join("\n")).toMatch(/스키마 ncs 생성/);

    const first = await migrateDatabase(target, c, { appVersion: "t" });
    expect(first.applied).toEqual(loadMigrations().map((m) => m.id));
    const second = await migrateDatabase(target, c, { appVersion: "t" });
    expect(second.applied).toEqual([]);

    expect(await publicSnapshot(pg)).toEqual(before);
    expect((await pg.query<{ name: string }>(`SELECT name FROM public.existing_things`)).rows).toEqual([{ name: "keep me" }]);
    expect((await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.novels`)).rows[0]!.n).toBe(0);
    // public grant of the other app survives
    expect((await pg.query<{ ok: boolean }>(`SELECT has_table_privilege('anon', 'public.existing_things', 'SELECT') AS ok`)).rows[0]!.ok).toBe(true);

    const reg = (await pg.query<{ s: string }>(`SELECT n.nspname AS s FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = 'app_migrations'`)).rows;
    expect(reg).toEqual([{ s: "ncs" }]);
    const fn = (await pg.query<{ s: string }>(`SELECT pronamespace::regnamespace::text AS s FROM pg_proc WHERE proname = 'ncs_forbid_update'`)).rows;
    expect(fn).toEqual([{ s: "ncs" }]);
    const exts = (await pg.query<{ extname: string; s: string }>(`SELECT extname, extnamespace::regnamespace::text AS s FROM pg_extension WHERE extname IN ('btree_gist','pg_trgm')`)).rows;
    expect(exts.map((e) => e.extname).sort()).toEqual(["btree_gist", "pg_trgm"]);
    for (const e of exts) expect(e.s).toBe("extensions");
    // gin_trgm_ops / EXCLUDE constraints resolved through the extensions schema
    const idx = (await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = 'ncs' AND indexname = 'entity_names_surface_trgm'`)).rows[0]!.n;
    expect(idx).toBe(1);

    const priv = (
      await pg.query<{ usage: boolean; sel: boolean }>(
        `SELECT has_schema_privilege('anon', 'ncs', 'USAGE') AS usage, has_table_privilege('authenticated', 'ncs.novels', 'SELECT') AS sel`,
      )
    ).rows[0]!;
    expect(priv).toEqual({ usage: false, sel: false });
    const noRls = (await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_class WHERE relnamespace = 'ncs'::regnamespace AND relkind = 'r' AND NOT relrowsecurity`)).rows[0]!.n;
    expect(noRls).toBe(0);
    // the app (table owner) still reads and writes through RLS
    await pg.exec(`INSERT INTO app_migrations (id, name, checksum, app_version, duration_ms) VALUES ('9999', 'probe', 'x', 't', 0); DELETE FROM app_migrations WHERE id = '9999'`);
    await pg.close();
  });

  it("refuses a non-empty foreign schema and a search_path the pooler did not apply", async () => {
    const pg = await supabaseLike();
    await pg.exec(`CREATE SCHEMA ncs; CREATE TABLE ncs.someone_elses (id int)`);
    await pg.exec(`SET search_path = "ncs", "extensions"`);
    await expect(assertAppSchemaUsable(pgliteTarget(pg), conn())).rejects.toMatchObject({ code: "schema_foreign" });
    await expect(migrateDatabase(pgliteTarget(pg), conn(), { appVersion: "t" })).rejects.toMatchObject({ code: "schema_foreign" });
    expect((await pg.query(`SELECT 1 FROM pg_class WHERE relname = 'app_migrations'`)).rows).toEqual([]);

    await pg.exec(`SET search_path = public`);
    await expect(assertAppSchemaUsable(pgliteTarget(pg), conn("other"))).rejects.toMatchObject({ code: "search_path" });
    await pg.close();
  });
});
