import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, type TestDb } from "@ncs/db/testing";
import { loadMigrations, pgliteTarget } from "@ncs/db";

const LATEST_MIGRATION_ID = loadMigrations().at(-1)!.id;
import { createTestCore, type TestCore } from "./support/test-core.js";
import { restoreBundle, RestoreError, verifyBundle } from "../src/modules/system/adapters/backup/backup-engine.js";
import { findPgTool, parsePgToolVersion, connectionArgs } from "../src/modules/system/adapters/backup/backup-pgtools.js";
import { retentionPlan, scheduleDecision, type BackupRecordLike } from "../src/modules/system/application/backup-policy.js";
import type { BackupServiceImpl } from "../src/modules/system/application/backup-service.js";

const H = 3_600_000;
const rec = (id: string, p: Partial<BackupRecordLike> & { at: number }): BackupRecordLike => ({
  id,
  status: p.status ?? "succeeded",
  trigger: p.trigger ?? "scheduled",
  startedAt: new Date(p.at - 1000),
  finishedAt: p.status === "running" ? null : new Date(p.at),
});

describe("backup policy (pure)", () => {
  const now = new Date("2026-11-05T12:00:00Z");
  it("is due when no scheduled backup exists (catch-up on first start)", () => {
    expect(scheduleDecision([], now, 24)).toEqual({ due: true, reason: "never" });
    // manual backups do not count toward the schedule
    expect(scheduleDecision([rec("m", { at: now.getTime() - H, trigger: "manual" })], now, 24).due).toBe(true);
  });
  it("is fresh within the interval and due after a missed window (sleep / stop)", () => {
    const fresh = scheduleDecision([rec("a", { at: now.getTime() - 2 * H })], now, 24);
    expect(fresh).toMatchObject({ due: false, reason: "fresh" });
    expect(scheduleDecision([rec("a", { at: now.getTime() - 50 * H })], now, 24)).toEqual({ due: true, reason: "interval_elapsed" });
  });
  it("backs off exponentially after failures and never overlaps a running backup", () => {
    const f1 = [rec("f1", { at: now.getTime() - 30_000, status: "failed" })];
    expect(scheduleDecision(f1, now, 24)).toMatchObject({ due: false, reason: "backoff" });
    expect(scheduleDecision(f1, new Date(now.getTime() + 60_000), 24)).toEqual({ due: true, reason: "retry_after_failure" });
    const f3 = [1, 2, 3].map((i) => rec(`f${i}`, { at: now.getTime() - i * 1000, status: "failed" }));
    const d = scheduleDecision(f3, new Date(now.getTime() + 2 * 60_000), 24);
    expect(d).toMatchObject({ due: false, reason: "backoff" }); // 4 min after 3 failures
    const many = Array.from({ length: 12 }, (_, i) => rec(`g${i}`, { at: now.getTime() - i, status: "failed" }));
    expect(scheduleDecision(many, new Date(now.getTime() + H + 1), 24).due).toBe(true); // capped at 1 h
    expect(scheduleDecision([rec("r", { at: now.getTime(), status: "running" })], now, 24)).toMatchObject({ due: false, reason: "running" });
  });
  it("retention keeps 7 daily + 4 weekly scheduled, all manual, 3 per safety trigger", () => {
    const records: BackupRecordLike[] = [];
    for (let d = 0; d < 40; d++) {
      records.push(rec(`s${d}a`, { at: now.getTime() - d * 24 * H }));
      records.push(rec(`s${d}b`, { at: now.getTime() - d * 24 * H - H }));
    }
    for (let i = 0; i < 5; i++) records.push(rec(`pm${i}`, { at: now.getTime() - i * H, trigger: "pre_migration" }));
    records.push(rec("man", { at: now.getTime() - 90 * 24 * H, trigger: "manual" }));
    records.push(rec("run", { at: now.getTime(), status: "running" }));
    const prune = new Set(retentionPlan(records, { daily: 7, weekly: 4 }));
    const kept = records.filter((r) => !prune.has(r.id)).map((r) => r.id);
    const keptScheduled = kept.filter((id) => id.startsWith("s"));
    expect(keptScheduled.slice(0, 7)).toEqual(["s0a", "s1a", "s2a", "s3a", "s4a", "s5a", "s6a"]);
    expect(keptScheduled.length).toBeGreaterThanOrEqual(7);
    expect(keptScheduled.length).toBeLessThanOrEqual(11);
    expect(kept.filter((id) => id.startsWith("s") && id.endsWith("b"))).toEqual([]); // one per day
    expect(kept).toContain("man");
    expect(kept).toContain("run");
    expect(kept.filter((id) => id.startsWith("pm"))).toEqual(["pm0", "pm1", "pm2"]);
  });
});

