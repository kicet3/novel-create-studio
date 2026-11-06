/** `ncs restore <backup>` (02 §8.4, 08 §5.5). Server must be stopped. */
import type { Command } from "commander";
import { confirm, isCancel } from "@clack/prompts";
import { backupsDir, loadConfig } from "../lib/config.js";
import { detectServer } from "../lib/http.js";
import { resolveBundle } from "../lib/bundles.js";
import { loadBackupEngine } from "../lib/server-loader.js";
import { runRestore } from "../lib/restore.js";
import { fail, formatBytes, printJson } from "../lib/output.js";

export function registerRestoreCommand(program: Command): void {
  program
    .command("restore <backup>")
    .description("백업 복원(경로, 묶음 이름, bkp_ ID 또는 latest). 모든 작품이 백업 시점으로 돌아갑니다")
    .option("-y, --yes", "확인 없이 진행")
    .option("--skip-pre-restore", "복원 전 현재 상태 백업을 건너뜀")
    .option("--force", "pre_restore 백업이 실패해도 진행")
    .option("--target-url <url>", "외부 DB 모드: 복원할 새 빈 DB URL")
    .option("--json", "JSON 출력")
    .action(async (target: string, o: { yes?: boolean; skipPreRestore?: boolean; force?: boolean; targetUrl?: string; json?: boolean }) => {
      const { config } = loadConfig();
      const s = await detectServer(config);
      if (s.running) fail(`서버가 실행 중입니다(${s.url}). \`ncs service stop\` 또는 \`ncs run\` 프로세스를 멈춘 뒤 다시 실행하세요.`);
      const dir = resolveBundle(target, backupsDir(config));
      const engine = await loadBackupEngine();
      const m = await engine.readManifest(dir);
      process.stderr.write(
        `복원할 백업: ${m.backupId} (${m.createdAt}, ${m.trigger}, 엔진 ${m.engine ?? "-"}, ${formatBytes(m.totalSizeBytes)})\n` +
          `  작품 ${m.novelIds.length}개, 파일 ${m.files.length}개, 앱 ${m.appVersion}, 마이그레이션 ${m.lastMigrationId ?? "-"}\n` +
          `  모든 작품이 백업 시점으로 돌아갑니다. 현재 DB는 지우지 않고 이름을 바꿔 보존합니다.\n`,
      );
      if (!o.yes) {
        if (!process.stdin.isTTY) fail("확인이 필요합니다. --yes 를 붙이세요.");
        const ok = await confirm({ message: "복원을 진행할까요?", initialValue: false });
        if (isCancel(ok) || !ok) fail("취소했습니다.");
      }
      const report = await runRestore(config, dir, engine, {
        skipPreRestore: o.skipPreRestore,
        force: o.force,
        targetUrl: o.targetUrl,
        log: (msg) => process.stderr.write(`  ${msg}\n`),
      });
      if (o.json) return printJson(report);
      const lines = [
        `복원 완료 (${report.mode}, 엔진 ${report.engine ?? "-"})`,
        report.preRestoreBackupId ? `  복원 전 백업: ${report.preRestoreBackupId}` : null,
        report.previousDatabase ? `  이전 DB 보존: ${report.previousDatabase} (확인 후 DROP DATABASE 로 지우세요)` : null,
        report.previousDataDir ? `  이전 데이터 디렉터리 보존: ${report.previousDataDir}` : null,
        report.appliedMigrations.length ? `  추가 적용 마이그레이션: ${report.appliedMigrations.join(", ")}` : null,
        `  복원 파일 ${report.restoredFiles}개${report.missingFiles.length ? `, 백업 당시 없던 파일 ${report.missingFiles.length}개` : ""}`,
        `  일시정지한 작품 ${report.pausedNovels.length}개 — 확인 후 웹에서 재개하세요.`,
        `  점검: ${report.health.map((h) => `${h.name}=${h.status}`).join(", ") || "-"}`,
        ...report.warnings.map((w) => `  주의: ${w}`),
      ].filter(Boolean);
      process.stdout.write(`${lines.join("\n")}\n`);
      if (report.health.some((h) => h.status === "fail")) process.exitCode = 1;
    });
}
