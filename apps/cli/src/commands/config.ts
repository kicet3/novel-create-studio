/** `ncs config get|set|unset|validate|path` (08 §5.5). Restart-required keys are only changed here. */
import type { Command } from "commander";
import { configPath, getKey, loadConfig, parseValue, readConfigFile, setKey, unsetKey, validateConfigObject, writeConfigFile } from "../lib/config.js";
import { fail, printJson } from "../lib/output.js";

export function registerConfigCommands(program: Command): void {
  const cmd = program.command("config").description("설치 설정(config.json) 조회·변경·검증");

  cmd
    .command("get [key]")
    .description("유효 설정(파일+환경 변수+기본값) 값을 보여 줍니다. --file 은 config.json 원문만")
    .option("--file", "config.json 에 적힌 값만")
    .action((key: string | undefined, o: { file?: boolean }) => {
      const src = o.file ? readConfigFile() : loadConfig().config;
      const v = getKey(src, key ?? "");
      if (v === undefined) fail(`설정 키가 없습니다: ${key}`);
      if (typeof v === "string") process.stdout.write(`${v}\n`);
      else printJson(v);
    });

  cmd
    .command("set <key> <value>")
    .description("config.json 값을 바꿉니다(JSON 리터럴 또는 문자열). 서버 재시작 후 적용")
    .action((key: string, raw: string) => {
      const next = setKey(readConfigFile(), key, parseValue(raw));
      const v = validateConfigObject(next);
      if (!v.ok) fail(`설정이 올바르지 않습니다:\n  ${v.issues.join("\n  ")}`);
      const p = writeConfigFile(next);
      process.stdout.write(`${key} 를 저장했습니다 (${p}). 실행 중인 서버는 재시작해야 반영됩니다.\n`);
    });

  cmd
    .command("unset <key>")
    .description("config.json 에서 키를 지웁니다(기본값으로 되돌림)")
    .action((key: string) => {
      const next = unsetKey(readConfigFile(), key);
      const v = validateConfigObject(next);
      if (!v.ok) fail(`설정이 올바르지 않습니다:\n  ${v.issues.join("\n  ")}`);
      writeConfigFile(next);
      process.stdout.write(`${key} 를 지웠습니다.\n`);
    });

  cmd
    .command("validate")
    .description("InstallConfig 스키마와 CFG-1~5 교차 검증")
    .action(() => {
      const v = validateConfigObject(readConfigFile());
      if (!v.ok) fail(`설정 검증 실패:\n  ${v.issues.join("\n  ")}`);
      process.stdout.write("설정 검증 통과\n");
    });

  cmd
    .command("path")
    .description("config.json 경로")
    .action(() => {
      process.stdout.write(`${configPath()}\n`);
    });
}
