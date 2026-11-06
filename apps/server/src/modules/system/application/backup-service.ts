/**
 * BackupService (MA-6; design/02 §8, 08 §8.3). Install-level backups into `<home>/backups`
 * (bundle layout → adapters/backup/backup-engine.ts), `backup_records` rows, audit
 * `backup.completed` / `backup.failed`, retention, scheduled catch-up and the `backup_location`
 * health check. Restore is CLI-only (server stopped) and uses the same engine.
 */
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { access, mkdir, readFile, rm, statfs, constants as fsc } from "node:fs/promises";
import { join } from "node:path";
import { expandHome, type DbConnection } from "@ncs/db";
import type { BackupRecordsRow } from "@ncs/db/schema";
import { actors, ConflictError, NotFoundError, type ActorRef, type Platform } from "../../../platform/index.js";
import type { AuditService } from "../../audit/index.js";
import type { BackupService, HealthCheckDefinition } from "../index.js";
import { backupRepo } from "../adapters/db/backup-repository.js";
import {
  bundleDirName,
  MANIFEST_FILE,
  targetFromDrizzle,
  verifyBundle,
  writeBundle,
  type BackupEngineChoice,
  type BackupManifest,
} from "../adapters/backup/backup-engine.js";
import type { PgTool } from "../adapters/backup/backup-pgtools.js";
import { retentionPlan, scheduleDecision, type ScheduleDecision } from "./backup-policy.js";

type Trigger = BackupRecordsRow["trigger"];

export interface BackupServiceDeps {
  platform: Platform;
  audit: AuditService;
  /** default InstallConfig `backup.dir`, else `<home>/backups` */
  backupsDir?: string;
  /** default "auto": pg_dump when available, else json */
  engine?: BackupEngineChoice;
  /** tests: force tool discovery result */
  pgDumpTool?: PgTool | null;
  /** resolved DB connection (pg_dump engine: URL, TLS, app schema); absent → derived from the client, public schema */
  connection?: DbConnection;
}

export interface RunBackupOptions {
  actor?: ActorRef;
  engine?: BackupEngineChoice;
  /** throw instead of returning the failed row */
  throwOnFailure?: boolean;
}

export interface RecordRestoredInput {
  backupId: string;
  bundle: string;
  engine: string | null;
  storageKey?: string;
  sizeBytes?: number;
  contentHash?: string;
  lastMigrationId?: string | null;
  finishedAt?: Date;
  details?: Record<string, unknown>;
}

export interface BackupServiceImpl extends BackupService {
  readonly backupsDir: string;
  runBackup(trigger: Trigger, opts?: RunBackupOptions): Promise<BackupRecordsRow>;
  getBackup(id: string): Promise<BackupRecordsRow>;
  /** absolute bundle directory of a succeeded backup */
  bundleDirOf(row: BackupRecordsRow): string;
  scheduleDecision(): Promise<ScheduleDecision>;
  /** loop tick: run a `scheduled` backup when due (missed-backup catch-up included) */
  runScheduledIfDue(): Promise<BackupRecordsRow | null>;
  applyRetention(): Promise<string[]>;
  /** boot recovery: rows left `running` by a crashed process → failed */
  recoverStale(): Promise<string[]>;
  /** called by `ncs restore` against the restored DB */
  recordRestored(input: RecordRestoredInput, actor?: ActorRef): Promise<void>;
  readonly healthCheck: HealthCheckDefinition;
}

/** postgres.js client options → URL (null for PGlite / unknown clients). */
function databaseUrlOf(db: unknown): string | null {
  const c = (db as { $client?: { options?: Record<string, unknown> } }).$client;
  const o = c?.options;
  if (!o || typeof (c as { unsafe?: unknown }).unsafe !== "function") return null;
  const host = Array.isArray(o.host) ? String(o.host[0]) : String(o.host ?? "127.0.0.1");
  const port = Array.isArray(o.port) ? Number(o.port[0]) : Number(o.port ?? 5432);
  const user = encodeURIComponent(String(o.user ?? ""));
  const pass = o.pass ? `:${encodeURIComponent(String(o.pass))}` : "";
  const database = encodeURIComponent(String(o.database ?? ""));
  return `postgres://${user}${pass}@${host.includes(":") ? `[${host}]` : host}:${port}/${database}`;
}

function errMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 2000) || "unknown error";
}

