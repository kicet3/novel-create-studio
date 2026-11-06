/**
 * Composition root (08 §2.2): config → DB (embedded or external, migrated) → platform → modules →
 * HTTP listen → background runtime. SIGINT/SIGTERM → graceful shutdown (02 §7.3):
 * stop accepting HTTP, stop loops (in-flight runs reach a safe point or are reclaimed on next boot),
 * close DB, stop embedded PG.
 */
import "dotenv/config";
import type { LlmAdapter } from "./modules/llm/index.js";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import {
  acquireInstanceAdvisoryLock,
  acquireServerLock,
  expandHome,
  describeConnection,
  loadMigrations,
  migrateDatabase,
  openDatabase,
  postgresJsTarget,
  redactDatabaseSecrets,
  type DbConnection,
  type HeldAdvisoryLock,
  type HeldServerLock,
  type MigrationTarget,
  type OpenedDatabase,
} from "@ncs/db";
import { DEFAULTS, isLoopbackHost, ulid, type InstallConfig } from "@ncs/shared";
import { bundleDirName, writeBundle } from "./modules/system/adapters/backup/backup-engine.js";
import { loadInstallConfig } from "./platform/config.js";
import { createLogger } from "./platform/logger.js";
import { createServerCore, type ServerCore } from "./app-core.js";

export const APP_VERSION = "0.1.0";

export interface StartedServer {
  config: InstallConfig;
  database: OpenedDatabase;
  core: ServerCore;
  server: Server;
  url: string;
  stop(): Promise<void>;
}

export interface StartServerOptions {
  /** test harness only (extra LLM adapters); production passes nothing */
  llmAdapters?: LlmAdapter[];
}

export async function startServer(config: InstallConfig = loadInstallConfig(), opts: StartServerOptions = {}): Promise<StartedServer> {
  const log = createLogger(config.logging.level, { pretty: process.env.NCS_LOG_PRETTY === "1" });
  const providers = new Set(["anthropic", "claude_code", "openai", "xai", "google", ...(opts.llmAdapters ?? []).map((a) => a.provider)]);
  if (!providers.has(config.llm.provider)) {
    // a provider this server has no adapter for runs on Claude
    log.warn({ configured: config.llm.provider }, "LLM provider not available in this server; using anthropic (Claude API)");
    config = { ...config, llm: { ...config.llm, provider: "anthropic" } };
  }
  if (!config.server.web_dist_dir) {
    const guess = fileURLToPath(new URL("../../web/dist/", import.meta.url));
    if (existsSync(resolve(guess, "index.html"))) config = { ...config, server: { ...config.server, web_dist_dir: guess } };
  }
  // embedded-postgres registers async-exit-hook (SIGINT/SIGTERM/beforeExit → stop PG + process.exit) at import time,
  // which races the graceful shutdown below (02 §7.3). The caller of startServer owns signals; stop() stops PG.
  for (const ev of ["SIGINT", "SIGTERM", "beforeExit"] as const) process.removeAllListeners(ev);
  const dbLog = (m: string) => (m.startsWith("[pg") ? log.debug(m) : log.info(m));
  // 02 §2.3 single instance, step 1: `$NCS_HOME/run/server.lock` (before touching PG, so a second
  // process never attaches to the live postmaster nor runs its startup reclaim)
  const fileLock: HeldServerLock = acquireServerLock(config.home, { host: config.server.host, port: config.server.port });
  let dbLock: HeldAdvisoryLock | null = null;
  let database: OpenedDatabase;
  try {
    // migrations run here (not inside openDatabase) so a `pre_migration` backup can be taken first (08 §4.3, NFR-REL-05)
    database = await openDatabase(config, { appVersion: APP_VERSION, migrate: false, log: dbLog });
  } catch (err) {
    fileLock.release();
    throw scrubDbError(err, config.database.url);
  }
  const dbInfo = describeConnection(database.connection);
  if (database.schemaInspection) log.info({ db: dbInfo, plan: database.schemaInspection.plan }, "database target schema checked");
  let applied: string[] = [];
  try {
    // step 2 (both modes): session advisory lock `instance_lock` on a dedicated connection
    dbLock = await acquireInstanceAdvisoryLock(database.connection);
    if (config.database.auto_migrate) {
      const target = postgresJsTarget(database.sql);
      applied = (
        await migrateDatabase(target, database.connection, {
          appVersion: APP_VERSION,
          log: dbLog,
          beforeMigrations: () => preMigrationBackup(config, target, database.connection, dbLog),
        })
      ).applied;
    }
  } catch (err) {
    await dbLock?.release();
    await database.close();
    fileLock.release();
    throw scrubDbError(err, config.database.url);
  }
  log.info({ mode: database.mode, db: dbInfo, applied }, "database ready");

  let core: ServerCore;
  try {
    core = createServerCore({ config, appVersion: APP_VERSION, db: database.db, log, databaseMode: database.mode, database: database.connection, llmAdapters: opts.llmAdapters });
    await core.start({ background: false });
  } catch (err) {
    await dbLock?.release();
    await database.close();
    fileLock.release();
    throw err;
  }

  const server = await new Promise<Server>((res, rej) => {
    const s = core.app.listen(config.server.port, config.server.host, () => res(s));
    s.once("error", rej);
  });
  const url = `http://${config.server.host.includes(":") ? `[${config.server.host}]` : config.server.host}:${config.server.port}`;
  log.info({ url }, "server listening");
  if (config.deployment_mode === "local_trusted" && !isLoopbackHost(config.server.host)) {
    log.warn(
      { host: config.server.host, allowedHostnames: config.server.allowed_hostnames },
      "local_trusted server bound to a non-loopback address: every device that can reach it has full access (no login)",
    );
  }

  for (const m of Object.values(core.modules)) for (const loop of m.loops ?? []) core.runtime.add(loop);
  core.runtime.start();

  let stopping: Promise<void> | null = null;
  return {
    config,
    database,
    core,
    server,
    url,
    stop() {
      stopping ??= (async () => {
        await new Promise<void>((r) => {
          server.close(() => r());
          server.closeAllConnections?.();
        });
        await core.stop();
        await dbLock?.release();
        await database.close();
        fileLock.release();
        log.info("server stopped");
      })();
      return stopping;
    },
  };
}

