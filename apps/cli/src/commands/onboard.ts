/**
 * `ncs onboard` (08 §5.5, FR-SET-01): install home, storage, host/port (loopback or Tailscale IP),
 * LLM provider + key (→ secrets), Telegram bot token, DB init/migrations, health summary, service.
 * The first novel is created in the web UI afterwards.
 */
import type { Command } from "commander";
import { cancel, confirm, intro, isCancel, log, note, outro, password, select, spinner, text } from "@clack/prompts";
import { join } from "node:path";
import { expandHome, redactDatabaseSecrets, resolveDatabaseConnection } from "@ncs/db";
import { INSTALL_DEFAULTS } from "@ncs/shared";
import { ensureDir, loadConfig, readConfigFile, writeConfigFile } from "../lib/config.js";
import { buildOnboardConfig, DEFAULT_PORT, hostWarning, parsePort, tailscaleHostnames, type OnboardAnswers } from "../lib/onboard-plan.js";
import { detectTailscale, isTailscaleIPv4 } from "../lib/net.js";
import { api, detectServer, serverBaseUrl } from "../lib/http.js";
import { ownerActor, withCore } from "../lib/core.js";
import { installService } from "./service.js";
import { describeExternalTarget } from "../lib/doctor.js";

interface OnboardFlags {
  yes?: boolean;
  home?: string;
  host?: string;
  port?: string;
  llm?: "anthropic";
  storageRoot?: string;
  allowedHostname?: string[];
  init: boolean;
}

/** Tailscale IP bind → also allow its MagicDNS names (full + short) in the Host guard */
function hostnamesFor(host: string, extra: string[] = []): string[] {
  return tailscaleHostnames(isTailscaleIPv4(host) ? detectTailscale().dnsName : null, extra);
}

function must<T>(v: T): Exclude<T, symbol> {
  if (isCancel(v)) {
    cancel("설정을 취소했습니다.");
    process.exit(1);
  }
  return v as Exclude<T, symbol>;
}