export function createBackupService(deps: BackupServiceDeps): BackupServiceImpl {
  const { platform, audit } = deps;
  const cfg = platform.config;
  const backupsDir = deps.backupsDir ?? (cfg.backup.dir ? expandHome(cfg.backup.dir) : join(cfg.home, "backups"));
  let running: Promise<BackupRecordsRow> | null = null;

  const bundleDirOf = (row: BackupRecordsRow) => {
    if (!row.storageKey) throw new ConflictError("backup_not_ready", "완료되지 않은 백업입니다.");
    return join(backupsDir, row.storageKey);
  };

  async function doBackup(trigger: Trigger, opts: RunBackupOptions): Promise<BackupRecordsRow> {
    const id = platform.ids.next("bkp");
    const startedAt = platform.clock.date();
    const actor = opts.actor ?? actors.system("backup");
    const rec = await backupRepo.insert(platform.uow.db, {
      id,
      status: "running",
      trigger,
      mode: cfg.backup.mode,
      startedAt,
      appVersion: platform.appVersion,
    });
    const dirName = bundleDirName(id, trigger, startedAt);
    try {
      await mkdir(backupsDir, { recursive: true, mode: 0o700 });
      const { manifest } = await writeBundle({
        target: targetFromDrizzle(platform.uow.db),
        bundleDir: join(backupsDir, dirName),
        storageRoot: platform.storage.root,
        backupId: id,
        trigger,
        mode: cfg.backup.mode,
        appVersion: platform.appVersion,
        now: startedAt,
        engine: opts.engine ?? deps.engine ?? "auto",
        databaseUrl: deps.connection?.url ?? databaseUrlOf(platform.uow.db),
        connection: deps.connection,
        pgDumpTool: deps.pgDumpTool,
        log: (m) => platform.log.debug({ backupId: id }, m),
      });
      const manifestHash = createHash("sha256")
        .update(await readFile(join(backupsDir, dirName, MANIFEST_FILE)))
        .digest("hex");
      const details = summarize(manifest, join(backupsDir, dirName));
      const done = await platform.uow.run(async (tx) => {
        const r = await backupRepo.succeed(tx.db, id, {
          finishedAt: platform.clock.date(),
          storageKey: dirName,
          sizeBytes: manifest.totalSizeBytes,
          contentHash: manifestHash,
          lastMigrationId: manifest.lastMigrationId,
          details,
        });
        await audit.record(tx, {
          novelId: null,
          actor,
          action: "backup.completed",
          target: { type: "settings", id: `backup.${id}` },
          details: { backupId: id, trigger, engine: manifest.engine, sizeBytes: manifest.totalSizeBytes, files: manifest.files.length, missingFiles: manifest.missingFiles.length },
        });
        return r;
      });
      platform.log.info({ backupId: id, trigger, engine: manifest.engine, dir: dirName }, "backup completed");
      try {
        await applyRetention();
      } catch (err) {
        platform.log.warn({ err }, "backup retention failed");
      }
      return done;
    } catch (err) {
      const message = errMessage(err);
      platform.log.error({ err, backupId: id }, "backup failed");
      const failed = await platform.uow.run(async (tx) => {
        const r = await backupRepo.fail(tx.db, id, { finishedAt: platform.clock.date(), errorMessage: message });
        await audit.record(tx, {
          novelId: null,
          actor,
          action: "backup.failed",
          target: { type: "settings", id: `backup.${id}` },
          details: { backupId: id, trigger, message },
        });
        return r;
      });
      if (opts.throwOnFailure) throw err;
      return failed ?? rec;
    }
  }

  function summarize(m: BackupManifest, dir: string) {
    return {
      engine: m.engine,
      path: dir,
      novelIds: m.novelIds,
      pgVersion: m.pgVersion,
      files: m.files.length,
      missingFiles: m.missingFiles,
      tables: m.db?.tables ? Object.keys(m.db.tables).length : null,
      rows: m.db?.tables ? Object.values(m.db.tables).reduce((s, t) => s + t.rows, 0) : null,
    };
  }

  async function applyRetention(): Promise<string[]> {
    const rows = await backupRepo.list(platform.uow.db, 10_000);
    const prune = retentionPlan(rows, { daily: cfg.backup.retention.daily, weekly: cfg.backup.retention.weekly });
    for (const id of prune) {
      const r = rows.find((x) => x.id === id);
      if (r?.storageKey) await rm(join(backupsDir, r.storageKey), { recursive: true, force: true });
    }
    await backupRepo.deleteMany(platform.uow.db, prune);
    if (prune.length) platform.log.info({ pruned: prune.length }, "backup retention applied");
    return prune;
  }

  const healthCheck: HealthCheckDefinition = {
    name: "backup_location",
    kind: "backup_location",
    scope: "install",
    async run() {
      try {
        await mkdir(backupsDir, { recursive: true, mode: 0o700 });
        await access(backupsDir, fsc.W_OK);
      } catch (err) {
        return { status: "fail", message: `백업 위치에 쓸 수 없습니다: ${errMessage(err)}`, details: { dir: backupsDir } };
      }
      const warnings: string[] = [];
      const details: Record<string, unknown> = { dir: backupsDir };
      try {
        const s = await statfs(backupsDir);
        const free = Number(s.bavail) * Number(s.bsize);
        details.freeBytes = free;
        if (free < 1 << 30) warnings.push("백업 위치의 남은 공간이 1GB보다 적습니다.");
      } catch {
        /* statfs unsupported */
      }
      try {
        const dataDir = cfg.database.embedded_data_dir ?? join(cfg.home, "data");
        const probe = existsSync(dataDir) ? dataDir : cfg.home;
        if (existsSync(probe) && statSync(probe).dev === statSync(backupsDir).dev) {
          details.sameDiskAsData = true;
          warnings.push("백업이 데이터와 같은 디스크에 있습니다(디스크 고장 시 복구 불가). 외부 경로를 지정하세요.");
        }
      } catch {
        /* ignore */
      }
      const rows = await backupRepo.list(platform.uow.db, 500);
      const lastOk = rows.find((r) => r.status === "succeeded");
      details.lastSucceededAt = lastOk?.finishedAt?.toISOString() ?? null;
      const now = platform.clock.date();
      if (!lastOk) warnings.push("아직 성공한 백업이 없습니다.");
      else if (now.getTime() - lastOk.finishedAt!.getTime() > cfg.backup.interval_hours * 3_600_000) {
        warnings.push(`마지막 성공 백업이 ${cfg.backup.interval_hours}시간보다 오래되었습니다.`);
      }
      const lastScheduled = rows.find((r) => r.trigger === "scheduled" && r.status !== "running");
      if (lastScheduled?.status === "failed") warnings.push(`최근 정기 백업이 실패했습니다: ${lastScheduled.errorMessage ?? ""}`.trim());
      return warnings.length
        ? { status: "warn", message: warnings.join(" "), details }
        : { status: "pass", message: "백업 위치 정상, 최근 백업이 주기 안에 있습니다.", details };
    },
  };

  const service: BackupServiceImpl = {
    backupsDir,
    healthCheck,
    bundleDirOf,
    async runBackup(trigger, opts = {}) {
      if (running) throw new ConflictError("backup_running", "이미 백업이 진행 중입니다. 끝난 뒤 다시 시도하세요.");
      running = doBackup(trigger, opts);
      try {
        return await running;
      } finally {
        running = null;
      }
    },
    listBackups: () => backupRepo.list(platform.uow.db),
    async getBackup(id) {
      const r = await backupRepo.get(platform.uow.db, id);
      if (!r) throw new NotFoundError("백업", id);
      return r;
    },
    async verifyBackup(backupId) {
      const r = await service.getBackup(backupId);
      if (r.status !== "succeeded") return { ok: false, message: "성공한 백업만 검증할 수 있습니다." };
      const v = await verifyBundle(bundleDirOf(r));
      return { ok: v.ok, message: v.message };
    },
    async scheduleDecision() {
      return scheduleDecision(await backupRepo.list(platform.uow.db, 500), platform.clock.date(), cfg.backup.interval_hours);
    },
    async runScheduledIfDue() {
      if (running) return null;
      const d = await service.scheduleDecision();
      if (!d.due) return null;
      platform.log.info({ reason: d.reason }, "scheduled backup due");
      return service.runBackup("scheduled");
    },
    applyRetention,
    async recoverStale() {
      return backupRepo.failStaleRunning(platform.uow.db, platform.clock.date(), "프로세스가 종료되어 백업이 중단되었습니다.");
    },
    async recordRestored(input, actor) {
      await platform.uow.run(async (tx) => {
        // the bundle's own row was captured as `running` inside its snapshot
        const own = await backupRepo.get(tx.db, input.backupId);
        if (own && own.status !== "succeeded" && input.storageKey) {
          await backupRepo.succeed(tx.db, input.backupId, {
            finishedAt: input.finishedAt ?? platform.clock.date(),
            storageKey: input.storageKey,
            sizeBytes: input.sizeBytes ?? 0,
            contentHash: input.contentHash ?? "",
            lastMigrationId: input.lastMigrationId ?? null,
            details: { restoredFromBundle: true },
          });
        }
        await audit.record(tx, {
          novelId: null,
          actor: actor ?? actors.system("backup"),
          action: "backup.restored",
          target: { type: "settings", id: `backup.${input.backupId}` },
          details: { backupId: input.backupId, bundle: input.bundle, engine: input.engine, ...input.details },
        });
      });
    },
  };
  return service;
}

/** default loop interval: check every 10 minutes (the decision itself uses the wall clock). */
export const BACKUP_LOOP_INTERVAL_MS = 10 * 60_000;

/** sanity helper for callers that only have a directory */
export function isBundleDir(dir: string): boolean {
  return existsSync(join(dir, MANIFEST_FILE));
}
