/**
 * Restore procedure (02 §8.4) — CLI only, server stopped.
 *  1. verify bundle, refuse while the server answers on its port
 *  2. `pre_restore` backup of the current DB (skippable with --skip-pre-restore / --force on failure)
 *  3. restore into a NEW database (embedded: `<db>_restore_<ts>` in the same cluster) with the
 *     bundle engine's path, migrations, row-count integrity, file hashes
 *  4. swap: current DB renamed `<db>_pre_restore_<ts>` (kept until the user drops it), new → `<db>`
 *  5. boot the core on the restored DB: pause every non-archived novel (`maintenance`), mark the
 *     bundle's own record succeeded + audit `backup.restored`, run health checks
 * Cluster won't start → new data dir `<dir>.restore-<ts>`, restore, swap dirs (`<dir>.broken-<ts>` kept).
 * Not yet: cost carry-over (step 5) and messenger reconciliation (step 6) — reported as a gap.
 */
import { existsSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { acquireInstanceAdvisoryLock, createDb, postgresJsTarget, readLiveServerLock } from "@ncs/db";
import type { InstallConfig } from "@ncs/shared";
import { embeddedDataDir, masterKeyFile, storageRoot } from "./config.js";
import { embeddedRuntime, qi, withAdmin, withDatabase } from "./db.js";
import { withCore, ownerActor } from "./core.js";
import { loadServer, type BackupEngineApi, type BackupManifestLike, type HealthResultLike } from "./server-loader.js";

export interface RestoreOptions {
  skipPreRestore?: boolean;
  force?: boolean;
  /** external DB mode: URL of a fresh, empty database to restore into */
  targetUrl?: string;
  log?: (msg: string) => void;
}

export interface RestoreReport {
  manifest: BackupManifestLike;
  engine: string | null;
  mode: "embedded" | "embedded_new_cluster" | "external";
  preRestoreBackupId: string | null;
  previousDatabase: string | null;
  previousDataDir: string | null;
  appliedMigrations: string[];
  restoredFiles: number;
  missingFiles: string[];
  pausedNovels: string[];
  health: HealthResultLike[];
  warnings: string[];
}

export function restoreStamp(d = new Date()): string {
  return d.toISOString().replace(/[-:T]/g, "").replace(/\.\d{3}Z$/, "").toLowerCase();
}

async function restoreInto(engine: BackupEngineApi, url: string, bundleDir: string, config: InstallConfig, appVersion: string, log: (m: string) => void) {
  const h = createDb(url, { max: 2 });
  try {
    return await engine.restoreBundle({
      target: postgresJsTarget(h.sql),
      bundleDir,
      storageRoot: storageRoot(config),
      appVersion,
      requireExtensions: ["btree_gist"],
      databaseUrl: url,
      log,
    });
  } finally {
    await h.close();
  }
}

/**
 * 02 §2.3 / §8.4: restore needs the server stopped. The HTTP probe alone misses a server bound to another
 * host (env-only NCS_HOST), so the lock file and the DB `instance_lock` decide.
 */
export function assertNoLiveServerLock(config: InstallConfig): void {
  const holder = readLiveServerLock(config.home);
  if (holder) throw new Error(`서버가 실행 중입니다(pid ${holder.pid}, ${holder.host}:${holder.port}). 서버를 멈춘 뒤 다시 실행하세요.`);
}
export async function assertNoInstanceLock(url: string): Promise<void> {
  const lock = await acquireInstanceAdvisoryLock(url, { retries: 0 }).catch(() => null);
  if (!lock) throw new Error("다른 서버 프로세스가 이 데이터베이스를 쓰고 있습니다(instance_lock). 서버를 멈춘 뒤 다시 실행하세요.");
  await lock.release();
}

export async function runRestore(config: InstallConfig, bundleDir: string, engine: BackupEngineApi, o: RestoreOptions = {}): Promise<RestoreReport> {
  const log = o.log ?? (() => {});
  assertNoLiveServerLock(config);
  const server = await loadServer();
  const v = await engine.verifyBundle(bundleDir);
  if (!v.ok || !v.manifest) throw new Error(v.message);
  const manifest = v.manifest;
  const ts = restoreStamp();
  const warnings: string[] = [
    "백업 이후의 비용 이월(02 §8.4 5단계)과 메신저 정합(6단계)은 이 버전에서 수행하지 않습니다. 공급자 콘솔에서 실제 지출을 확인하세요.",
  ];
  if (!existsSync(masterKeyFile(config))) {
    warnings.push("비밀 마스터 키 파일이 없습니다. 원래 기기의 master.key 를 옮기거나 `ncs secrets set` 으로 비밀을 다시 입력하세요.");
  }

  let preRestoreBackupId: string | null = null;
  let previousDatabase: string | null = null;
  let previousDataDir: string | null = null;
  let mode: RestoreReport["mode"];
  let restored: Awaited<ReturnType<BackupEngineApi["restoreBundle"]>>;
  let postConfig = config;

  const preRestore = async () => {
    if (o.skipPreRestore) return;
    try {
      const row = await withCore(config, (core) => core.modules.system.service.backups.runBackup("pre_restore", { throwOnFailure: true }));
      preRestoreBackupId = row.id;
      log(`pre_restore 백업 완료: ${row.id}`);
    } catch (err) {
      if (!o.force) throw new Error(`복원 전 백업(pre_restore)에 실패했습니다: ${(err as Error).message}. --force 로 건너뛸 수 있습니다.`);
      warnings.push(`pre_restore 백업 실패(무시함): ${(err as Error).message}`);
    }
  };

  if (config.database.mode === "external") {
    if (!o.targetUrl) throw new Error("외부 DB 모드는 --target-url <새 빈 DB URL> 이 필요합니다. 복원 후 DATABASE_URL 을 그 DB로 바꾸세요.");
    mode = "external";
    if (config.database.url) await assertNoInstanceLock(config.database.url);
    await preRestore();
    restored = await restoreInto(engine, o.targetUrl, bundleDir, config, server.APP_VERSION, log);
    postConfig = { ...config, database: { ...config.database, url: o.targetUrl } };
    warnings.push(`DATABASE_URL(또는 database.url)을 복원한 DB로 바꾼 뒤 서버를 시작하세요.`);
  } else {
    const rt = embeddedRuntime(config);
    let clusterOk = true;
    try {
      await rt.start();
    } catch (err) {
      clusterOk = false;
      log(`내장 PostgreSQL 이 기동하지 않습니다(${(err as Error).message}). 새 데이터 디렉터리로 복원합니다.`);
    }
    if (clusterOk) {
      mode = "embedded";
      try {
        await assertNoInstanceLock(rt.url);
        await preRestore();
        const appDb = rt.database;
        const newDb = `${appDb}_restore_${ts}`;
        await withAdmin(rt.url, (sql) => sql.unsafe(`CREATE DATABASE ${qi(newDb)} ENCODING 'UTF8'`));
        const newUrl = withDatabase(rt.url, newDb);
        try {
          restored = await restoreInto(engine, newUrl, bundleDir, config, server.APP_VERSION, log);
        } catch (err) {
          await withAdmin(rt.url, (sql) => sql.unsafe(`DROP DATABASE IF EXISTS ${qi(newDb)}`)).catch(() => {});
          throw err;
        }
        previousDatabase = `${appDb}_pre_restore_${ts}`;
        await withAdmin(rt.url, async (sql) => {
          await sql.unsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ($1, $2) AND pid <> pg_backend_pid()`, [appDb, newDb]);
          const exists = await sql.unsafe(`SELECT 1 FROM pg_database WHERE datname = $1`, [appDb]);
          if (exists.length) await sql.unsafe(`ALTER DATABASE ${qi(appDb)} RENAME TO ${qi(previousDatabase!)}`);
          else previousDatabase = null;
          await sql.unsafe(`ALTER DATABASE ${qi(newDb)} RENAME TO ${qi(appDb)}`);
        });
      } finally {
        await rt.stop();
      }
    } else {
      mode = "embedded_new_cluster";
      warnings.push("기존 DB를 읽을 수 없어 pre_restore 백업을 건너뛰었습니다. 백업 이후 비용·답변은 복구되지 않습니다.");
      const dataDir = embeddedDataDir(config);
      const newDir = `${dataDir}.restore-${ts}`;
      const rt2 = embeddedRuntime(config, { dataDir: newDir });
      await rt2.start();
      try {
        restored = await restoreInto(engine, rt2.url, bundleDir, config, server.APP_VERSION, log);
      } catch (err) {
        await rt2.stop().catch(() => {});
        await rm(newDir, { recursive: true, force: true });
        throw err;
      }
      await rt2.stop();
      previousDataDir = `${dataDir}.broken-${ts}`;
      if (existsSync(dataDir)) await rename(dataDir, previousDataDir);
      else previousDataDir = null;
      await rename(newDir, dataDir);
    }
  }

  // post-restore: pause novels, mark own record, audit, health
  const post = await withCore(postConfig, async (core) => {
    const actor = await ownerActor(core);
    const paused: string[] = [];
    for (const n of await core.modules.novel.service.listNovels()) {
      if (n.pausedAt) continue;
      try {
        await core.modules.novel.service.pause({ novelId: n.id }, "maintenance", actor, { note: `restore ${manifest.backupId}` });
        paused.push(n.id);
      } catch (err) {
        warnings.push(`작품 ${n.id} 일시정지 실패: ${(err as Error).message}`);
      }
    }
    await core.modules.system.service.backups.recordRestored?.({
      backupId: manifest.backupId,
      bundle: bundleDir,
      engine: manifest.engine,
      storageKey: bundleDir.split(/[\\/]/).at(-1),
      sizeBytes: manifest.totalSizeBytes,
      lastMigrationId: manifest.lastMigrationId,
      finishedAt: new Date(manifest.createdAt),
      details: { preRestoreBackupId, previousDatabase, previousDataDir, pausedNovels: paused.length, mode },
    });
    const health = await core.modules.system.service.runHealthChecks({ timeoutMs: 10_000 });
    return { paused, health };
  });

  return {
    manifest,
    engine: restored.engine,
    mode,
    preRestoreBackupId,
    previousDatabase,
    previousDataDir,
    appliedMigrations: restored.appliedMigrations,
    restoredFiles: restored.restoredFiles,
    missingFiles: restored.missingFiles,
    pausedNovels: post.paused,
    health: post.health,
    warnings,
  };
}