async function ask(flags: OnboardFlags): Promise<OnboardAnswers & { anthropicKey?: string; telegramToken?: string; installService: boolean }> {
  const interactive = !flags.yes && process.stdin.isTTY;
  const envHome = process.env.NCS_HOME ?? INSTALL_DEFAULTS.home;
  if (!interactive) {
    const port = parsePort(flags.port ?? String(DEFAULT_PORT));
    if (!port) throw new Error("--port 가 올바르지 않습니다.");
    const host = flags.host ?? INSTALL_DEFAULTS.serverHost;
    return {
      home: expandHome(flags.home ?? envHome),
      storageRoot: flags.storageRoot,
      host,
      port,
      allowedHostnames: hostnamesFor(host, flags.allowedHostname),
      llmProvider: "anthropic",
      anthropicKey: process.env.NCS_ONBOARD_ANTHROPIC_KEY,
      telegramToken: process.env.NCS_ONBOARD_TELEGRAM_TOKEN,
      installService: false,
    };
  }
  intro("Novel Create Studio 초기 설정");
  const home = expandHome(
    must(await text({ message: "설치 홈(데이터·설정·백업 위치)", defaultValue: flags.home ?? envHome, placeholder: flags.home ?? envHome })),
  );
  const storageDefault = join(home, "files");
  const storageRoot = must(
    await text({ message: "파일 저장소 위치(내보내기·첨부)", defaultValue: flags.storageRoot ?? storageDefault, placeholder: storageDefault }),
  );
  const ts = detectTailscale();
  const hostChoice = must(
    await select<string>({
      message: "어디에서 접속할까요?",
      initialValue: "loopback",
      options: [
        { value: "loopback", label: "이 컴퓨터만 (127.0.0.1)", hint: "권장" },
        ...ts.ips.map((ip) => ({ value: `ts:${ip}`, label: `Tailscale (${ip})`, hint: "같은 tailnet 의 휴대폰 등에서 접속" })),
        { value: "custom", label: "직접 입력" },
      ],
    }),
  );
  let host = INSTALL_DEFAULTS.serverHost as string;
  if (hostChoice.startsWith("ts:")) {
    host = hostChoice.slice(3);
  } else if (hostChoice === "custom") {
    host = must(await text({ message: "바인드 주소", placeholder: "100.x.y.z", validate: (v) => (v ? undefined : "주소를 입력하세요.") }));
  }
  const allowedHostnames = tailscaleHostnames(isTailscaleIPv4(host) ? ts.dnsName : null, flags.allowedHostname);
  const warn = hostWarning(host);
  if (warn) {
    log.warn(warn);
    if (!must(await confirm({ message: "계속할까요?", initialValue: true }))) return ask(flags);
  }
  const port = parsePort(
    must(await text({ message: "웹 포트", defaultValue: String(flags.port ?? DEFAULT_PORT), placeholder: String(DEFAULT_PORT), validate: (v) => (!v || parsePort(v) ? undefined : "1~65535 사이 숫자") })),
  )!;
  // 기본 LLM은 Claude API(API 키)입니다. 운영 모드(`ncs run`, 서비스)는 API 키로만 호출합니다. Claude 구독(터미널에서 직접
  // `claude auth login`으로 로그인한 Claude Code)·ChatGPT·xAI 로그인은 개발 모드(`pnpm dev` 또는 NCS_DEV_MODE=1)에서만 씁니다.
  // GPT·Grok·Gemini API 키는 웹 설정에서 연결합니다.
  const llmProvider = "anthropic" as const;
  const k = must(
    await password({
      message: "Anthropic API 키 (Claude API, 선택 — 비우면 나중에 웹 설정 › AI 계정 연결. Claude 구독은 개발 모드(`pnpm dev` 또는 NCS_DEV_MODE=1)에서만)",
      mask: "•",
    }),
  );
  const anthropicKey = String(k || "").trim() || undefined;
  const tg = must(await password({ message: "Telegram 봇 토큰 (선택, BotFather 발급 — 비우면 건너뜀)", mask: "•" }));
  const telegramToken = String(tg || "").trim() || undefined;
  const svc = process.platform === "darwin" || process.platform === "linux"
    ? must(await confirm({ message: "로그인할 때 자동으로 서버를 시작할까요? (사용자 서비스 등록)", initialValue: true }))
    : false;
  return { home, storageRoot: storageRoot === storageDefault ? undefined : storageRoot, host, port, allowedHostnames, llmProvider, anthropicKey, telegramToken, installService: svc };
}