/** when an already-initialised DB has pending migrations, write a `pre_migration` bundle (JSON/pg_dump engine) and record it */
async function preMigrationBackup(config: InstallConfig, target: MigrationTarget, connection: DbConnection, log: (m: string) => void): Promise<void> {
  // unqualified: resolved through the connection's search_path (app schema on Supabase, public otherwise)
  const [reg] = await target.query<{ r: string | null }>(`SELECT to_regclass('app_migrations')::text AS r`);
  if (!reg?.r) return; // fresh database
  const applied = new Set((await target.query<{ id: string }>(`SELECT id FROM app_migrations`)).map((r) => r.id));
  if (applied.size === 0) return;
  const pending = loadMigrations().filter((m) => !applied.has(m.id));
  if (pending.length === 0) return;
  const now = new Date();
  const id = `bkp_${ulid(now.getTime())}`;
  const dir = config.backup.dir ? expandHome(config.backup.dir) : join(config.home, "backups");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const name = bundleDirName(id, "pre_migration", now);
  log(`pre_migration backup before ${pending.map((m) => m.id).join(", ")} → ${join(dir, name)}`);
  const { manifest } = await writeBundle({
    target,
    bundleDir: join(dir, name),
    storageRoot: expandHome(config.storage.root ?? join(config.home, "files")),
    backupId: id,
    trigger: "pre_migration",
    mode: config.backup.mode,
    appVersion: APP_VERSION,
    now,
    databaseUrl: connection.url,
    connection,
    log,
  });
  await target.query(
    `INSERT INTO backup_records (id, status, trigger, mode, started_at, finished_at, storage_key, size_bytes, app_version, last_migration_id, details)
     VALUES ($1, 'succeeded', 'pre_migration', $2, $3, now(), $4, $5, $6, $7, $8::jsonb)`,
    [id, config.backup.mode, now, name, manifest.totalSizeBytes, APP_VERSION, manifest.lastMigrationId, JSON.stringify({ engine: manifest.engine, via: "server_boot" })],
  );
}

/** errors bubbling out of DB setup must never carry the connection string / password */
function scrubDbError(err: unknown, url: string | undefined): unknown {
  if (!(err instanceof Error) || !url) return err;
  const message = redactDatabaseSecrets(err.message, url);
  if (message !== err.message) err.message = message;
  if (err.stack) err.stack = redactDatabaseSecrets(err.stack, url);
  return err;
}

const isEntry = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  const started = await startServer().catch((err: unknown) => {
    // 02 §2.3: a second instance exits with a readable message (no stack trace)
    if (err instanceof Error && (err.name === "InstanceLockError" || err.name === "DatabaseConfigError")) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  });
  const shutdown = async (sig: string) => {
    console.log(`received ${sig}, shutting down`);
    // 02 §7.3: runs get `shutdown.grace_seconds` to save their in-flight response; then a hard stop
    const force = setTimeout(() => process.exit(1), DEFAULTS["shutdown.grace_seconds"] * 1000 + 15_000);
    force.unref();
    try {
      await started.stop();
      process.exit(0);
    } catch (err) {
      console.error(err);
      process.exit(1);
    }
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}
