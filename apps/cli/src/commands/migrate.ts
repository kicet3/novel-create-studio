/** `ncs migrate status|apply` (08 §4.3 gate, NFR-REL-05): `apply` takes a `pre_migration` backup first. */
import type { Command } from "commander";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runMigrations } from "@ncs/db";
import { ulid } from "@ncs/shared";
import { backupsDir, loadConfig, storageRoot } from "../lib/config.js";
import { openRawDb } from "../lib/db.js";
import { detectServer } from "../lib/http.js";
import { migrationStatus } from "../lib/migrations.js";
import { loadBackupEngine, loadServer } from "../lib/server-loader.js";
import { fail, printJson } from "../lib/output.js";

export function registerMigrateCommands(program: Command): void {
  const cmd = program.command("migrate").description("DB 마이그레이션 게이트");

  cmd
    .command("status")
    .description("적용·대기·체크섬 불일치·다운그레이드 여부")
    .option("--json", "JSON 출력")
    .action(async (o: { json?: boolean }) => {
      const { config } = loadConfig();
      const db = await openRawDb(config);
      try {
        const st = await migrationStatus(db.target);
        if (o.json) return printJson(st);
        process.stdout.write(
          [
            `적용됨: ${st.applied.map((a) => a.id).join(", ") || "없음"}`,
            `대기: ${st.pending.join(", ") || "없음"}`,
            st.unknown.length ? `이 앱이 모르는 마이그레이션(DB가 더 새 버전): ${st.unknown.join(", ")}` : null,
            st.checksumMismatch.length ? `체크섬 불일치: ${st.checksumMismatch.join(", ")}` : null,
          ]
            .filter(Boolean)
            .join("\n") + "\n",
        );
        if (!st.ok) process.exitCode = 2;
      } finally {
        await db.close();
      }
    });

  cmd
    .command("apply")
    .description("대기 마이그레이션 적용(먼저 pre_migration 백업)")
    .option("--skip-backup", "pre_migration 백업 생략")
    .action(async (o: { skipBackup?: boolean }) => {
      const { config } = loadConfig();
      if ((await detectServer(config)).running) fail("서버가 실행 중입니다. 멈춘 뒤 실행하세요(서버는 시작할 때 자동으로 마이그레이션합니다).");
      const db = await openRawDb(config);
      try {
        const st = await migrationStatus(db.target);
        if (!st.ok) fail(`마이그레이션 상태가 올바르지 않습니다: ${[...st.unknown, ...st.checksumMismatch].join(", ")}`, 2);
        if (!st.pending.length) return void process.stdout.write("적용할 마이그레이션이 없습니다.\n");
        const server = await loadServer();
        if (st.applied.length && !o.skipBackup) {
          const engine = await loadBackupEngine();
          const now = new Date();
          const id = `bkp_${ulid(now.getTime())}`;
          const dir = backupsDir(config);
          await mkdir(dir, { recursive: true, mode: 0o700 });
          const name = engine.bundleDirName(id, "pre_migration", now);
          const { manifest } = await engine.writeBundle({
            target: db.target,
            bundleDir: join(dir, name),
            storageRoot: storageRoot(config),
            backupId: id,
            trigger: "pre_migration",
            mode: config.backup.mode,
            appVersion: server.APP_VERSION,
            now,
            databaseUrl: db.url,
          });
          await db.target.query(
            `INSERT INTO backup_records (id, status, trigger, mode, started_at, finished_at, storage_key, size_bytes, app_version, last_migration_id, details)
             VALUES ($1, 'succeeded', 'pre_migration', $2, $3, now(), $4, $5, $6, $7, $8::jsonb)`,
            [id, config.backup.mode, now, name, manifest.totalSizeBytes, server.APP_VERSION, manifest.lastMigrationId, JSON.stringify({ engine: manifest.engine, path: join(dir, name), via: "cli" })],
          );
          process.stdout.write(`pre_migration 백업: ${id} (${join(dir, name)})\n`);
        }
        const r = await runMigrations(db.target, { appVersion: server.APP_VERSION, requireExtensions: ["btree_gist"], log: (m) => process.stdout.write(`  ${m}\n`) });
        process.stdout.write(`적용 완료: ${r.applied.join(", ") || "없음"}\n`);
      } finally {
        await db.close();
      }
    });
}
