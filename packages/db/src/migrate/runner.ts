/**
 * Own migration runner (design/08 §4.2).
 * - files: `src/migrations/NNNN_<slug>.sql` (4-digit, contiguous, no duplicates)
 * - one file = one transaction; recorded in `app_migrations(id, name, checksum, applied_at, app_version, duration_ms)`
 * - checksum (SHA-256) mismatch of an already-applied file → refuse to start
 * - DB that has migrations this app doesn't know (newer DB) → refuse
 * - destructive statements need a `-- ncs:destructive <reason>` header
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface MigrationFile {
  /** 4-digit number, e.g. "0001" */
  id: string;
  /** slug, e.g. "init" */
  name: string;
  sql: string;
  checksum: string;
}

/** Minimal SQL surface the runner needs; adapters exist for postgres.js and PGlite. */
export interface MigrationTarget {
  /** Execute one or more statements (no parameters). */
  exec(sql: string): Promise<void>;
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  transaction<R>(fn: (tx: MigrationTarget) => Promise<R>): Promise<R>;
}

export interface RunMigrationsOptions {
  appVersion: string;
  migrations?: MigrationFile[];
  /** Extensions that must be available/installed (runtime: ["btree_gist"]). */
  requireExtensions?: string[];
  log?: (msg: string) => void;
}

export interface RunMigrationsResult {
  applied: string[];
  alreadyApplied: string[];
}

export class MigrationError extends Error {
  constructor(
    message: string,
    readonly code: "checksum_mismatch" | "unknown_applied" | "bad_numbering" | "destructive" | "missing_extension" | "apply_failed",
    readonly migrationId?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "MigrationError";
  }
}

export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

const FILE_RE = /^(\d{4})_([a-z0-9][a-z0-9_]*)\.sql$/;
const DESTRUCTIVE_RE = /\b(DROP\s+TABLE|DROP\s+COLUMN|ALTER\s+COLUMN\s+\w+\s+(SET\s+DATA\s+)?TYPE|RENAME\s+(COLUMN|TO))\b/i;

export function checksumOf(sql: string): string {
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");
}

/** Load and validate migration files from a directory. */
export function loadMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): MigrationFile[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const out: MigrationFile[] = [];
  for (const f of files) {
    const m = FILE_RE.exec(f);
    if (!m) throw new MigrationError(`Bad migration file name: ${f} (expected NNNN_slug.sql)`, "bad_numbering");
    const sql = readFileSync(`${dir.replace(/\/$/, "")}/${f}`, "utf8");
    out.push({ id: m[1]!, name: m[2]!, sql, checksum: checksumOf(sql) });
  }
  validateMigrations(out);
  return out;
}

export function validateMigrations(migrations: MigrationFile[]): void {
  migrations.forEach((m, i) => {
    const expected = String(i + 1).padStart(4, "0");
    if (m.id !== expected) {
      throw new MigrationError(`Migration numbering gap/duplicate: expected ${expected}, found ${m.id}_${m.name}`, "bad_numbering", m.id);
    }
    const header = m.sql.split("\n").slice(0, 5).join("\n");
    if (DESTRUCTIVE_RE.test(stripComments(m.sql)) && !/--\s*ncs:destructive\s+\S/.test(header)) {
      throw new MigrationError(`Migration ${m.id}_${m.name} contains a destructive statement without '-- ncs:destructive <reason>' header`, "destructive", m.id);
    }
  });
}

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS app_migrations (
  id text PRIMARY KEY,
  name text NOT NULL,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  app_version text NOT NULL,
  duration_ms integer NOT NULL
)`;

/** Advisory lock key for migrations ("ncs_migrate"). */
const LOCK_KEY = 7_366_362_101;

export async function runMigrations(target: MigrationTarget, opts: RunMigrationsOptions): Promise<RunMigrationsResult> {
  const migrations = opts.migrations ?? loadMigrations();
  validateMigrations(migrations);
  const log = opts.log ?? (() => {});

  if (opts.requireExtensions?.length) {
    const rows = await target.query<{ name: string }>(`SELECT name FROM pg_available_extensions WHERE name = ANY($1::text[])`, [opts.requireExtensions]);
    const available = new Set(rows.map((r) => r.name));
    const missing = opts.requireExtensions.filter((e) => !available.has(e));
    if (missing.length) {
      throw new MigrationError(`Required PostgreSQL extension(s) not available: ${missing.join(", ")}`, "missing_extension");
    }
  }

  await target.exec(CREATE_TABLE);
  const applied = await target.query<{ id: string; name: string; checksum: string }>(`SELECT id, name, checksum FROM app_migrations ORDER BY id`);
  const known = new Map(migrations.map((m) => [m.id, m]));
  for (const row of applied) {
    const file = known.get(row.id);
    if (!file) {
      throw new MigrationError(`Database has migration ${row.id}_${row.name} unknown to this app version (database is newer?)`, "unknown_applied", row.id);
    }
    if (file.checksum !== row.checksum) {
      throw new MigrationError(`Checksum mismatch for applied migration ${row.id}_${row.name}: the file was modified after it was applied`, "checksum_mismatch", row.id);
    }
  }

  const appliedIds = new Set(applied.map((r) => r.id));
  const result: RunMigrationsResult = { applied: [], alreadyApplied: [...appliedIds] };
  for (const m of migrations) {
    if (appliedIds.has(m.id)) continue;
    const started = Date.now();
    try {
      const done = await target.transaction(async (tx) => {
        await tx.query(`SELECT pg_advisory_xact_lock($1)`, [LOCK_KEY]);
        // re-check under the lock (another process may have applied it meanwhile)
        const again = await tx.query(`SELECT 1 AS x FROM app_migrations WHERE id = $1`, [m.id]);
        if (again.length) return false;
        await tx.exec(m.sql);
        await tx.query(`INSERT INTO app_migrations (id, name, checksum, app_version, duration_ms) VALUES ($1, $2, $3, $4, $5)`, [
          m.id,
          m.name,
          m.checksum,
          opts.appVersion,
          Date.now() - started,
        ]);
        return true;
      });
      if (done) {
        result.applied.push(m.id);
        log(`applied migration ${m.id}_${m.name} (${Date.now() - started} ms)`);
      }
    } catch (err) {
      if (err instanceof MigrationError) throw err;
      throw new MigrationError(`Migration ${m.id}_${m.name} failed: ${(err as Error).message}`, "apply_failed", m.id, { cause: err });
    }
  }

  if (opts.requireExtensions?.length) {
    const rows = await target.query<{ extname: string }>(`SELECT extname FROM pg_extension WHERE extname = ANY($1::text[])`, [opts.requireExtensions]);
    const installed = new Set(rows.map((r) => r.extname));
    const missing = opts.requireExtensions.filter((e) => !installed.has(e));
    if (missing.length) throw new MigrationError(`Required extension(s) not installed after migration: ${missing.join(", ")}`, "missing_extension");
  }
  return result;
}
