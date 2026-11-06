/**
 * Backup bundle engine (design/02 §8.2–8.4, 08 §8.3). Pure I/O helpers shared by the server's
 * BackupService and the CLI (`ncs backup` / `ncs restore`). No platform / module imports so the CLI
 * can load this file on its own.
 *
 * Bundle layout: `<backupsDir>/<UTC ts>-<trigger>-<id suffix>/`
 *   - `db.dump`        (engine `pg_dump`: pg_dump -Fc taken with an exported snapshot)
 *   - `db.ndjson.gz`   (engine `json`: one line per row `<table>\t<row_to_json>` read in ONE
 *                       REPEATABLE READ READ ONLY transaction together with the file list)
 *   - `files/<storage key>` referenced storage files (hash verified)
 *   - `manifest.json`  written LAST — a bundle without a manifest is not a valid backup
 *
 * Restore goes into a FRESH database: json → migrations up to the bundle's last migration, rows
 * loaded with FK/trigger enforcement off (session_replication_role=replica when superuser, else FK
 * topological order), identity sequences reset, then remaining (newer) migrations applied.
 * pg_dump → pg_restore, then remaining migrations.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createGunzip, createGzip } from "node:zlib";
import { z } from "zod";
import {
  loadMigrations,
  pgliteTarget,
  postgresJsTarget,
  runMigrations,
  prepareAppSchema,
  hardenAppSchema,
  type DbConnection,
  type MigrationFile,
  type MigrationTarget,
} from "@ncs/db";
import { findPgTool, runPgDump, runPgRestore, type PgTool } from "./backup-pgtools.js";

export const BACKUP_FORMAT = "ncs-backup";
export const BACKUP_FORMAT_VERSION = 1;
export const MANIFEST_FILE = "manifest.json";
export const JSON_DUMP_FILE = "db.ndjson.gz";
export const PG_DUMP_FILE = "db.dump";

export type BackupEngineKind = "pg_dump" | "json";
export type BackupEngineChoice = BackupEngineKind | "auto";

const fileEntrySchema = z.object({ key: z.string(), sha256: z.string(), size: z.number().int().nonnegative() });

export const backupManifestSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  formatVersion: z.literal(BACKUP_FORMAT_VERSION),
  backupId: z.string(),
  trigger: z.enum(["scheduled", "pre_migration", "pre_restore", "manual"]),
  mode: z.enum(["full", "files_only"]),
  engine: z.enum(["pg_dump", "json"]).nullable(),
  appVersion: z.string(),
  lastMigrationId: z.string().nullable(),
  pgVersion: z.string().nullable(),
  pgVersionNum: z.number().int().nullable(),
  /** schema the app tables were read from (absent in older bundles = public) */
  dbSchema: z.string().optional(),
  createdAt: z.string(),
  novelIds: z.array(z.string()),
  db: z
    .object({
      file: z.string(),
      sha256: z.string(),
      sizeBytes: z.number().int().nonnegative(),
      /** json engine: row counts per table (also used as the restore integrity check) */
      tables: z.record(z.string(), z.object({ rows: z.number().int().nonnegative(), columns: z.array(z.string()) })).optional(),
      pgDumpVersion: z.string().optional(),
    })
    .nullable(),
  files: z.array(fileEntrySchema),
  missingFiles: z.array(z.string()),
  filesHash: z.string(),
  totalSizeBytes: z.number().int().nonnegative(),
});
export type BackupManifest = z.infer<typeof backupManifestSchema>;

/** Tables whose `*storage_key` columns do NOT point into the storage root. */
const NON_STORAGE_KEY_TABLES = new Set(["backup_records"]);

const qi = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** MigrationTarget over the client behind a drizzle handle (postgres.js or PGlite). */
export function targetFromDrizzle(db: unknown): MigrationTarget {
  const client = (db as { $client?: unknown }).$client as Record<string, unknown> | undefined;
  if (!client) throw new Error("drizzle handle without $client");
  if (typeof client.unsafe === "function" && typeof client.begin === "function") return postgresJsTarget(client as never);
  if (typeof client.exec === "function" && typeof client.query === "function") return pgliteTarget(client as never);
  throw new Error("unsupported database client for backups");
}

