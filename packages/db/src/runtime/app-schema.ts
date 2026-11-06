/**
 * App-schema isolation for external DBs (Supabase or plain PostgreSQL with `database.schema`).
 *
 * The app may share a database with other software (an existing Supabase project). Rules:
 * - every app object lives in ONE schema (`conn.schema`, default `ncs` on Supabase), reached through the connection
 *   `search_path = <app schema>, <extensions schema>` — `public` is never on it;
 * - the target schema must be missing, empty, or already the app's (has `app_migrations`); a non-empty foreign
 *   schema is refused;
 * - btree_gist / pg_trgm are reused where they are installed; missing ones are created `WITH SCHEMA <extensions>`
 *   only (never in public). If that is impossible on Supabase the boot fails with a clear message;
 * - grants: `anon` / `authenticated` (Supabase Data API roles, when they exist) and PUBLIC lose every privilege on
 *   the app schema and its objects; on Supabase RLS is enabled (no policies) on the app's tables as a second wall.
 *   Nothing outside the app schema is created, altered, granted or revoked.
 */
import type { MigrationTarget } from "../migrate/runner.js";
import { DatabaseConfigError, type DbConnection } from "./provider.js";

export const APP_EXTENSIONS = ["btree_gist", "pg_trgm"] as const;
/** Data API roles of Supabase (absent elsewhere → skipped) */
export const DATA_API_ROLES = ["anon", "authenticated"] as const;

const qi = (name: string) => `"${name.replace(/"/g, '""')}"`;
const ql = (s: string) => `'${s.replace(/'/g, "''")}'`;

export interface AppSchemaInspection {
  /** schema the app writes into (configured, else the session's current_schema()) */
  schema: string;
  exists: boolean;
  /** has `<schema>.app_migrations` */
  appOwned: boolean;
  /** objects in the schema that are not extension members */
  objectCount: number;
  /** up to 10 `kind:name` samples of those objects */
  sampleObjects: string[];
  /** installed extensions → their schema */
  installed: Partial<Record<(typeof APP_EXTENSIONS)[number], string>>;
  available: Array<(typeof APP_EXTENSIONS)[number]>;
  extensionsSchemaExists: boolean;
  searchPath: string;
  /** human-readable list of what preparation + migrations will create (Korean) */
  plan: string[];
}

