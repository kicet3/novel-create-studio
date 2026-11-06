import { randomBytes } from "node:crypto";
import { DEFAULTS } from "@ncs/shared";
import { sql } from "@ncs/db/orm";
import { describeConnection, type DbConnection } from "@ncs/db";
import {
  actors,
  createSecretProvider,
  SecretUndecryptableError,
  notImplementedService,
  type Platform,
} from "../../../platform/index.js";
import type { AuditService } from "../../audit/index.js";
import type { BackupService, HealthCheckDefinition, HealthCheckOutcome, HealthCheckResult, SystemService } from "../index.js";
import { createDbSecretStore } from "../adapters/db/secret-store.js";
import { healthRepo } from "../adapters/db/health-repository.js";

export interface SystemServiceDeps {
  platform: Platform;
  audit: AuditService;
  databaseMode: "embedded" | "external";
  database?: DbConnection;
  /** non-archived novel ids for novel-scoped checks */
  listNovelIds?: () => Promise<string[]>;
}

async function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<T>((r) => (t = setTimeout(() => r(onTimeout()), ms)))]);
  } finally {
    clearTimeout(t);
  }
}

export function createSystemService(deps: SystemServiceDeps): SystemService & { setNovelLister(fn: () => Promise<string[]>): void } {
  const { platform, audit } = deps;
  const checks = new Map<string, HealthCheckDefinition>();
  const startedAt = platform.clock.date();
  let listNovelIds = deps.listNovelIds ?? (async () => []);

  const builtins: HealthCheckDefinition[] = [
    {
      name: "database",
      kind: "database",
      scope: "install",
      async run() {
        await platform.uow.db.execute(sql`SELECT 1`);
        const ext = (await platform.uow.db.execute(sql`SELECT extname FROM pg_extension`)) as unknown as
          | Array<{ extname: string }>
          | { rows: Array<{ extname: string }> };
        const names = (Array.isArray(ext) ? ext : ext.rows).map((r) => r.extname);
        const missing = ["btree_gist", "pg_trgm"].filter((e) => !names.includes(e));
        return missing.length
          ? { status: "warn", message: `데이터베이스 확장이 없습니다: ${missing.join(", ")}`, details: { missing } }
          : { status: "pass", message: "데이터베이스 연결 정상" };
      },
    },
    {
      name: "storage",
      kind: "storage",
      scope: "install",
      async run() {
        const key = `.health/${Date.now()}-${randomBytes(4).toString("hex")}`;
        await platform.storage.put(key, "ok");
        const back = (await platform.storage.get(key)).toString("utf8");
        await platform.storage.delete(key);
        return back === "ok"
          ? { status: "pass", message: "파일 저장소 쓰기·읽기 정상", details: { root: platform.storage.root } }
          : { status: "fail", message: "파일 저장소 읽기 결과가 다릅니다." };
      },
    },
  ];

  const secrets = createSecretProvider(platform.secretCipher, createDbSecretStore(platform.uow.db));
  // CFG-8 (08 §5.3): stored secrets that the current master key cannot decrypt → "비밀 복호화 불가"
  builtins.push({
    name: "secrets",
    kind: "secrets",
    scope: "install",
    async run() {
      const rows = await secrets.list();
      if (rows.length === 0) return { status: "pass", message: "저장된 비밀이 없습니다." };
      const bad: string[] = [];
      for (const r of rows) {
        try {
          await secrets.get(r.id);
        } catch (err) {
          if (err instanceof SecretUndecryptableError) bad.push(r.id);
          else throw err;
        }
      }
      if (bad.length === 0) return { status: "pass", message: `저장된 비밀 ${rows.length}개를 복호화할 수 있습니다.`, details: { keySource: platform.secretCipher.keySource() } };
      const missing = platform.secretCipher.keySource() === "missing";
      return {
        status: "fail",
        message: missing
          ? `마스터 키가 없어 저장된 비밀 ${bad.length}개를 복호화할 수 없습니다. 원래 master.key 를 secrets/ 에 옮기거나 비밀을 다시 입력하세요.`
          : `마스터 키가 달라 저장된 비밀 ${bad.length}개를 복호화할 수 없습니다. 원래 master.key 를 옮기거나 비밀을 다시 입력하세요.`,
        details: { ids: bad, keySource: platform.secretCipher.keySource() },
      };
    },
  });

  const service: SystemService & { setNovelLister(fn: () => Promise<string[]>): void } = {
    secrets,
    backups: notImplementedService<BackupService>("system.backups"),
    setNovelLister(fn) {
      listNovelIds = fn;
    },
    registerHealthCheck(def) {
      if (checks.has(def.name)) throw new Error(`duplicate health check: ${def.name}`);
      checks.set(def.name, def);
    },
    listHealthChecks: () => [...checks.values()].map(({ name, kind, scope }) => ({ name, kind, scope })),
    async runHealthChecks(opts = {}) {
      const selected = [...checks.values()].filter(
        (c) => (!opts.kinds || opts.kinds.includes(c.kind)) && (!opts.names || opts.names.includes(c.name)),
      );
      const timeoutMs = opts.timeoutMs ?? 15_000;
      const results: HealthCheckResult[] = [];
      const ac = new AbortController();
      for (const c of selected) {
        if (c.isActive && !(await c.isActive().catch(() => true))) continue;
        const novelIds = c.scope === "install" ? [undefined] : opts.novelId ? [opts.novelId] : await listNovelIds();
        for (const novelId of novelIds) {
          const outcome: HealthCheckOutcome = await withTimeout(
            c.run({ novelId, signal: ac.signal }).catch((err: unknown) => ({
              status: "fail" as const,
              message: `점검 중 오류: ${err instanceof Error ? err.message : String(err)}`,
            })),
            timeoutMs,
            () => ({ status: "fail", message: `점검 시간이 초과되었습니다(${Math.round(timeoutMs / 1000)}초).` }),
          );
          const target = c.target?.({ novelId });
          const row = {
            id: platform.ids.next("hck"),
            novelId: novelId ?? null,
            kind: c.kind,
            status: outcome.status,
            targetRefType: target?.type ?? null,
            targetRefId: target?.id ?? null,
            message: outcome.message,
            details: { ...outcome.details, name: c.name },
            checkedAt: platform.clock.date(),
          };
          if (opts.record === false) {
            results.push({ ...row, createdAt: row.checkedAt, name: c.name } as HealthCheckResult);
            continue;
          }
          const saved = await platform.uow.run(async (tx) => {
            const prev = await healthRepo.previousStatus(tx.db, c.name, novelId ?? null);
            const r = await healthRepo.insert(tx.db, row);
            if (outcome.status === "fail" && prev !== "fail") {
              await audit.record(tx, {
                novelId: novelId ?? null,
                actor: actors.system("health_check"),
                action: "system.health_check_failed",
                target: novelId ? { type: "novel", id: novelId } : { type: "settings", id: `health.${c.name}` },
                details: { name: c.name, kind: c.kind, message: outcome.message },
              });
            }
            return r;
          });
          results.push(saved);
        }
      }
      return results;
    },
    // Only results of checks that still apply: a stored result for a check that is no longer registered (removed
    // provider) or no longer active (e.g. llm.anthropic after the default switched to the Claude subscription) is
    // stale — runHealthChecks skips it, so it would otherwise keep showing its last (possibly failed) state forever.
    async latestHealthResults(opts = {}) {
      const rows = await healthRepo.latest(platform.uow.db, opts.novelId);
      const active = new Map<string, boolean>();
      const out: HealthCheckResult[] = [];
      for (const r of rows) {
        const c = checks.get(r.name);
        if (!c) continue;
        if (!active.has(c.name)) active.set(c.name, c.isActive ? await c.isActive().catch(() => true) : true);
        if (active.get(c.name)) out.push(r);
      }
      return out;
    },
    info: () => ({
      version: platform.appVersion,
      deploymentMode: platform.config.deployment_mode,
      devMode: platform.config.dev_mode,
      exposure: platform.config.exposure,
      databaseMode: deps.databaseMode,
      database: deps.database
        ? describeConnection(deps.database)
        : { provider: "postgres", host: null, port: null, schema: null, pooler: null, sslMode: null, poolMax: 0 },
      llmProvider: platform.config.llm.provider,
      server: { host: platform.config.server.host, port: platform.config.server.port },
      home: platform.config.home,
      startedAt,
    }),
  };
  for (const b of builtins) service.registerHealthCheck(b);
  return service;
}

export const HEALTH_LOOP_INTERVAL_MS = DEFAULTS["channel.health_check_interval_minutes"] * 60_000;