export function sha256File(path: string): Promise<{ sha256: string; size: number }> {
  return new Promise((res, rej) => {
    const h = createHash("sha256");
    let size = 0;
    createReadStream(path)
      .on("data", (c) => {
        h.update(c);
        size += (c as Buffer).length;
      })
      .on("error", rej)
      .on("end", () => res({ sha256: h.digest("hex"), size }));
  });
}

function safeJoin(root: string, key: string): string {
  if (!key || key.startsWith("/") || key.split("/").includes("..")) throw new Error(`invalid storage key: ${key}`);
  const abs = resolve(root);
  const p = resolve(abs, key);
  if (!p.startsWith(abs + sep)) throw new Error(`invalid storage key: ${key}`);
  return p;
}

export function filesHashOf(files: Array<{ key: string; sha256: string }>): string {
  const h = createHash("sha256");
  for (const f of [...files].sort((a, b) => a.key.localeCompare(b.key))) h.update(`${f.key}\0${f.sha256}\n`);
  return h.digest("hex");
}

/** Bundle directory name: `20261105T093000Z-manual-<last 8 of id>` (sortable). */
export function bundleDirName(backupId: string, trigger: string, at: Date): string {
  const ts = at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${ts}-${trigger}-${backupId.slice(-8).toLowerCase()}`;
}

// ── snapshot reads ────────────────────────────────────────────────────────────

interface SnapshotInfo {
  schema: string;
  pgVersion: string | null;
  pgVersionNum: number | null;
  lastMigrationId: string | null;
  novelIds: string[];
  fileKeys: string[];
}

/** app tables: in `schema` when given (isolated app schema), else the session's current_schema() */
async function listTables(q: MigrationTarget, schema?: string | null): Promise<string[]> {
  const rows = await q.query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = COALESCE($1::text, current_schema()) AND c.relkind = 'r' ORDER BY c.relname`,
    [schema ?? null],
  );
  return rows.map((r) => r.relname);
}

async function columnsOf(q: MigrationTarget, table: string): Promise<string[]> {
  const rows = await q.query<{ attname: string }>(
    `SELECT a.attname FROM pg_attribute a
      WHERE a.attrelid = (quote_ident(current_schema()) || '.' || quote_ident($1))::regclass AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [table],
  );
  return rows.map((r) => r.attname);
}

async function readSnapshotInfo(q: MigrationTarget, tables: string[]): Promise<SnapshotInfo> {
  const [ver] = await q.query<{ v: string; n: string | number; s: string | null }>(
    `SELECT current_setting('server_version') AS v, current_setting('server_version_num') AS n, current_schema() AS s`,
  );
  let lastMigrationId: string | null = null;
  if (tables.includes("app_migrations")) {
    const [m] = await q.query<{ id: string | null }>(`SELECT max(id) AS id FROM app_migrations`);
    lastMigrationId = m?.id ?? null;
  }
  const novelIds = tables.includes("novels") ? (await q.query<{ id: string }>(`SELECT id FROM novels ORDER BY id`)).map((r) => r.id) : [];
  const keyCols = await q.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND column_name LIKE '%storage_key' ORDER BY table_name, column_name`,
  );
  const keys = new Set<string>();
  for (const c of keyCols) {
    if (NON_STORAGE_KEY_TABLES.has(c.table_name) || !tables.includes(c.table_name)) continue;
    const rows = await q.query<{ k: string }>(`SELECT DISTINCT ${qi(c.column_name)} AS k FROM ${qi(c.table_name)} WHERE ${qi(c.column_name)} IS NOT NULL`);
    for (const r of rows) keys.add(r.k);
  }
  return {
    schema: ver?.s ?? "public",
    pgVersion: ver?.v ?? null,
    pgVersionNum: ver ? Number(ver.n) : null,
    lastMigrationId,
    novelIds,
    fileKeys: [...keys].sort(),
  };
}

