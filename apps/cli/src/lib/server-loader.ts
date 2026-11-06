/**
 * Loads `@ncs/server` lazily (only `run`, `doctor`, `backup`, `restore`, `secrets`, `onboard` need it).
 * Resolution order: the `@ncs/server` package (once it is a dependency of @ncs/cli), then the monorepo
 * sibling `apps/server` — TS sources when this CLI itself runs from sources (tsx), else `dist/`.
 * Types are declared structurally here so the CLI does not compile against server sources.
 */
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface ServerCoreLike {
  platform: { storage: { root: string }; config: unknown; log: any; uow: any };
  modules: {
    system: { service: SystemServiceLike };
    novel: { service: NovelServiceLike };
    messaging?: { service: { registerBot?: (input: any, actor: any) => Promise<{ id: string }> } };
    audit: { service: { record(tx: any, input: any): Promise<unknown> } };
    [k: string]: any;
  };
  start(opts?: { background?: boolean }): Promise<void>;
  stop(): Promise<void>;
}

export interface SystemServiceLike {
  secrets: {
    get(id: string): Promise<string | null>;
    set(id: string, value: string, label?: string): Promise<void>;
    has(id: string): Promise<boolean>;
    delete(id: string): Promise<boolean>;
    list(): Promise<Array<{ id: string; label: string | null; updatedAt: Date }>>;
  };
  backups: {
    runBackup(trigger: string, opts?: { engine?: string; throwOnFailure?: boolean }): Promise<BackupRowLike>;
    listBackups(): Promise<BackupRowLike[]>;
    verifyBackup(id: string): Promise<{ ok: boolean; message: string }>;
    backupsDir?: string;
    recordRestored?(input: Record<string, unknown>): Promise<void>;
  };
  listHealthChecks(): Array<{ name: string; kind: string; scope: string }>;
  runHealthChecks(opts?: Record<string, unknown>): Promise<HealthResultLike[]>;
}

export interface NovelServiceLike {
  getOwnerUser(): Promise<{ id: string } | null>;
  listNovels(opts?: { includeArchived?: boolean }): Promise<Array<{ id: string; title: string; status: string; pausedAt?: Date | null; pauseReason?: string | null }>>;
  pause(scope: { novelId: string }, reason: string, actor: unknown, opts?: Record<string, unknown>): Promise<unknown>;
}

export interface BackupRowLike {
  id: string;
  status: string;
  trigger: string;
  startedAt: Date | string;
  finishedAt: Date | string | null;
  storageKey: string | null;
  sizeBytes: number | null;
  errorMessage: string | null;
  details: unknown;
}

export interface HealthResultLike {
  name: string;
  kind: string;
  status: "pass" | "warn" | "fail";
  message: string;
  novelId: string | null;
  details?: unknown;
}

export interface StartedServerLike {
  url: string;
  stop(): Promise<void>;
}

export interface ServerApi {
  APP_VERSION: string;
  startServer(config?: unknown): Promise<StartedServerLike>;
  createServerCore(o: { config: unknown; appVersion: string; db: unknown; log: unknown; databaseMode: "embedded" | "external"; database?: unknown }): ServerCoreLike;
  createLogger(level: string, opts?: { pretty?: boolean }): unknown;
  /** present once the integration exports it from @ncs/server */
  backupEngine?: BackupEngineApi;
}

export interface BackupManifestLike {
  backupId: string;
  trigger: string;
  mode: string;
  engine: "pg_dump" | "json" | null;
  appVersion: string;
  lastMigrationId: string | null;
  pgVersion: string | null;
  createdAt: string;
  novelIds: string[];
  files: Array<{ key: string; sha256: string; size: number }>;
  missingFiles: string[];
  totalSizeBytes: number;
}

export interface BackupEngineApi {
  writeBundle(o: Record<string, unknown>): Promise<{ manifest: BackupManifestLike; bundleDir: string }>;
  restoreBundle(o: Record<string, unknown>): Promise<{
    manifest: BackupManifestLike;
    engine: string | null;
    restoredRows: Record<string, number>;
    appliedMigrations: string[];
    restoredFiles: number;
    missingFiles: string[];
  }>;
  verifyBundle(dir: string): Promise<{ ok: boolean; message: string; manifest?: BackupManifestLike; problems: string[] }>;
  readManifest(dir: string): Promise<BackupManifestLike>;
  bundleDirName(id: string, trigger: string, at: Date): string;
  RestoreError: new (...args: any[]) => Error & { code: string };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const runningFromSource = () => import.meta.url.endsWith(".ts");

function candidates(rel: { src: string; dist: string }): string[] {
  const base = new URL("../../../server/", import.meta.url);
  const out: string[] = [];
  const src = fileURLToPath(new URL(rel.src, base));
  const dist = fileURLToPath(new URL(rel.dist, base));
  if (runningFromSource() && existsSync(src)) out.push(pathToFileURL(src).href);
  if (existsSync(dist)) out.push(pathToFileURL(dist).href);
  if (!runningFromSource() && existsSync(src)) out.push(pathToFileURL(src).href);
  return out;
}

async function importFirst<T>(specs: string[], what: string): Promise<T> {
  const errors: string[] = [];
  for (const s of specs) {
    try {
      return (await import(/* @vite-ignore */ s)) as T;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ERR_MODULE_NOT_FOUND" && code !== "ERR_PACKAGE_PATH_NOT_EXPORTED" && code !== "ERR_UNKNOWN_FILE_EXTENSION") throw err;
      errors.push(`${s}: ${(err as Error).message.split("\n")[0]}`);
    }
  }
  throw new Error(`${what} 를 불러올 수 없습니다. 서버를 빌드했는지 확인하세요(pnpm --filter @ncs/server build).\n${errors.join("\n")}`);
}

let serverP: Promise<ServerApi> | null = null;
export function loadServer(): Promise<ServerApi> {
  serverP ??= importFirst<ServerApi>(["@ncs/server", ...candidates({ src: "src/index.ts", dist: "dist/index.js" })], "@ncs/server");
  return serverP;
}

let engineP: Promise<BackupEngineApi> | null = null;
export function loadBackupEngine(): Promise<BackupEngineApi> {
  engineP ??= (async () => {
    try {
      const s = await loadServer();
      if (s.backupEngine) return s.backupEngine;
    } catch {
      /* fall through to the direct file */
    }
    return importFirst<BackupEngineApi>(
      candidates({ src: "src/modules/system/adapters/backup/backup-engine.ts", dist: "dist/modules/system/adapters/backup/backup-engine.js" }),
      "backup engine",
    );
  })();
  return engineP;
}