export async function inspectAppSchema(target: MigrationTarget, conn: DbConnection): Promise<AppSchemaInspection> {
  const [cur] = await target.query<{ s: string | null; p: string }>(`SELECT current_schema() AS s, current_setting('search_path') AS p`);
  const schema = conn.schema ?? cur?.s ?? "public";
  const [ns] = await target.query<{ oid: number }>(`SELECT oid::int AS oid FROM pg_namespace WHERE nspname = $1`, [schema]);
  let objectCount = 0;
  let sampleObjects: string[] = [];
  let appOwned = false;
  if (ns) {
    const rows = await target.query<{ kind: string; name: string }>(
      `WITH objs AS (
         SELECT 'pg_class'::regclass AS cls, c.oid, CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'table' WHEN 'v' THEN 'view' WHEN 'm' THEN 'view'
                WHEN 'S' THEN 'sequence' WHEN 'i' THEN 'index' WHEN 'I' THEN 'index' ELSE 'relation' END AS kind, c.relname::text AS name
           FROM pg_class c WHERE c.relnamespace = $1::oid
         UNION ALL
         SELECT 'pg_proc'::regclass, p.oid, 'function', p.proname::text FROM pg_proc p WHERE p.pronamespace = $1::oid
         UNION ALL
         SELECT 'pg_type'::regclass, t.oid, 'type', t.typname::text FROM pg_type t
          WHERE t.typnamespace = $1::oid AND t.typtype IN ('e', 'd', 'c', 'r', 'm') AND (t.typrelid = 0 OR (SELECT relkind FROM pg_class WHERE oid = t.typrelid) = 'c')
       )
       SELECT kind, name FROM objs o
        WHERE NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = o.cls AND d.objid = o.oid AND d.deptype = 'e')
        ORDER BY (kind <> 'table'), name`,
      [ns.oid],
    );
    objectCount = rows.length;
    sampleObjects = rows.slice(0, 10).map((r) => `${r.kind}:${r.name}`);
    const [m] = await target.query<{ r: string | null }>(`SELECT to_regclass($1)::text AS r`, [`${qi(schema)}.app_migrations`]);
    appOwned = !!m?.r;
  }
  const ext = await target.query<{ extname: string; nspname: string }>(
    `SELECT e.extname, n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = ANY($1::text[])`,
    [[...APP_EXTENSIONS]],
  );
  const installed: AppSchemaInspection["installed"] = {};
  for (const r of ext) installed[r.extname as (typeof APP_EXTENSIONS)[number]] = r.nspname;
  const av = await target.query<{ name: string }>(`SELECT name FROM pg_available_extensions WHERE name = ANY($1::text[])`, [[...APP_EXTENSIONS]]);
  const available = av.map((r) => r.name as (typeof APP_EXTENSIONS)[number]);
  const [es] = await target.query<{ x: number }>(`SELECT 1 AS x FROM pg_namespace WHERE nspname = $1`, [conn.extensionsSchema]);
  const extensionsSchemaExists = !!es;

  const plan: string[] = [];
  if (!ns) plan.push(`스키마 ${schema} 생성`);
  if (!appOwned) plan.push(`${schema} 안에 앱 테이블·인덱스·함수(ncs_forbid_update)·트리거와 마이그레이션 기록 테이블 app_migrations 생성`);
  else plan.push(`${schema}: 이미 이 앱의 스키마(app_migrations 있음) — 대기 중인 마이그레이션만 적용`);
  for (const e of APP_EXTENSIONS) {
    if (installed[e]) plan.push(`확장 ${e}: 기존 설치(${installed[e]}) 재사용`);
    else if (!available.includes(e)) plan.push(`확장 ${e}: 이 서버에 없음${e === "btree_gist" ? " — 필수라 시작할 수 없음" : " — 선택 기능 생략"}`);
    else if (conn.schema && extensionsSchemaExists) plan.push(`확장 ${e}: ${conn.extensionsSchema} 스키마에 생성`);
    else plan.push(`확장 ${e}: ${conn.schema ? `${schema} 스키마에` : "기본 스키마에"} 생성`);
  }
  if (conn.schema) plan.push(`권한: ${schema} 에서 PUBLIC${conn.provider === "supabase" ? "·anon·authenticated" : "(·anon·authenticated 가 있으면)"} 권한 회수${conn.provider === "supabase" ? ", 앱 테이블에 RLS 켜기(정책 없음)" : ""}`);
  return {
    schema,
    exists: !!ns,
    appOwned,
    objectCount,
    sampleObjects,
    installed,
    available,
    extensionsSchemaExists,
    searchPath: cur?.p ?? "",
    plan,
  };
}

const normPath = (p: string) =>
  p
    .split(",")
    .map((s) => s.trim().replace(/^"|"$/g, ""))
    .filter(Boolean)
    .join(",");

/**
 * Boot / doctor check (no writes): search_path really applied (a pooler may drop startup parameters) and the target
 * schema is missing, empty or the app's. Throws DatabaseConfigError otherwise.
 */
export async function assertAppSchemaUsable(target: MigrationTarget, conn: DbConnection): Promise<AppSchemaInspection> {
  const insp = await inspectAppSchema(target, conn);
  if (conn.searchPath && normPath(insp.searchPath) !== normPath(conn.searchPath)) {
    throw new DatabaseConfigError(
      `DB 연결의 search_path 가 적용되지 않았습니다(기대 ${conn.searchPath}, 실제 ${insp.searchPath || "-"}). ` +
        "풀러가 시작 파라미터를 전달하지 않는 것 같습니다. Supabase Direct connection 또는 Session pooler(5432) 주소를 쓰세요.",
      "search_path",
    );
  }
  if (insp.exists && !insp.appOwned && insp.objectCount > 0) {
    throw new DatabaseConfigError(
      `스키마 ${insp.schema} 에 이 앱이 만들지 않은 객체가 ${insp.objectCount}개 있습니다(${insp.sampleObjects.slice(0, 5).join(", ")}). ` +
        "다른 데이터와 섞이지 않도록 마이그레이션을 거부합니다. 비어 있는 새 스키마 이름을 NCS_DB_SCHEMA 로 지정하세요.",
      "schema_foreign",
    );
  }
  return insp;
}

/**
 * Before migrations: create the app schema and the missing extensions (in the extensions schema only).
 * No-op for connections without a dedicated schema (embedded / plain external public).
 */
