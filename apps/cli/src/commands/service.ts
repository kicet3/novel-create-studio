/** `ncs service install|uninstall|start|stop|restart|status|logs` (08 §8.2, NFR-REL-06). */
import type { Command } from "commander";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, loadConfig } from "../lib/config.js";
import { detectServer } from "../lib/http.js";
import {
  buildServiceSpec,
  cliInvocation,
  launchAgentPath,
  launchdPlist,
  SERVICE_LABEL,
  SYSTEMD_UNIT,
  systemdUnit,
  systemdUnitPath,
} from "../lib/service-def.js";
import { fail, markLongRunning } from "../lib/output.js";

const MAIN_URL = new URL("../main" + (import.meta.url.endsWith(".ts") ? ".ts" : ".js"), import.meta.url).href;

function tsxImport(): string | null {
  try {
    return import.meta.resolve("tsx");
  } catch {
    return null;
  }
}

function sh(cmd: string, args: string[], opts: { allowFail?: boolean } = {}): string {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    if (opts.allowFail) return String((err as { stdout?: string }).stdout ?? "");
    throw new Error(`${cmd} ${args.join(" ")} 실패: ${String((err as { stderr?: string }).stderr ?? (err as Error).message).trim()}`);
  }
}

const uid = () => (process.getuid ? process.getuid() : 0);
const domain = () => `gui/${uid()}`;
const isMac = () => process.platform === "darwin";
const isLinux = () => process.platform === "linux";

function currentSpec() {
  const { config } = loadConfig();
  const repoRoot = resolve(dirname(fileURLToPath(MAIN_URL)), "..", "..", "..");
  return {
    config,
    spec: buildServiceSpec({
      ncsHome: config.home,
      programArguments: cliInvocation({ mainUrl: MAIN_URL, tsxImport: tsxImport() }),
      workingDirectory: existsSync(resolve(repoRoot, "package.json")) ? repoRoot : config.home,
    }),
  };
}

function launchdLoaded(): boolean {
  return sh("launchctl", ["print", `${domain()}/${SERVICE_LABEL}`], { allowFail: true }).includes(SERVICE_LABEL);
}

export function installService(o: { start: boolean; dryRun?: boolean }): void {
  const { config, spec } = currentSpec();
  if (isMac()) {
    const body = launchdPlist(spec);
    if (o.dryRun) return void process.stdout.write(body);
    ensureDir(resolve(config.home, "logs"));
    const p = launchAgentPath();
    mkdirSync(dirname(p), { recursive: true });
    if (launchdLoaded()) sh("launchctl", ["bootout", `${domain()}/${SERVICE_LABEL}`], { allowFail: true });
    writeFileSync(p, body, { mode: 0o644 });
    if (o.start) sh("launchctl", ["bootstrap", domain(), p]);
    process.stdout.write(`등록했습니다: ${p}${o.start ? " (시작함)" : ""}\n로그: ${spec.stdoutPath}\n`);
    process.stdout.write("참고: Mac 이 잠자기 상태이면 질문 발송·수신이 멈춥니다(NFR-REL-06).\n");
  } else if (isLinux()) {
    const body = systemdUnit(spec);
    if (o.dryRun) return void process.stdout.write(body);
    ensureDir(resolve(config.home, "logs"));
    const p = systemdUnitPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body, { mode: 0o644 });
    sh("systemctl", ["--user", "daemon-reload"]);
    sh("systemctl", ["--user", "enable", ...(o.start ? ["--now"] : []), SYSTEMD_UNIT]);
    process.stdout.write(`등록했습니다: ${p}\n로그아웃 후에도 실행하려면: loginctl enable-linger ${process.env.USER ?? "$USER"}\n`);
  } else fail("이 OS 의 서비스 등록은 아직 지원하지 않습니다(지원: macOS, Linux). `ncs run` 을 직접 실행하세요.");
}