async function inSnapshot<R>(target: MigrationTarget, fn: (q: MigrationTarget) => Promise<R>): Promise<R> {
  return target.transaction(async (tx) => {
    await tx.exec(`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
    return fn(tx);
  });
}

async function dumpJson(q: MigrationTarget, tables: string[], file: string): Promise<NonNullable<BackupManifest["db"]>["tables"]> {
  const counts: Record<string, { rows: number; columns: string[] }> = {};
  async function* lines() {
    for (const t of tables) {
      const columns = await columnsOf(q, t);
      const rows = await q.query<{ j: string }>(`SELECT row_to_json(x)::text AS j FROM ${qi(t)} x`);
      counts[t] = { rows: rows.length, columns };
      let chunk = "";
      for (const r of rows) {
        chunk += `${t}\t${r.j}\n`;
        if (chunk.length > 1 << 20) {
          yield chunk;
          chunk = "";
        }
      }
      if (chunk) yield chunk;
    }
  }
  await pipeline(Readable.from(lines()), createGzip(), createWriteStream(file, { mode: 0o600 }));
  return counts;
}

async function copyReferencedFiles(storageRoot: string, keys: string[], bundleDir: string) {
  const files: BackupManifest["files"] = [];
  const missingFiles: string[] = [];
  for (const key of keys) {
    let src: string;
    try {
      src = safeJoin(storageRoot, key);
    } catch {
      missingFiles.push(key);
      continue;
    }
    if (!existsSync(src)) {
      missingFiles.push(key);
      continue;
    }
    const dst = safeJoin(join(bundleDir, "files"), key);
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(src, dst);
    const [a, b] = await Promise.all([sha256File(src), sha256File(dst)]);
    if (a.sha256 !== b.sha256) throw new Error(`file changed while copying: ${key}`);
    files.push({ key, sha256: b.sha256, size: b.size });
  }
  return { files, missingFiles };
}

// ── backup ────────────────────────────────────────────────────────────────────

export interface WriteBundleOptions {
  target: MigrationTarget;
  bundleDir: string;
  storageRoot: string;
  backupId: string;
  trigger: BackupManifest["trigger"];
  mode: BackupManifest["mode"];
  appVersion: string;
  now: Date;
  engine?: BackupEngineChoice;
  /** connection URL (needed by the pg_dump engine; absent for PGlite) */
  databaseUrl?: string | null;
  /** resolved connection: pg_dump gets its TLS mode and is limited to the app schema (`--schema`) */
  connection?: DbConnection;
  /** override tool discovery (tests) */
  pgDumpTool?: PgTool | null;
  log?: (msg: string) => void;
}

export interface WriteBundleResult {
  manifest: BackupManifest;
  bundleDir: string;
}

/** Decide the engine: pg_dump when a URL and a compatible pg_dump (major ≥ server major) exist. */
export async function resolveEngine(
  target: MigrationTarget,
  choice: BackupEngineChoice,
  databaseUrl: string | null | undefined,
  override?: PgTool | null,
): Promise<{ engine: BackupEngineKind; tool: PgTool | null }> {
  if (choice === "json") return { engine: "json", tool: null };
  const [v] = await target.query<{ n: string | number }>(`SELECT current_setting('server_version_num') AS n`);
  const major = Math.floor(Number(v?.n ?? 0) / 10_000);
  const tool = override !== undefined ? override : databaseUrl ? findPgTool("pg_dump", major) : null;
  if (tool && databaseUrl) return { engine: "pg_dump", tool };
  if (choice === "pg_dump") throw new Error(`호환되는 pg_dump(PostgreSQL ${major} 이상)를 찾지 못했습니다.`);
  return { engine: "json", tool: null };
}

export async function writeBundle(o: WriteBundleOptions): Promise<WriteBundleResult> {
  const log = o.log ?? (() => {});
  const partial = `${o.bundleDir}.partial`;
  await rm(partial, { recursive: true, force: true });
  await mkdir(join(partial, "files"), { recursive: true, mode: 0o700 });
  try {
    const { engine, tool } = o.mode === "full" ? await resolveEngine(o.target, o.engine ?? "auto", o.databaseUrl, o.pgDumpTool) : { engine: null, tool: null };
    let engineUsed: BackupEngineKind | null = engine;
    let db: BackupManifest["db"] = null;
    const info = await inSnapshot(o.target, async (q) => {
      const tables = await listTables(q, o.connection?.schema);
      const snap = await readSnapshotInfo(q, tables);
      if (engine === "json") {
        const file = join(partial, JSON_DUMP_FILE);
        const counts = await dumpJson(q, tables, file);
        const h = await sha256File(file);
        db = { file: JSON_DUMP_FILE, sha256: h.sha256, sizeBytes: h.size, tables: counts };
      } else if (engine === "pg_dump") {
        const [s] = await q.query<{ id: string }>(`SELECT pg_export_snapshot() AS id`);
        const file = join(partial, PG_DUMP_FILE);
        try {
          // the transaction stays open until pg_dump has finished with the exported snapshot
          await runPgDump(tool!, { url: o.databaseUrl!, snapshot: s!.id, file, schema: o.connection?.schema ?? null, connection: o.connection });
          const h = await sha256File(file);
          db = { file: PG_DUMP_FILE, sha256: h.sha256, sizeBytes: h.size, pgDumpVersion: tool!.version };
        } catch (err) {
          // "auto": a pg_dump that cannot talk to this server (version, TLS, pooler, permissions) → JSON engine, same snapshot
          if ((o.engine ?? "auto") !== "auto") throw err;
          log(`pg_dump failed, falling back to the json engine: ${(err as Error).message.slice(0, 300)}`);
          await rm(file, { force: true });
          engineUsed = "json";
          const jf = join(partial, JSON_DUMP_FILE);
          const counts = await dumpJson(q, tables, jf);
          const h = await sha256File(jf);
          db = { file: JSON_DUMP_FILE, sha256: h.sha256, sizeBytes: h.size, tables: counts };
        }
      }
      return snap;
    });
    log(`backup db dump done (engine=${engineUsed ?? "none"}, schema=${info.schema})`);
    const { files, missingFiles } = await copyReferencedFiles(o.storageRoot, info.fileKeys, partial);
    const totalSizeBytes = (db as BackupManifest["db"])?.sizeBytes ?? 0;
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      backupId: o.backupId,
      trigger: o.trigger,
      mode: o.mode,
      engine: engineUsed,
      appVersion: o.appVersion,
      lastMigrationId: info.lastMigrationId,
      pgVersion: info.pgVersion,
      pgVersionNum: info.pgVersionNum,
      dbSchema: info.schema,
      createdAt: o.now.toISOString(),
      novelIds: info.novelIds,
      db,
      files,
      missingFiles,
      filesHash: filesHashOf(files),
      totalSizeBytes: totalSizeBytes + files.reduce((s, f) => s + f.size, 0),
    };
    await writeFile(join(partial, MANIFEST_FILE), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    await rm(o.bundleDir, { recursive: true, force: true });
    await rename(partial, o.bundleDir);
    return { manifest, bundleDir: o.bundleDir };
  } catch (err) {
    await rm(partial, { recursive: true, force: true });
    throw err;
  }
}

// ── verify ────────────────────────────────────────────────────────────────────

export async function readManifest(bundleDir: string): Promise<BackupManifest> {
  const p = join(bundleDir, MANIFEST_FILE);
  if (!existsSync(p)) throw new Error(`manifest.json 이 없습니다: ${bundleDir}`);
  return backupManifestSchema.parse(JSON.parse(await readFile(p, "utf8")));
}

export async function verifyBundle(bundleDir: string): Promise<{ ok: boolean; message: string; manifest?: BackupManifest; problems: string[] }> {
  let manifest: BackupManifest;
  try {
    manifest = await readManifest(bundleDir);
  } catch (err) {
    return { ok: false, message: `백업 매니페스트를 읽을 수 없습니다: ${(err as Error).message}`, problems: ["manifest"] };
  }
  const problems: string[] = [];
  if (manifest.db) {
    const p = join(bundleDir, manifest.db.file);
    if (!existsSync(p)) problems.push(`missing:${manifest.db.file}`);
    else if ((await sha256File(p)).sha256 !== manifest.db.sha256) problems.push(`hash:${manifest.db.file}`);
  }
  for (const f of manifest.files) {
    const p = safeJoin(join(bundleDir, "files"), f.key);
    if (!existsSync(p)) problems.push(`missing:files/${f.key}`);
    else if ((await sha256File(p)).sha256 !== f.sha256) problems.push(`hash:files/${f.key}`);
  }
  if (filesHashOf(manifest.files) !== manifest.filesHash) problems.push("files_hash");
  return problems.length
    ? { ok: false, message: `백업 검증 실패: ${problems.slice(0, 5).join(", ")}${problems.length > 5 ? " …" : ""}`, manifest, problems }
    : { ok: true, message: `백업 검증 통과 (파일 ${manifest.files.length}개)`, manifest, problems };
}

// ── restore ───────────────────────────────────────────────────────────────────

export interface RestoreBundleOptions {
  /** a FRESH (empty) database */
  target: MigrationTarget;
  bundleDir: string;
  /** copy bundle files back into this storage root (hash verified, existing files are overwritten) */
  storageRoot?: string;
  /** migrations of THIS app (default: @ncs/db migrations) */
  migrations?: MigrationFile[];
  appVersion: string;
  requireExtensions?: string[];
  /** pg_dump bundles: URL of the target + pg_restore tool override */
  databaseUrl?: string | null;
  /** resolved target connection: app schema prepared/hardened (isolated schema), TLS for pg_restore */
  connection?: DbConnection;
  pgRestoreTool?: PgTool | null;
  log?: (msg: string) => void;
}

export interface RestoreBundleResult {
  manifest: BackupManifest;
  engine: BackupEngineKind | null;
  restoredRows: Record<string, number>;
  appliedMigrations: string[];
  restoredFiles: number;
  missingFiles: string[];
}

export class RestoreError extends Error {
  constructor(
    readonly code: "invalid_bundle" | "newer_backup" | "not_empty" | "schema_mismatch" | "integrity" | "no_tool" | "files_only",
    message: string,
  ) {
    super(message);
    this.name = "RestoreError";
  }
}

async function fkOrder(q: MigrationTarget, tables: string[]): Promise<string[]> {
  const edges = await q.query<{ child: string; parent: string }>(
    `SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
       FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE c.contype = 'f' AND n.nspname = current_schema()`,
  );
  // regclass::text is unqualified for relations on the search_path (the app schema)
  const strip = (s: string) => s.replace(/^("[^"]+"|[^."]+)\./, "").replace(/^"|"$/g, "");
  const deps = new Map<string, Set<string>>(tables.map((t) => [t, new Set<string>()]));
  for (const e of edges) {
    const c = strip(e.child);
    const p = strip(e.parent);
    if (c !== p && deps.has(c) && deps.has(p)) deps.get(c)!.add(p);
  }
  const out: string[] = [];
  const state = new Map<string, 1 | 2>();
  const visit = (t: string) => {
    if (state.get(t) === 2) return;
    if (state.get(t) === 1) return; // cycle: best effort
    state.set(t, 1);
    for (const p of deps.get(t) ?? []) visit(p);
    state.set(t, 2);
    out.push(t);
  };
  for (const t of tables) visit(t);
  return out;
}

async function* readDumpLines(file: string): AsyncGenerator<{ table: string; json: string }> {
  const rl = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const i = line.indexOf("\t");
    yield { table: line.slice(0, i), json: line.slice(i + 1) };
  }
}

async function restoreJsonRows(q: MigrationTarget, file: string, manifest: BackupManifest): Promise<Record<string, number>> {
  const tables = await listTables(q);
  const expected = manifest.db?.tables ?? {};
  for (const [t, meta] of Object.entries(expected)) {
    if (!tables.includes(t)) throw new RestoreError("schema_mismatch", `복원 대상에 테이블이 없습니다: ${t}`);
    const cols = await columnsOf(q, t);
    if (cols.join(",") !== meta.columns.join(",")) throw new RestoreError("schema_mismatch", `테이블 열 구성이 백업과 다릅니다: ${t}`);
  }
  const [su] = await q.query<{ s: boolean }>(`SELECT rolsuper AS s FROM pg_roles WHERE rolname = current_user`);
  const superuser = !!su?.s;
  if (superuser) await q.exec(`SET LOCAL session_replication_role = replica`);
  else await q.exec(`SET CONSTRAINTS ALL DEFERRED`);

  // runner-written history is replaced by the backup's history
  if (expected.app_migrations) await q.exec(`DELETE FROM app_migrations`);

  const counts: Record<string, number> = {};
  const flush = async (table: string, rows: string[]) => {
    if (!rows.length) return;
    await q.query(`INSERT INTO ${qi(table)} OVERRIDING SYSTEM VALUE SELECT * FROM json_populate_recordset(NULL::${qi(table)}, $1::json)`, [
      `[${rows.join(",")}]`,
    ]);
    counts[table] = (counts[table] ?? 0) + rows.length;
  };

  if (superuser) {
    let cur: string | null = null;
    let buf: string[] = [];
    let size = 0;
    for await (const { table, json } of readDumpLines(file)) {
      if (table !== cur || buf.length >= 1000 || size > 4 << 20) {
        if (cur) await flush(cur, buf);
        cur = table;
        buf = [];
        size = 0;
      }
      buf.push(json);
      size += json.length;
    }
    if (cur) await flush(cur, buf);
  } else {
    // no replica role: load parents first (one pass per table, FK topological order)
    for (const t of await fkOrder(q, Object.keys(expected))) {
      let buf: string[] = [];
      for await (const { table, json } of readDumpLines(file)) {
        if (table !== t) continue;
        buf.push(json);
        if (buf.length >= 1000) {
          await flush(t, buf);
          buf = [];
        }
      }
      await flush(t, buf);
    }
  }

  // identity sequences follow the restored max values
  const idents = await q.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND (is_identity = 'YES' OR column_default LIKE 'nextval(%')`,
  );
  for (const c of idents) {
    await q.query(
      `SELECT setval(pg_get_serial_sequence($1, $2), COALESCE((SELECT max(${qi(c.column_name)}) FROM ${qi(c.table_name)}), 1),
               (SELECT max(${qi(c.column_name)}) FROM ${qi(c.table_name)}) IS NOT NULL)`,
      [qi(c.table_name), c.column_name],
    );
  }
  if (superuser) await q.exec(`SET LOCAL session_replication_role = origin`);

  for (const [t, meta] of Object.entries(expected)) {
    const [r] = await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${qi(t)}`);
    if (Number(r?.n ?? 0) !== meta.rows) throw new RestoreError("integrity", `행 수가 백업과 다릅니다: ${t} (${r?.n} ≠ ${meta.rows})`);
  }
  return counts;
}

async function restoreFiles(bundleDir: string, manifest: BackupManifest, storageRoot: string): Promise<number> {
  let n = 0;
  for (const f of manifest.files) {
    const src = safeJoin(join(bundleDir, "files"), f.key);
    const dst = safeJoin(storageRoot, f.key);
    await mkdir(dirname(dst), { recursive: true });
    const tmp = `${dst}.restore-${process.pid}`;
    await copyFile(src, tmp);
    if ((await sha256File(tmp)).sha256 !== f.sha256) {
      await rm(tmp, { force: true });
      throw new RestoreError("integrity", `파일 해시가 다릅니다: ${f.key}`);
    }
    await rename(tmp, dst);
    n++;
  }
  return n;
}

export async function restoreBundle(o: RestoreBundleOptions): Promise<RestoreBundleResult> {
  const log = o.log ?? (() => {});
  const v = await verifyBundle(o.bundleDir);
  if (!v.ok || !v.manifest) throw new RestoreError("invalid_bundle", v.message);
  const manifest = v.manifest;
  if (manifest.mode === "files_only" || !manifest.db) {
    throw new RestoreError("files_only", "이 백업은 파일만 담고 있어 DB를 복원할 수 없습니다(backup.mode=files_only).");
  }
  const migrations = o.migrations ?? loadMigrations();
  const latestKnown = migrations.at(-1)?.id ?? null;
  if (manifest.lastMigrationId && (!latestKnown || manifest.lastMigrationId > latestKnown)) {
    throw new RestoreError("newer_backup", `더 새 버전 앱에서 만든 백업입니다(마이그레이션 ${manifest.lastMigrationId} > ${latestKnown ?? "없음"}). 앱을 업그레이드한 뒤 복원하세요.`);
  }
  const existing = (await listTables(o.target, o.connection?.schema)).filter((t) => t !== "app_migrations");
  if (existing.length) {
    const nonEmpty: string[] = [];
    for (const t of existing) {
      const [r] = await o.target.query<{ x: number }>(`SELECT 1 AS x FROM ${qi(t)} LIMIT 1`);
      if (r) nonEmpty.push(t);
    }
    if (nonEmpty.length) throw new RestoreError("not_empty", `복원 대상 DB가 비어 있지 않습니다: ${nonEmpty.slice(0, 5).join(", ")}`);
  }

  let restoredRows: Record<string, number> = {};
  const runOpts = { appVersion: o.appVersion, requireExtensions: o.requireExtensions, log };
  const isolated = !!o.connection?.schema;
  if (manifest.engine === "json") {
    // dedicated app schema: create it (+ missing extensions in the extensions schema); never touches other schemas
    if (isolated) await prepareAppSchema(o.target, o.connection!, log);
    const upTo = manifest.lastMigrationId;
    const prefix = upTo ? migrations.filter((m) => m.id <= upTo) : [];
    if (prefix.length) await runMigrations(o.target, { ...runOpts, migrations: prefix });
    restoredRows = await o.target.transaction((tx) => restoreJsonRows(tx, join(o.bundleDir, manifest.db!.file), manifest));
  } else {
    if (existing.length) throw new RestoreError("not_empty", "pg_dump 백업은 스키마가 없는 새 DB에만 복원할 수 있습니다.");
    if (!o.databaseUrl) throw new RestoreError("no_tool", "pg_dump 백업 복원에는 대상 DB 연결 URL이 필요합니다.");
    const dumped = manifest.dbSchema ?? "public";
    const wanted = o.connection?.schema ?? "public";
    if (dumped !== wanted) {
      throw new RestoreError("schema_mismatch", `pg_dump 백업은 스키마 ${dumped} 의 덤프라 스키마 ${wanted} 로 복원할 수 없습니다. JSON 엔진 백업(\`ncs backup --engine json\`)을 쓰세요.`);
    }
    if (isolated) {
      // the dump recreates the schema itself: it must not exist yet; extensions must (the dump references them)
      const [ns] = await o.target.query<{ x: number }>(`SELECT 1 AS x FROM pg_namespace WHERE nspname = $1`, [wanted]);
      if (ns) throw new RestoreError("not_empty", `pg_dump 백업은 아직 없는 스키마로만 복원합니다. 스키마 ${wanted} 가 이미 있습니다. 새 스키마 이름(--target-schema)을 쓰세요.`);
      await prepareAppSchema(o.target, o.connection!, log, { createSchema: false });
    }
    const major = Math.floor((manifest.pgVersionNum ?? 0) / 10_000);
    const tool = o.pgRestoreTool !== undefined ? o.pgRestoreTool : findPgTool("pg_restore", major);
    if (!tool) throw new RestoreError("no_tool", `호환되는 pg_restore(PostgreSQL ${major} 이상)를 찾지 못했습니다.`);
    await runPgRestore(tool, { url: o.databaseUrl, file: join(o.bundleDir, manifest.db.file), connection: o.connection });
  }
  const migrated = await runMigrations(o.target, { ...runOpts, migrations });
  if (isolated) await hardenAppSchema(o.target, o.connection!, log);
  const restoredFiles = o.storageRoot ? await restoreFiles(o.bundleDir, manifest, o.storageRoot) : 0;
  return {
    manifest,
    engine: manifest.engine,
    restoredRows,
    appliedMigrations: migrated.applied,
    restoredFiles,
    missingFiles: manifest.missingFiles,
  };
}

/** Size of a bundle directory as recorded (manifest) or measured. */
export async function bundleSize(bundleDir: string): Promise<number> {
  try {
    return (await readManifest(bundleDir)).totalSizeBytes;
  } catch {
    return (await stat(bundleDir)).size;
  }
}
