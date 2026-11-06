/**
 * Opt-in REAL Supabase smoke (`NCS_TEST_SUPABASE_URL=… pnpm test:supabase`, needs `pnpm build` first).
 *
 * Boots the BUILT server (`apps/server/dist/main.js`) against that database in a throwaway schema
 * (`NCS_TEST_SUPABASE_SCHEMA`, default `ncs_smoke_<random>`; it must not exist yet), temp NCS_HOME and a random port:
 * migrations land only in that schema, /api/health passes, a novel is created over HTTP, a backup runs, a restart
 * applies nothing, Data API roles have no privileges on the schema, and every OTHER schema's objects are unchanged.
 * The throwaway schema is dropped at the end (only it — nothing else is touched).
 *
 * Optional: NCS_TEST_SUPABASE_PROVIDER (default `supabase`, e.g. for a local `supabase start` URL),
 * NCS_TEST_SUPABASE_KEEP=1 (keep the schema for inspection).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, loadMigrations, maskDatabaseUrl, redactDatabaseSecrets, resolveExternalConnection, type DbHandle } from "@ncs/db";
import { parseInstallConfig } from "@ncs/shared/config";

const URL_ = process.env.NCS_TEST_SUPABASE_URL;
const SCHEMA = process.env.NCS_TEST_SUPABASE_SCHEMA ?? `ncs_smoke_${randomBytes(4).toString("hex")}`;
const PROVIDER = process.env.NCS_TEST_SUPABASE_PROVIDER ?? "supabase";
const MAIN = fileURLToPath(new URL("../dist/main.js", import.meta.url));

if (!URL_) console.log("[test:supabase] NCS_TEST_SUPABASE_URL 이 없어 건너뜁니다.");

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => (p === 3100 ? freePort().then(res, rej) : res(p)));
    });
  });
}

/**
 * objects per schema, excluding the test schema, pg_toast/pg_temp noise and members of btree_gist / pg_trgm
 * (created in the extensions schema when the project did not have them yet)
 */
async function otherSchemasSnapshot(h: DbHandle): Promise<string[]> {
  const rows = await h.sql.unsafe<Array<{ o: string }>>(
    `SELECT n.nspname || '|' || x.kind || '|' || x.name AS o FROM (
        SELECT 'pg_class'::regclass AS cls, oid, relnamespace AS ns, 'rel:' || relkind::text AS kind, relname::text AS name FROM pg_class
        UNION ALL SELECT 'pg_proc'::regclass, oid, pronamespace, 'fn', proname::text || '(' || pg_get_function_identity_arguments(oid) || ')' FROM pg_proc
        UNION ALL SELECT 'pg_type'::regclass, oid, typnamespace, 'type', typname::text FROM pg_type
        UNION ALL SELECT 'pg_constraint'::regclass, oid, connamespace, 'con', conname::text FROM pg_constraint
        UNION ALL SELECT 'pg_operator'::regclass, oid, oprnamespace, 'op', oprname::text || '(' || oprleft::regtype || ',' || oprright::regtype || ')' FROM pg_operator
        UNION ALL SELECT 'pg_opclass'::regclass, oid, opcnamespace, 'opc', opcname::text FROM pg_opclass
        UNION ALL SELECT 'pg_opfamily'::regclass, oid, opfnamespace, 'opf', opfname::text FROM pg_opfamily
      ) x JOIN pg_namespace n ON n.oid = x.ns
      WHERE n.nspname <> $1
        AND NOT EXISTS (SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid = d.refobjid
                         WHERE d.classid = x.cls AND d.objid = x.oid AND d.deptype = 'e' AND e.extname IN ('btree_gist', 'pg_trgm')) AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
      ORDER BY 1`,
    [SCHEMA],
  );
  return rows.map((r) => r.o);
}

