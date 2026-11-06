/** `ncs doctor [--json]` — exit code 0/1/2 = pass/warn/fail (08 §5.5–5.6). */
import type { Command } from "commander";
import { loadConfig } from "../lib/config.js";
import { exitCodeOf, runDoctor } from "../lib/doctor.js";
import { printJson } from "../lib/output.js";

const ICON = { pass: "✔", warn: "▲", fail: "✖" } as const;

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("설치 점검(Node·권한·설정·포트·마이그레이션 + 서버 점검 등록부)")
    .option("--json", "JSON 출력")
    .option("--offline", "서버 점검 등록부(LLM 키·봇 토큰 등)를 건너뜀")
    .action(async (o: { json?: boolean; offline?: boolean }) => {
      let config;
      try {
        config = loadConfig().config;
      } catch (err) {
        const r = [{ name: "config", kind: null, status: "fail" as const, message: `설정을 읽을 수 없습니다: ${(err as Error).message}` }];
        if (o.json) printJson({ status: "fail", results: r });
        else process.stdout.write(`${ICON.fail} config  ${r[0]!.message}\n`);
        process.exitCode = 2;
        return;
      }
      const results = await runDoctor(config, { offline: o.offline });
      const code = exitCodeOf(results);
      if (o.json) printJson({ status: (["pass", "warn", "fail"] as const)[code], results });
      else {
        for (const r of results) {
          process.stdout.write(`${ICON[r.status]} ${r.name}${r.novelId ? ` [${r.novelId}]` : ""}  ${r.message}\n`);
          if (r.remedy) process.stdout.write(`    → ${r.remedy}\n`);
        }
        process.stdout.write(`\n결과: ${["정상", "경고 있음", "실패 있음"][code]}\n`);
      }
      process.exitCode = code;
    });
}
