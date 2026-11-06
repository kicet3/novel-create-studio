/**
 * PostgreSQL client tools for the `pg_dump` backup engine (02 §8.2 decision table, S-7).
 * embedded-postgres does NOT ship pg_dump/pg_restore, so we look on PATH and in common install
 * locations (Homebrew `postgresql@N`, Postgres.app, Debian `/usr/lib/postgresql/N/bin`) and pick the
 * highest major that is ≥ the server major (pg_dump refuses older-than-server).
 */
import { libpqEnv, redactDatabaseSecrets, type DbConnection } from "@ncs/db";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface PgTool {
  path: string;
  major: number;
  version: string;
}

export function parsePgToolVersion(out: string): { major: number; version: string } | null {
  const m = /\(PostgreSQL\)\s+(\d+)(?:\.(\d+))?/.exec(out) ?? /\b(\d+)\.(\d+)\b/.exec(out);
  if (!m) return null;
  return { major: Number(m[1]), version: m[2] ? `${m[1]}.${m[2]}` : m[1]! };
}

function globDirs(parent: string, re: RegExp, sub: string): string[] {
  try {
    return readdirSync(parent)
      .filter((d) => re.test(d))
      .map((d) => join(parent, d, sub));
  } catch {
    return [];
  }
}

/** Candidate directories, most specific first. `env` / `extraDirs` make it testable. */
export function pgToolCandidateDirs(env: NodeJS.ProcessEnv = process.env, extraDirs: string[] = []): string[] {
  const dirs = [
    ...extraDirs,
    ...(env.NCS_PG_BIN_DIR ? [env.NCS_PG_BIN_DIR] : []),
    ...(env.PATH ?? "").split(delimiter).filter(Boolean),
    ...globDirs("/opt/homebrew/opt", /^postgresql(@\d+)?$/, "bin"),
    ...globDirs("/usr/local/opt", /^postgresql(@\d+)?$/, "bin"),
    ...globDirs("/Applications/Postgres.app/Contents/Versions", /^\d+/, "bin"),
    ...globDirs("/usr/lib/postgresql", /^\d+$/, "bin"),
  ];
  return [...new Set(dirs)];
}

export function probePgTool(path: string): PgTool | null {
  try {
    const out = execFileSync(path, ["--version"], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });
    const v = parsePgToolVersion(out);
    return v ? { path, ...v } : null;
  } catch {
    return null;
  }
}

export function findPgTool(
  name: "pg_dump" | "pg_restore",
  minMajor: number,
  opts: { env?: NodeJS.ProcessEnv; extraDirs?: string[]; probe?: (p: string) => PgTool | null } = {},
): PgTool | null {
  const probe = opts.probe ?? probePgTool;
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  let best: PgTool | null = null;
  for (const dir of pgToolCandidateDirs(opts.env, opts.extraDirs)) {
    const p = join(dir, exe);
    if (!opts.probe && !existsSync(p)) continue;
    const t = probe(p);
    if (t && t.major >= minMajor && (!best || t.major > best.major)) best = t;
  }
  return best;
}

/** Split credentials out of the URL so the password is passed via PGPASSWORD (not argv). */
export function connectionArgs(url: string): { dbname: string; env: Record<string, string> } {
  const u = new URL(url);
  const password = decodeURIComponent(u.password);
  u.password = "";
  return { dbname: u.toString(), env: password ? { PGPASSWORD: password } : {} };
}

function run(tool: PgTool, args: string[], env: Record<string, string>, url: string): Promise<void> {
  return new Promise((res, rej) => {
    execFile(tool.path, args, { env: { ...process.env, ...env }, maxBuffer: 16 << 20 }, (err, _out, stderr) => {
      // err.message contains the command line (--dbname=…): never surface it raw
      if (err) rej(new Error(`${tool.path} 실패: ${redactDatabaseSecrets(String(stderr || `exit ${err.code ?? "?"}`).trim(), url).slice(0, 500)}`));
      else res();
    });
  });
}

/** `schema`: dump only the app schema (a shared Supabase project has auth/storage/other apps' schemas too) */
export async function runPgDump(tool: PgTool, o: { url: string; snapshot: string; file: string; schema?: string | null; connection?: DbConnection }): Promise<void> {
  const c = connectionArgs(o.url);
  const args = ["-Fc", "--no-owner", "--no-privileges", `--snapshot=${o.snapshot}`, "-f", o.file];
  if (o.schema) args.push(`--schema=${o.schema}`);
  args.push(`--dbname=${c.dbname}`);
  await run(tool, args, { ...(o.connection ? libpqEnv(o.connection) : {}), ...c.env }, o.url);
}

export async function runPgRestore(tool: PgTool, o: { url: string; file: string; connection?: DbConnection }): Promise<void> {
  const c = connectionArgs(o.url);
  await run(tool, ["--no-owner", "--no-privileges", "--exit-on-error", `--dbname=${c.dbname}`, o.file], { ...(o.connection ? libpqEnv(o.connection) : {}), ...c.env }, o.url);
}