describe.skipIf(!URL_)("Supabase boot + migrate smoke (built server)", () => {
  let home: string;
  let port: number;
  let admin: DbHandle;
  let before: string[];
  let child: ChildProcess | null = null;
  let output = "";
  const env = () => ({
    ...process.env,
    NCS_HOME: home,
    NCS_HOST: "127.0.0.1",
    NCS_PORT: String(port),
    NCS_DEV_MODE: "0",
    DATABASE_URL: URL_!,
    NCS_DB_PROVIDER: PROVIDER,
    NCS_DB_SCHEMA: SCHEMA,
    NCS_LOG_LEVEL: "info",
    NCS_LOG_PRETTY: "0",
  });
  const masterKey = randomBytes(32).toString("base64");

  async function boot(): Promise<void> {
    output = "";
    child = spawn(process.execPath, [MAIN], { env: { ...env(), NCS_SECRETS_MASTER_KEY: masterKey }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.on("data", (d) => (output += String(d)));
    child.stderr!.on("data", (d) => (output += String(d)));
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${redactDatabaseSecrets(output, URL_)}`);
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (r.ok) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`server did not become healthy: ${redactDatabaseSecrets(output, URL_)}`);
  }

  async function stop(): Promise<void> {
    if (!child || child.exitCode !== null) return;
    const c = child;
    await new Promise<void>((r) => {
      c.once("exit", () => r());
      c.kill("SIGTERM");
    });
    child = null;
  }

  beforeAll(async () => {
    expect(existsSync(MAIN), "pnpm build 를 먼저 실행하세요").toBe(true);
    home = await mkdtemp(join(tmpdir(), "ncs-supabase-smoke-"));
    port = await freePort();
    const cfg = parseInstallConfig({ database: { mode: "external", url: URL_, provider: PROVIDER as "supabase", schema: SCHEMA } });
    admin = createDb(resolveExternalConnection(cfg.database), { max: 1 });
    const [exists] = await admin.sql.unsafe(`SELECT 1 FROM pg_namespace WHERE nspname = $1`, [SCHEMA]);
    expect(exists, `schema ${SCHEMA} must not exist yet`).toBeUndefined();
    before = await otherSchemasSnapshot(admin);
    console.log(`[test:supabase] ${maskDatabaseUrl(URL_!)} schema=${SCHEMA} port=${port}`);
  });

  afterAll(async () => {
    await stop();
    if (admin) {
      if (process.env.NCS_TEST_SUPABASE_KEEP !== "1") await admin.sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`).catch(() => undefined);
      await admin.close();
    }
    if (home) await rm(home, { recursive: true, force: true });
  });

  it("boots, migrates into the app schema only, serves HTTP, restarts idempotently", async () => {
    await boot();
    expect(output).not.toContain(new URL(URL_!).password || "\u0000never");
    const health = (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as { status: string; database: string };
    expect(health).toMatchObject({ status: "ok", database: "pass" });

    const info = (await (await fetch(`http://127.0.0.1:${port}/api/system/info`)).json()) as { databaseMode: string; database?: { provider: string; schema: string } };
    expect(info.databaseMode).toBe("external");
    expect(info.database).toMatchObject({ provider: "supabase", schema: SCHEMA });
    expect(JSON.stringify(info)).not.toContain(new URL(URL_!).password || "\u0000never");

    const created = await fetch(`http://127.0.0.1:${port}/api/novels`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Supabase 스모크" }),
    });
    expect(created.status).toBeLessThan(300);
    const novel = (await created.json()) as { id: string };
    expect(novel.id).toMatch(/^nov_/);

    const backup = await fetch(`http://127.0.0.1:${port}/api/system/backups`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(backup.status).toBeLessThan(300);

    const migs = await admin.sql.unsafe<Array<{ id: string }>>(`SELECT id FROM "${SCHEMA}".app_migrations ORDER BY id`);
    expect(migs.map((m) => m.id)).toEqual(loadMigrations().map((m) => m.id));
    const [n] = await admin.sql.unsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "${SCHEMA}".novels`);
    expect(n!.n).toBe(1);

    await stop();
    await boot();
    expect(output).toMatch(/"applied":\[\]/);
    const list = (await (await fetch(`http://127.0.0.1:${port}/api/novels`)).json()) as { items?: Array<{ id: string }> } | Array<{ id: string }>;
    const ids = (Array.isArray(list) ? list : (list.items ?? [])).map((x) => x.id);
    expect(ids).toContain(novel.id);
    await stop();

    // Data API roles (when present) have nothing on the schema
    const roles = await admin.sql.unsafe<Array<{ rolname: string; usage: boolean }>>(
      `SELECT rolname, has_schema_privilege(rolname, $1, 'USAGE') AS usage FROM pg_roles WHERE rolname IN ('anon', 'authenticated')`,
      [SCHEMA],
    );
    for (const r of roles) expect(r.usage, r.rolname).toBe(false);

    // nothing outside the app schema changed
    expect(await otherSchemasSnapshot(admin)).toEqual(before);
  });
});