describe("pg tools discovery", () => {
  it("parses versions and picks the highest major ≥ server major", () => {
    expect(parsePgToolVersion("pg_dump (PostgreSQL) 17.2 (Homebrew)")).toEqual({ major: 17, version: "17.2" });
    const fake: Record<string, number> = { "/a/pg_dump": 16, "/b/pg_dump": 18, "/c/pg_dump": 17 };
    const probe = (p: string) => (fake[p] ? { path: p, major: fake[p]!, version: `${fake[p]}.0` } : null);
    const env = { PATH: "/a:/b:/c" };
    expect(findPgTool("pg_dump", 17, { env, probe })?.path).toBe("/b/pg_dump");
    expect(findPgTool("pg_dump", 19, { env, probe })).toBeNull();
  });
  it("keeps the password out of argv", () => {
    const c = connectionArgs("postgres://ncs:s%40cret@127.0.0.1:54329/ncs");
    expect(c.dbname).not.toContain("s@cret");
    expect(c.env.PGPASSWORD).toBe("s@cret");
  });
});

describe("BackupService + JSON engine round trip (PGlite)", () => {
  let t: TestCore;
  let svc: BackupServiceImpl;
  let target: TestDb | null = null;
  let novelId = "";

  beforeAll(async () => {
    t = await createTestCore();
    svc = t.modules.system.service.backups as BackupServiceImpl;
    const novel = await t.modules.novel.service.createNovel({ title: "백업 테스트" }, t.owner);
    novelId = novel.id;
    await t.modules.system.service.secrets.set("llm.anthropic.api_key", "sk-backup-secret", "Anthropic");
    // a referenced storage file (export job) + an unreferenced one
    await t.platform.storage.put(`novels/${novelId}/exports/a.txt`, "내보낸 원고 본문");
    await t.platform.storage.put(`novels/${novelId}/scratch.txt`, "unreferenced");
    await t.testDb.query(
      `INSERT INTO export_jobs (id, novel_id, scope_kind, export_format, storage_key, content_hash, requested_by_actor_type, requested_by_actor_id, completed_at)
       VALUES ('exp_01JAAAAAAAAAAAAAAAAAAAAAAA', $1, 'novel', 'txt', $2, 'h', 'user', $3, now())`,
      [novelId, `novels/${novelId}/exports/a.txt`, t.ownerId],
    );
  });
  afterAll(async () => {
    await target?.close();
    await t.close();
  });

  it("runs a manual backup over HTTP and lists it", async () => {
    const r = await t.http("POST", "/api/system/backups", {});
    expect(r.status).toBe(201);
    expect(r.body.status).toBe("succeeded");
    expect(r.body.trigger).toBe("manual");
    expect(r.body.details.engine).toBe("json");
    const list = await t.http("GET", "/api/system/backups");
    expect(list.status).toBe(200);
    expect(list.body.items.map((x: { id: string }) => x.id)).toContain(r.body.id);
    expect(list.body.schedule.due).toBe(true); // no scheduled backup yet
    const v = await t.http("POST", `/api/system/backups/${r.body.id}/verify`);
    expect(v.body.ok).toBe(true);
    expect((await t.http("GET", `/api/system/backups/bkp_00000000000000000000000000`)).status).toBe(404);
    const ev = (await t.modules.audit.service.list(null, { actionPrefix: "backup." })).items;
    expect(ev[0]!.action).toBe("backup.completed");
  });

  it("bundle holds manifest, gzipped rows and only referenced files; master key excluded", async () => {
    const [row] = await svc.listBackups();
    const dir = svc.bundleDirOf(row!);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(manifest.engine).toBe("json");
    expect(manifest.novelIds).toEqual([novelId]);
    expect(manifest.lastMigrationId).toBe(LATEST_MIGRATION_ID);
    expect(manifest.files.map((f: { key: string }) => f.key)).toEqual([`novels/${novelId}/exports/a.txt`]);
    expect(manifest.db.tables.novels.rows).toBe(1);
    expect(existsSync(join(dir, "files", "novels", novelId, "scratch.txt"))).toBe(false);
    const all = readdirSync(dir, { recursive: true }).map(String);
    expect(all.some((p) => p.includes("master.key"))).toBe(false);
  });

  it("restores into a fresh database with identical rows, reset sequences and files", async () => {
    const [row] = await svc.listBackups();
    const dir = svc.bundleDirOf(row!);
    target = await createTestDb({ migrations: [] });
    const storageRoot = await mkdtemp(join(tmpdir(), "ncs-restore-files-"));
    try {
      const res = await restoreBundle({ target: pgliteTarget(target.pg), bundleDir: dir, storageRoot, appVersion: "test" });
      expect(res.engine).toBe("json");
      expect(res.restoredFiles).toBe(1);
      expect(readFileSync(join(storageRoot, `novels/${novelId}/exports/a.txt`), "utf8")).toBe("내보낸 원고 본문");

      const tables = (await t.testDb.query<{ relname: string }>(
        `SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE nspname='public' AND relkind='r' ORDER BY 1`,
      )).map((r) => r.relname);
      for (const tbl of tables) {
        if (tbl === "backup_records" || tbl === "activity_log") continue; // changed after the snapshot
        const q = `SELECT row_to_json(x)::text AS j FROM "${tbl}" x ORDER BY 1`;
        const a = (await t.testDb.query<{ j: string }>(q)).map((r) => r.j);
        const b = (await target.query<{ j: string }>(q)).map((r) => r.j);
        expect(b, tbl).toEqual(a);
      }
      // the bundle's own row was captured as running; audit rows up to the snapshot are there
      const [own] = await target.query<{ status: string }>(`SELECT status FROM backup_records WHERE id = $1`, [row!.id]);
      expect(own!.status).toBe("running");
      const [src] = await t.testDb.query<{ n: number }>(`SELECT count(*)::int AS n FROM activity_log WHERE action <> 'backup.completed'`);
      const [dst] = await target.query<{ n: number; mx: string }>(`SELECT count(*)::int AS n, max(seq)::text AS mx FROM activity_log`);
      expect(dst!.n).toBe(src!.n);
      const [seq] = await target.query<{ last_value: string }>(
        `SELECT last_value::text FROM pg_sequences WHERE sequencename = (SELECT split_part(pg_get_serial_sequence('public.activity_log','seq'), '.', 2))`,
      );
      expect(seq!.last_value).toBe(dst!.mx);
      // secrets survive as ciphertext only
      const [sec] = await target.query<{ ciphertext: string }>(`SELECT ciphertext FROM secrets WHERE id = 'llm.anthropic.api_key'`);
      expect(sec!.ciphertext).not.toContain("sk-backup");
      // the restored DB is usable: constraints active again
      await expect(target.query(`INSERT INTO export_jobs (id, novel_id, scope_kind, export_format, requested_by_actor_type, requested_by_actor_id)
        VALUES ('exp_01JBBBBBBBBBBBBBBBBBBBBBBB', 'nov_00000000000000000000000000', 'novel', 'txt', 'user', 'x')`)).rejects.toThrow();

      await expect(restoreBundle({ target: pgliteTarget(target.pg), bundleDir: dir, appVersion: "test" })).rejects.toMatchObject({ code: "not_empty" });
    } finally {
      await rm(storageRoot, { recursive: true, force: true });
    }
  });

  it("refuses bundles from a newer app and detects tampering", async () => {
    const [row] = await svc.listBackups();
    const dir = svc.bundleDirOf(row!);
    const mp = join(dir, "manifest.json");
    const original = readFileSync(mp, "utf8");
    const fresh = await createTestDb({ migrations: [] });
    try {
      writeFileSync(mp, original.replace(`"lastMigrationId": "${LATEST_MIGRATION_ID}"`, `"lastMigrationId": "9999"`));
      const err = await restoreBundle({ target: pgliteTarget(fresh.pg), bundleDir: dir, appVersion: "test" }).catch((e) => e);
      expect(err).toBeInstanceOf(RestoreError);
      expect(err.code).toBe("newer_backup");
      writeFileSync(mp, original);
      const fp = join(dir, "files", "novels", novelId, "exports", "a.txt");
      const body = readFileSync(fp);
      writeFileSync(fp, "tampered");
      expect((await verifyBundle(dir)).ok).toBe(false);
      writeFileSync(fp, body);
      expect((await verifyBundle(dir)).ok).toBe(true);
    } finally {
      writeFileSync(mp, original);
      await fresh.close();
    }
  });

  it("scheduled loop catches up once, then waits for the interval; backup_location check reports", async () => {
    const first = await svc.runScheduledIfDue();
    expect(first?.trigger).toBe("scheduled");
    expect(first?.status).toBe("succeeded");
    expect(await svc.runScheduledIfDue()).toBeNull();
    const [hc] = await t.modules.system.service.runHealthChecks({ kinds: ["backup_location"] });
    expect(hc!.name).toBe("backup_location");
    expect(["pass", "warn"]).toContain(hc!.status);
    expect(t.core.runtime).toBeDefined();
    expect(t.modules.system.loops?.map((l) => l.name)).toContain("system.backups");
  });

  it("concurrent runs are rejected; crashed running rows are failed on recovery", async () => {
    const a = svc.runBackup("manual");
    await expect(svc.runBackup("manual")).rejects.toMatchObject({ code: "backup_running" });
    await a;
    await t.testDb.query(
      `INSERT INTO backup_records (id, status, trigger, mode, app_version) VALUES ('bkp_01JCCCCCCCCCCCCCCCCCCCCCCC', 'running', 'manual', 'full', 'test')`,
    );
    expect(await svc.recoverStale()).toEqual(["bkp_01JCCCCCCCCCCCCCCCCCCCCCCC"]);
  });
});