export async function prepareAppSchema(
  target: MigrationTarget,
  conn: DbConnection,
  log: (m: string) => void = () => {},
  opts: { createSchema?: boolean } = {},
): Promise<AppSchemaInspection> {
  const insp = await assertAppSchemaUsable(target, conn);
  if (!conn.schema) return insp;
  const supabase = conn.provider === "supabase";
  if (!insp.exists && opts.createSchema !== false) {
    await target.exec(`CREATE SCHEMA IF NOT EXISTS ${qi(conn.schema)}`);
    log(`created schema ${conn.schema}`);
  }
  for (const e of APP_EXTENSIONS) {
    const where = insp.installed[e];
    if (where) {
      // gin_trgm_ops is looked up by name → pg_trgm must be on the search_path (btree_gist opclasses are defaults)
      if (e === "pg_trgm" && where !== conn.schema && where !== conn.extensionsSchema) {
        throw new DatabaseConfigError(
          `확장 pg_trgm 이 ${where} 스키마에 설치돼 있어 앱 search_path(${conn.schema}, ${conn.extensionsSchema})에서 보이지 않습니다. ` +
            `Supabase SQL 편집기에서 ALTER EXTENSION pg_trgm SET SCHEMA ${conn.extensionsSchema}; 를 실행하거나 NCS_DB_EXTENSIONS_SCHEMA=${where} 로 지정하세요.`,
          "extension",
        );
      }
      continue;
    }
    if (!insp.available.includes(e)) continue; // btree_gist: the runner reports missing_extension
    if (!insp.extensionsSchemaExists) {
      if (supabase) throw new DatabaseConfigError(`확장 스키마 ${conn.extensionsSchema} 가 없어 ${e} 를 만들 수 없습니다. Supabase 대시보드 Database → Extensions 에서 ${e} 를 켠 뒤 다시 시작하세요.`, "extension");
      continue; // plain PostgreSQL: 0001 creates it inside the app schema (first on search_path)
    }
    try {
      await target.exec(`CREATE EXTENSION IF NOT EXISTS ${qi(e)} WITH SCHEMA ${qi(conn.extensionsSchema)}`);
      log(`created extension ${e} in schema ${conn.extensionsSchema}`);
    } catch (err) {
      throw new DatabaseConfigError(
        `확장 ${e} 를 ${conn.extensionsSchema} 스키마에 만들 수 없습니다(${(err as Error).message}). Supabase 대시보드 Database → Extensions 에서 ${e} 를 켠 뒤 다시 시작하세요(public 에는 만들지 않습니다).`,
        "extension",
      );
    }
  }
  return insp;
}

/**
 * After migrations (idempotent, every boot): revoke PUBLIC / Data API roles on the app schema and its objects,
 * and on Supabase enable RLS (no policies; the owner role the app connects with bypasses it) on the app's tables.
 */
export async function hardenAppSchema(target: MigrationTarget, conn: DbConnection, log: (m: string) => void = () => {}): Promise<void> {
  if (!conn.schema || conn.schema === "public") return;
  const s = ql(conn.schema);
  const roles = `ARRAY[${DATA_API_ROLES.map(ql).join(", ")}]`;
  await target.exec(`DO $ncs$
DECLARE r text; t record;
BEGIN
  EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC', ${s});
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM PUBLIC', ${s});
  EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM PUBLIC', ${s});
  EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA %I FROM PUBLIC', ${s});
  FOREACH r IN ARRAY ${roles} LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA %I FROM %I', ${s}, r);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', ${s}, r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM %I', ${s}, r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA %I FROM %I', ${s}, r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON TABLES FROM %I', ${s}, r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON SEQUENCES FROM %I', ${s}, r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON FUNCTIONS FROM %I', ${s}, r);
    END IF;
  END LOOP;
  IF ${conn.provider === "supabase" ? "true" : "false"} THEN
    FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = ${s} AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
                AND pg_get_userbyid(c.relowner) = current_user LOOP
      EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', ${s}, t.relname);
    END LOOP;
  END IF;
END
$ncs$`);
  log(`schema ${conn.schema}: privileges of PUBLIC/${DATA_API_ROLES.join("/")} revoked${conn.provider === "supabase" ? ", RLS enabled on app tables" : ""}`);
}
