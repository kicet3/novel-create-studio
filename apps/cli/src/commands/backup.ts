/** `ncs backup [run] | list | verify <backup>` (02 §8, 08 §5.5). Install-wide; `--novel` is v1. */
import type { Command } from "commander";
import { backupsDir, loadConfig } from "../lib/config.js";
import { api, detectServer } from "../lib/http.js";
import { withCore } from "../lib/core.js";
import { loadBackupEngine, type BackupRowLike } from "../lib/server-loader.js";
import { listBundles, resolveBundle } from "../lib/bundles.js";
import { fail, formatBytes, printJson, table } from "../lib/output.js";

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : "");

function printRow(r: BackupRowLike): void {
  const d = (r.details ?? {}) as { engine?: string; path?: string; missingFiles?: string[] };
  if (r.status === "succeeded") {
    process.stdout.write(`백업 완료: ${r.id} (${d.engine ?? "?"}, ${formatBytes(r.sizeBytes)})\n  ${d.path ?? r.storageKey}\n`);
    if (d.missingFiles?.length) process.stdout.write(`  경고: 저장소에서 찾지 못한 파일 ${d.missingFiles.length}개\n`);
  } else {
    process.stdout.write(`백업 실패: ${r.id} — ${r.errorMessage ?? r.status}\n`);
  }
}

export function registerBackupCommands(program: Command): void {
  const cmd = program.command("backup").description("설치 전체 백업(DB + 참조 파일, 마스터 키 제외)");

  cmd
    .command("run", { isDefault: true })
    .description("지금 백업합니다")
    .option("--engine <engine>", "auto | pg_dump | json", "auto")
    .option("--json", "JSON 출력")
    .action(async (o: { engine: string; json?: boolean }) => {
      if (!["auto", "pg_dump", "json"].includes(o.engine)) fail("--engine 은 auto, pg_dump, json 중 하나입니다.");
      const { config } = loadConfig();
      const row = (await detectServer(config)).running
        ? await api<BackupRowLike>(config, "POST", "/api/system/backups", { engine: o.engine })
        : await withCore(config, (core) => core.modules.system.service.backups.runBackup("manual", { engine: o.engine }));
      if (o.json) printJson(row);
      else printRow(row);
      if (row.status !== "succeeded") process.exitCode = 1;
    });

  cmd
    .command("list")
    .description("백업 기록과 백업 폴더의 묶음")
    .option("--json", "JSON 출력")
    .action(async (o: { json?: boolean }) => {
      const { config } = loadConfig();
      const dir = backupsDir(config);
      const bundles = listBundles(dir);
      let rows: BackupRowLike[] = [];
      try {
        rows = (await detectServer(config)).running
          ? (await api<{ items: BackupRowLike[] }>(config, "GET", "/api/system/backups")).items
          : await withCore(config, (core) => core.modules.system.service.backups.listBackups());
      } catch (err) {
        process.stderr.write(`백업 기록을 읽지 못했습니다(폴더 목록만 표시): ${(err as Error).message}\n`);
      }
      if (o.json) return printJson({ backupsDir: dir, records: rows, bundles });
      process.stdout.write(`백업 위치: ${dir}\n`);
      if (rows.length) {
        process.stdout.write(
          `${table(
            rows.map((r) => ({ id: r.id, status: r.status, trigger: r.trigger, startedAt: iso(r.startedAt), size: formatBytes(r.sizeBytes), bundle: r.storageKey ?? r.errorMessage ?? "" })),
            ["id", "status", "trigger", "startedAt", "size", "bundle"],
          )}\n`,
        );
      }
      const known = new Set(rows.map((r) => r.storageKey));
      const extra = bundles.filter((b) => !known.has(b.name));
      if (extra.length) {
        process.stdout.write(`\n기록에 없는 묶음(다른 DB·복원 이전 등):\n`);
        for (const b of extra) process.stdout.write(`  ${b.name}${b.valid ? "" : " (매니페스트 없음 — 유효하지 않음)"}\n`);
      }
      if (!rows.length && !bundles.length) process.stdout.write("백업이 없습니다.\n");
    });

  cmd
    .command("verify <backup>")
    .description("묶음 해시 검증(경로, 묶음 이름, bkp_ ID 또는 latest)")
    .option("--json", "JSON 출력")
    .action(async (target: string, o: { json?: boolean }) => {
      const { config } = loadConfig();
      const dir = resolveBundle(target, backupsDir(config));
      const engine = await loadBackupEngine();
      const v = await engine.verifyBundle(dir);
      if (o.json) printJson({ dir, ok: v.ok, message: v.message, problems: v.problems });
      else process.stdout.write(`${v.message}\n  ${dir}\n`);
      if (!v.ok) process.exitCode = 1;
    });
}