export function registerServiceCommands(program: Command): void {
  const cmd = program.command("service").description("OS 사용자 서비스로 등록·관리(macOS launchd, Linux systemd --user)");

  cmd
    .command("install")
    .description("로그인 시 자동 시작·비정상 종료 시 재시작하도록 등록합니다")
    .option("--no-start", "등록만 하고 시작하지 않음")
    .option("--dry-run", "정의 파일 내용만 출력")
    .action((o: { start: boolean; dryRun?: boolean }) => installService(o));

  cmd
    .command("uninstall")
    .description("서비스 등록을 해제합니다")
    .action(() => {
      if (isMac()) {
        sh("launchctl", ["bootout", `${domain()}/${SERVICE_LABEL}`], { allowFail: true });
        const p = launchAgentPath();
        if (existsSync(p)) rmSync(p);
        process.stdout.write(`해제했습니다: ${p}\n`);
      } else if (isLinux()) {
        sh("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT], { allowFail: true });
        const p = systemdUnitPath();
        if (existsSync(p)) rmSync(p);
        sh("systemctl", ["--user", "daemon-reload"], { allowFail: true });
        process.stdout.write(`해제했습니다: ${p}\n`);
      } else fail("지원하지 않는 OS 입니다.");
    });

  cmd
    .command("start")
    .description("서비스 시작")
    .action(() => {
      if (isMac()) {
        const p = launchAgentPath();
        if (!existsSync(p)) fail("등록된 서비스가 없습니다. `ncs service install` 을 먼저 실행하세요.");
        if (!launchdLoaded()) sh("launchctl", ["bootstrap", domain(), p]);
        else sh("launchctl", ["kickstart", `${domain()}/${SERVICE_LABEL}`]);
      } else if (isLinux()) sh("systemctl", ["--user", "start", SYSTEMD_UNIT]);
      else fail("지원하지 않는 OS 입니다.");
      process.stdout.write("시작했습니다.\n");
    });

  cmd
    .command("stop")
    .description("서비스 정지(등록은 유지, 다음 로그인 때 다시 시작)")
    .action(() => {
      if (isMac()) sh("launchctl", ["bootout", `${domain()}/${SERVICE_LABEL}`], { allowFail: true });
      else if (isLinux()) sh("systemctl", ["--user", "stop", SYSTEMD_UNIT]);
      else fail("지원하지 않는 OS 입니다.");
      process.stdout.write("정지했습니다.\n");
    });

  cmd
    .command("restart")
    .description("서비스 재시작(업그레이드 후)")
    .action(() => {
      if (isMac()) {
        if (launchdLoaded()) sh("launchctl", ["kickstart", "-k", `${domain()}/${SERVICE_LABEL}`]);
        else sh("launchctl", ["bootstrap", domain(), launchAgentPath()]);
      } else if (isLinux()) sh("systemctl", ["--user", "restart", SYSTEMD_UNIT]);
      else fail("지원하지 않는 OS 입니다.");
      process.stdout.write("재시작했습니다.\n");
    });

  cmd
    .command("status")
    .description("서비스·서버 상태")
    .action(async () => {
      const { config } = loadConfig();
      const out: string[] = [];
      if (isMac()) {
        const p = launchAgentPath();
        out.push(`등록: ${existsSync(p) ? p : "없음"}`);
        const info = sh("launchctl", ["print", `${domain()}/${SERVICE_LABEL}`], { allowFail: true });
        const state = /\bstate = (\S+)/.exec(info)?.[1];
        const pid = /\bpid = (\d+)/.exec(info)?.[1];
        out.push(`launchd: ${state ?? "로드되지 않음"}${pid ? ` (pid ${pid})` : ""}`);
      } else if (isLinux()) {
        out.push(`systemd: ${sh("systemctl", ["--user", "is-active", SYSTEMD_UNIT], { allowFail: true }).trim() || "unknown"}`);
      }
      const s = await detectServer(config);
      out.push(`서버: ${s.running ? `응답함 ${s.url}${s.version ? ` (v${s.version})` : ""}` : `응답 없음 (${s.url})`}`);
      process.stdout.write(`${out.join("\n")}\n`);
      if (!s.running) process.exitCode = 1;
    });

  cmd
    .command("logs")
    .description("마지막 서버 로그")
    .option("-n, --lines <n>", "줄 수", "100")
    .option("-f, --follow", "계속 보기")
    .option("--stderr", "표준 오류 로그")
    .action((o: { lines: string; follow?: boolean; stderr?: boolean }) => {
      const { spec } = currentSpec();
      const file = o.stderr ? spec.stderrPath : spec.stdoutPath;
      if (!existsSync(file)) fail(`로그 파일이 없습니다: ${file}`);
      if (o.follow) {
        markLongRunning();
        spawn("tail", ["-n", o.lines, "-f", file], { stdio: "inherit" }).on("exit", (c) => process.exit(c ?? 0));
        return;
      }
      const lines = readFileSync(file, "utf8").split("\n");
      process.stdout.write(`${lines.slice(-Number(o.lines) - 1).join("\n")}\n`);
    });
}