export function registerOnboardCommand(program: Command): void {
  program
    .command("onboard")
    .description("대화형 초기 설정(설치 홈·접속 주소·LLM 키·Telegram 봇·DB 초기화·서비스 등록)")
    .option("-y, --yes", "묻지 않고 플래그·기본값으로 진행(키는 NCS_ONBOARD_ANTHROPIC_KEY / NCS_ONBOARD_TELEGRAM_TOKEN)")
    .option("--home <dir>", "설치 홈")
    .option("--host <host>", "바인드 주소")
    .option("--port <port>", "웹 포트")
    .option("--storage-root <dir>", "파일 저장소 위치")
    .option("--allowed-hostname <name...>", "Host 헤더로 허용할 추가 이름(예: MagicDNS 이름, 쉼표·반복 가능)")
    .option("--no-init", "DB 초기화·비밀 저장을 하지 않음(설정 파일만)")
    .action(async (flags: OnboardFlags) => {
      const a = await ask(flags);
      process.env.NCS_HOME = a.home;
      ensureDir(a.home);
      for (const d of ["logs", "backups", "run", "secrets"]) ensureDir(join(a.home, d));
      const file = writeConfigFile(buildOnboardConfig(readConfigFile(a.home), a), a.home);
      log.success(`설정 저장: ${file}`);

      const { config } = loadConfig();
      const notes: string[] = [];
      let dbUsable = true;
      if (config.database.mode === "external") {
        // DATABASE_URL (env only — the password never goes into config.json): Supabase / external PostgreSQL
        try {
          const t = describeExternalTarget(resolveDatabaseConnection(config));
          (t.status === "pass" ? log.info : log.warn)(`외부 DB: ${t.message}`);
        } catch (err) {
          dbUsable = false;
          log.error(redactDatabaseSecrets((err as Error).message, config.database.url));
          notes.push("DATABASE_URL 을 고친 뒤 `ncs doctor` 로 확인하세요(Supabase: Direct 또는 Session pooler 5432).");
        }
      }
      if (flags.init && dbUsable) {
        const s = spinner();
        s.start("데이터베이스 초기화·마이그레이션");
        try {
          const running = (await detectServer(config)).running;
          if (running) {
            if (a.anthropicKey) await api(config, "PUT", "/api/system/secrets/llm.anthropic.api_key", { value: a.anthropicKey, label: "Anthropic" });
            if (a.telegramToken) {
              try {
                await api(config, "POST", "/api/messaging/bots", { kind: "telegram", label: "Telegram", token: a.telegramToken });
              } catch (err) {
                await api(config, "PUT", "/api/system/secrets/telegram.pending_bot_token", { value: a.telegramToken, label: "Telegram (등록 대기)" });
                notes.push(`Telegram 봇 등록을 끝내지 못했습니다(${(err as Error).message}). 웹 설정에서 다시 등록하세요.`);
              }
            }
          } else {
            await withCore(config, async (core) => {
              const actor = await ownerActor(core);
              const audit = (id: string) =>
                core.platform.uow.run((tx: unknown) =>
                  core.modules.audit.service.record(tx, { novelId: null, actor, action: "secret.set", target: { type: "settings", id: `secret.${id}` }, details: { secretId: id, via: "onboard" } }),
                );
              if (a.anthropicKey) {
                await core.modules.system.service.secrets.set("llm.anthropic.api_key", a.anthropicKey, "Anthropic");
                await audit("llm.anthropic.api_key");
              }
              if (a.telegramToken) {
                try {
                  if (!core.modules.messaging?.service.registerBot) throw new Error("messaging 모듈 없음");
                  await core.modules.messaging.service.registerBot({ kind: "telegram", label: "Telegram", token: a.telegramToken }, actor);
                } catch (err) {
                  await core.modules.system.service.secrets.set("telegram.pending_bot_token", a.telegramToken, "Telegram (등록 대기)");
                  await audit("telegram.pending_bot_token");
                  notes.push(`Telegram 봇 등록을 끝내지 못했습니다(${(err as Error).message}). 토큰은 비밀로 보관했고 웹 설정에서 등록할 수 있습니다.`);
                }
              }
              const hc = await core.modules.system.service.runHealthChecks({ kinds: ["database", "storage", "llm_key", "bot_token"], timeoutMs: 15_000 });
              for (const h of hc) notes.push(`${h.status === "pass" ? "✔" : h.status === "warn" ? "▲" : "✖"} ${h.name}: ${h.message}`);
            });
          }
          s.stop("데이터베이스 준비 완료");
        } catch (err) {
          s.stop("데이터베이스 초기화 실패");
          log.error(redactDatabaseSecrets((err as Error).message, config.database.url));
          notes.push("`ncs doctor` 로 원인을 확인하세요.");
        }
      }

      if (a.installService) {
        try {
          installService({ start: true });
        } catch (err) {
          notes.push(`서비스 등록 실패: ${(err as Error).message}`);
        }
      }

      note(
        [
          "외부로 보내는 데이터(NFR-SEC-04):",
          " - 연결한 AI 공급자(Claude API·GPT·Grok·Gemini 중 역할별로 고른 곳, 개발 모드에서는 Claude 구독 포함): 컨셉 대화, 기획서, 원고, 온톨로지 요약 등 작업 문맥",
          a.telegramToken ? " - Telegram: 질문·알림 본문과 답변" : " - 메신저 미설정",
          "",
          `비밀 마스터 키: ${join(a.home, "secrets", "master.key")} — 백업에 들어가지 않습니다. 따로 안전하게 보관하세요.`,
          "컴퓨터가 잠자기 상태이면 질문 발송·수신과 집필이 멈춥니다.",
          ...(notes.length ? ["", ...notes] : []),
        ].join("\n"),
        "안내",
      );
      outro(`웹 UI: ${serverBaseUrl(config)}  (${a.installService ? "서비스로 실행 중" : "`ncs run` 으로 시작"}) — 첫 작품은 웹에서 만드세요.`);
    });
}
