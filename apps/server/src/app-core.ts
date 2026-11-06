/**
 * Server core without process concerns: platform → modules → HTTP app → runtime.
 * Used by main.ts (real DB) and by tests (PGlite via @ncs/db/testing).
 */
import type { Express } from "express";
import type { LlmAdapter } from "./modules/llm/index.js";
import { sql } from "@ncs/db/orm";
import type { DbConnection } from "@ncs/db";
import { DEFAULTS, type InstallConfig } from "@ncs/shared";
import { createApp } from "./http/app.js";
import { createPlatform, type Clock, type Db, type IdGenerator, type Logger, type Platform, type StorageProvider, type SecretCipher } from "./platform/index.js";
import { createRuntime, type Runtime } from "./runtime/index.js";
import { buildModules, moduleList, mountHomeRoute, type Modules } from "./composition/index.js";

export interface ServerCore {
  platform: Platform;
  runtime: Runtime;
  modules: Modules;
  app: Express;
  /** module.start() hooks (owner user, provider profile, recovery …) — call before serving */
  start(opts?: { background?: boolean }): Promise<void>;
  /**
   * stop runtime loops (in-flight runs finish their current provider call and stop at the next safe
   * point, up to `graceMs`, default `shutdown.grace_seconds`), then module.stop() in reverse order
   * (orchestration hard-aborts whatever is still running — 02 §7.3)
   */
  stop(graceMs?: number): Promise<void>;
}

export interface CreateServerCoreOptions {
  config: InstallConfig;
  appVersion: string;
  db: Db;
  log: Logger;
  databaseMode: "embedded" | "external";
  /** resolved DB connection (provider, schema, TLS) — system info and the pg_dump backup engine use it */
  database?: DbConnection;
  clock?: Clock;
  ids?: IdGenerator;
  storage?: StorageProvider;
  secretCipher?: SecretCipher;
  /** extra LLM adapters — test seam only; production passes none */
  llmAdapters?: LlmAdapter[];
}

export function createServerCore(o: CreateServerCoreOptions): ServerCore {
  const platform = createPlatform(o);
  const runtime = createRuntime({ log: o.log, workSignal: platform.workSignal, concurrency: o.config.run.max_concurrent_global });
  const modules = buildModules({ platform, runtime, databaseMode: o.databaseMode, database: o.database, llmAdapters: o.llmAdapters });
  const list = moduleList(modules);
  let ownerId: string | null = null;

  const app = createApp({
    config: o.config,
    version: o.appVersion,
    log: o.log,
    checkDatabase: async () => {
      await o.db.execute(sql`SELECT 1`);
      return "pass";
    },
    novelExists: (id) => modules.novel.service.exists(id),
    resolveUserId: async () => (ownerId ??= (await modules.novel.service.getOwnerUser())?.id ?? null),
    registerRoutes: (r) => {
      for (const m of list) m.routes?.(r);
      mountHomeRoute(r, modules);
    },
  });

  return {
    platform,
    runtime,
    modules,
    app,
    async start(opts = {}) {
      for (const m of list) await m.start?.();
      if (opts.background ?? true) {
        for (const m of list) for (const loop of m.loops ?? []) runtime.add(loop);
        runtime.start();
      }
      o.log.info(
        { implemented: list.filter((m) => m.implemented).map((m) => m.name), placeholders: list.filter((m) => !m.implemented).map((m) => m.name) },
        "modules started",
      );
    },
    async stop(graceMs = DEFAULTS["shutdown.grace_seconds"] * 1000) {
      await runtime.stop(graceMs);
      for (const m of [...list].reverse()) {
        try {
          await m.stop?.();
        } catch (err) {
          o.log.error({ err, module: m.name }, "module stop failed");
        }
      }
    },
  };
}
