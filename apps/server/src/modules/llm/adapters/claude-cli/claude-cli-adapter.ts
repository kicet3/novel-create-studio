/**
 * Claude via the user's own Claude subscription, through the UNMODIFIED Claude Code CLI (`claude -p`).
 *
 * Policy (code.claude.com/docs/en/legal-and-compliance, read 2026-11-06): an end user may sign in to the
 * unmodified Claude Code binary with their own subscription; apps may not collect, store or intermediate
 * Claude.ai credentials or session tokens. So this adapter:
 * - only spawns the `claude` executable the user installed and signed in to (`claude auth login`, done by
 *   the user in a terminal — Anthropic's own flow); it never reads, copies or stores credentials;
 * - checks readiness with `claude auth status` (logged-in flag + method only);
 * - removes ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN from the child env so the CLI uses the subscription
 *   login instead of an API key (CLI auth precedence), and runs in an empty working directory with no
 *   settings sources, tools, MCP servers, slash commands or session persistence (a plain model call).
 * Usage limits of Pro/Max assume ordinary individual use (the UI says so).
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmAdapter, LlmCapabilities, LlmCliStatus, LlmEnvironmentCheck, LlmInvokeOptions, LlmRequest, LlmResult, LlmUsage } from "../../index.js";
import { MODEL_LIMITS } from "../../domain/pricing.js";
import { buildOutputFormat, parseJsonText } from "../anthropic/anthropic-adapter.js";
import { createStreamRelay } from "../shared/stream-relay.js";

export const CLAUDE_CLI_PROVIDER = "claude_code";

export interface ClaudeCliOptions {
  /** executable; default `claude` on PATH (or NCS_CLAUDE_PATH) */
  bin?: string;
  /** test seam */
  spawnImpl?: typeof spawn;
  /** concurrent `claude -p` processes allowed by the gateway (default 2) */
  maxConcurrent?: number;
  /** per-call timeout used by the gateway (default 20 min: CLI start-up + long drafts) */
  callTimeoutMs?: number;
}

interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
  aborted: boolean;
}

let workDir: string | null = null;
const emptyWorkDir = () => (workDir ??= mkdtempSync(join(tmpdir(), "ncs-claude-cli-")));

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  return env;
}

/** transcript of the conversation for a single `-p` prompt (the CLI takes one user turn) */
export function renderTranscript(messages: LlmRequest["messages"]): string {
  if (messages.length === 1 && messages[0]!.role === "user") return messages[0]!.content;
  return messages.map((m) => `<${m.role}>\n${m.content}\n</${m.role}>`).join("\n\n") + "\n\n위 대화의 마지막 user 메시지에 답하세요.";
}

/**
 * `stream: true` (the caller wants live output): `--output-format stream-json --include-partial-messages --verbose`
 * prints one JSON event per line (Anthropic stream events wrapped in `stream_event`) and ends with the same `result`
 * object `--output-format json` prints, so the final mapping is identical.
 */
export function cliArgs(req: LlmRequest, opts: { stream?: boolean } = {}): { args: string[]; strict: boolean } {
  const out = req.output.kind === "object" ? buildOutputFormat(req.output.jsonSchema) : null;
  const system = req.system + (out && !out.strict ? out.instruction : "");
  const args = [
    "-p",
    "--output-format",
    opts.stream ? "stream-json" : "json",
    ...(opts.stream ? ["--include-partial-messages", "--verbose"] : []),
    "--model",
    req.modelId,
    "--system-prompt",
    system,
    "--tools",
    "",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--setting-sources",
    "",
  ];
  if (out?.strict) args.push("--json-schema", JSON.stringify(out.format.schema));
  return { args, strict: !!out?.strict };
}

function parseLine(line: string): { type?: unknown; event?: unknown; parent_tool_use_id?: unknown } | null {
  try {
    const v = JSON.parse(line) as unknown;
    return v && typeof v === "object" ? (v as { type?: unknown }) : null;
  } catch {
    return null;
  }
}

/** stream-json stdout → the final `result` object (same shape as `--output-format json`); throws when there is none */
export function resultOfStream(stdout: string): Record<string, unknown> {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const v = parseLine(line);
    if (v?.type === "result") return v as Record<string, unknown>;
  }
  throw new SyntaxError("no result event in Claude Code stream-json output");
}

function mapUsage(u: Record<string, unknown> | undefined, costUsd: unknown): LlmUsage {
  const n = (k: string) => (typeof u?.[k] === "number" ? (u[k] as number) : 0);
  const details = u?.output_tokens_details as { thinking_tokens?: number } | undefined;
  return {
    inputTokens: n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens"),
    outputTokens: n("output_tokens"),
    cachedInputTokens: n("cache_read_input_tokens") || undefined,
    reasoningTokens: details?.thinking_tokens || undefined,
    // list-price estimate reported by the CLI; a subscription is not billed per call (profile prices = 0)
    reportedCostMicros: typeof costUsd === "number" ? Math.round(costUsd * 1_000_000) : undefined,
  };
}

export class ClaudeCliLlmAdapter implements LlmAdapter {
  readonly provider = CLAUDE_CLI_PROVIDER;
  readonly limits: { maxConcurrent: number; callTimeoutMs: number };
  private readonly bin: string;
  private readonly spawnImpl: typeof spawn;

  constructor(opts: ClaudeCliOptions = {}) {
    this.bin = opts.bin ?? process.env.NCS_CLAUDE_PATH ?? "claude";
    this.spawnImpl = opts.spawnImpl ?? spawn;
    this.limits = { maxConcurrent: opts.maxConcurrent ?? 2, callTimeoutMs: opts.callTimeoutMs ?? 1_200_000 };
  }

  private run(args: string[], input: string | null, signal: AbortSignal, timeoutMs: number, onLine?: (line: string) => void): Promise<CliRun> {
    return new Promise((resolve) => {
      let stdout = "";
      let pending = "";
      let stderr = "";
      let aborted = false;
      let settled = false;
      const child = this.spawnImpl(this.bin, args, { cwd: emptyWorkDir(), env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
      const kill = () => {
        aborted = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 3000).unref();
      };
      const timer = setTimeout(kill, timeoutMs);
      const onAbort = () => kill();
      signal.addEventListener("abort", onAbort, { once: true });
      const done = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve({ code, stdout, stderr, aborted });
      };
      // setEncoding: multi-byte UTF-8 (Korean) split across chunks is decoded correctly
      child.stdout?.setEncoding?.("utf8");
      child.stdout?.on("data", (d: Buffer | string) => {
        const chunk = typeof d === "string" ? d : d.toString("utf8");
        stdout += chunk;
        if (!onLine) return;
        pending += chunk;
        let nl: number;
        while ((nl = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, nl);
          pending = pending.slice(nl + 1);
          if (line.trim()) onLine(line);
        }
      });
      child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      child.on("error", (err) => {
        stderr += String((err as NodeJS.ErrnoException).code ?? err.message);
        done(-1);
      });
      child.on("close", (code) => done(code));
      if (input !== null) child.stdin?.end(input, "utf8");
      else child.stdin?.end();
    });
  }

  capabilities(modelId: string): LlmCapabilities {
    const lim = MODEL_LIMITS[modelId] ?? { maxOutputTokens: 64_000, maxContextTokens: 200_000 };
    return {
      structuredOutput: "json_schema",
      maxContextTokens: lim.maxContextTokens,
      maxOutputTokens: lim.maxOutputTokens,
      promptCaching: true,
      reportsUsage: true,
      reportsCost: true,
      outputLimitCoversReasoning: true,
      billing: "subscription",
    };
  }

  /** `claude auth status` → logged in with a Claude subscription? (no credential is read) */
  async status(signal: AbortSignal = new AbortController().signal): Promise<LlmCliStatus> {
    const r = await this.run(["auth", "status"], null, signal, 15_000);
    if (r.code === -1) return { installed: false, loggedIn: false, authMethod: null, message: "Claude Code CLI(`claude`)를 찾을 수 없습니다. Claude Code를 설치하세요." };
    let s: { loggedIn?: boolean; authMethod?: string } = {};
    try {
      s = JSON.parse(r.stdout) as typeof s;
    } catch {
      /* older CLI: non-JSON output */
    }
    if (!s.loggedIn) return { installed: true, loggedIn: false, authMethod: s.authMethod ?? null, message: "Claude Code에 로그인되어 있지 않습니다. 터미널에서 `claude auth login`을 실행하세요." };
    const method = s.authMethod ?? null;
    if (method && method !== "claude.ai") {
      return { installed: true, loggedIn: true, authMethod: method, message: `Claude Code가 구독이 아닌 방식(${method})으로 로그인되어 있습니다. 구독으로 쓰려면 \`claude auth login\`으로 Claude 계정에 로그인하세요.` };
    }
    return { installed: true, loggedIn: true, authMethod: method, message: "Claude 구독(Claude Code CLI)으로 연결되어 있습니다." };
  }

  async testEnvironment(input: { apiKey: string; modelId?: string; signal: AbortSignal }): Promise<LlmEnvironmentCheck> {
    const s = await this.status(input.signal);
    if (!s.installed || !s.loggedIn) return { status: "fail", errorFamily: "auth_failed", message: s.message };
    if (s.authMethod && s.authMethod !== "claude.ai") return { status: "warn", message: s.message };
    return { status: "pass", message: s.message };
  }

  async invoke(req: LlmRequest, opts: LlmInvokeOptions): Promise<LlmResult> {
    const stream = !!opts.onStream;
    const { args, strict } = cliArgs(req, { stream });
    const relay = stream ? createStreamRelay(strict ? "structured_output_tool" : "text", opts.onStream) : null;
    const onLine = relay
      ? (line: string) => {
          const ev = parseLine(line);
          if (ev?.type === "stream_event" && ev.parent_tool_use_id == null) relay.push(ev.event);
        }
      : undefined;
    const r = await this.run(args, renderTranscript(req.messages), opts.signal, opts.timeoutMs, onLine);
    if (r.aborted) return { ok: false, errorFamily: "timeout", message: "Claude Code 응답 시간이 초과되었거나 호출이 중단되었습니다.", billed: "unknown" };
    if (r.code === -1) return { ok: false, errorFamily: "auth_failed", message: "Claude Code CLI(`claude`)를 찾을 수 없습니다.", billed: "no" };
    let o: Record<string, unknown>;
    try {
      o = stream ? resultOfStream(r.stdout) : (JSON.parse(r.stdout) as Record<string, unknown>);
    } catch {
      // stream mode: stdout's JSON lines carry the model's own text and the init event — classify by stderr and
      // plain (non-JSON) output only, so "author" in a half-written reply never reads as a login problem
      const diag = stream ? r.stdout.split("\n").filter((l) => l.trim() && !l.trimStart().startsWith("{")).join("\n") : r.stdout;
      const hint = /\b(log ?in|logged|auth|authenticat\w*|credentials?|unauthori[sz]ed)\b/i.test(`${r.stderr}\n${diag}`) ? "auth_failed" : "provider_unavailable";
      return {
        ok: false,
        errorFamily: hint,
        message: hint === "auth_failed" ? "Claude Code 로그인이 필요합니다. 터미널에서 `claude auth login`을 실행하세요." : `Claude Code 실행 실패 (exit ${r.code}): ${(r.stderr || diag).slice(0, 300)}`,
        billed: "unknown",
      };
    }
    const usage = mapUsage(o.usage as Record<string, unknown> | undefined, o.total_cost_usd);
    const providerRequestId = typeof o.session_id === "string" ? o.session_id : undefined;
    if (o.is_error === true) {
      const status = typeof o.api_error_status === "number" ? o.api_error_status : undefined;
      const text = String(o.result ?? o.subtype ?? "error");
      const family =
        status === 401 || status === 403 || /login|authenticat/i.test(text)
          ? "auth_failed"
          : status === 429 || /rate.?limit|usage limit|limit reached/i.test(text)
            ? "rate_limited"
            : o.stop_reason === "refusal"
              ? "content_filtered"
              : status && status >= 500
                ? "provider_unavailable"
                : "internal";
      const message =
        family === "rate_limited"
          ? "Claude 구독 사용 한도에 도달했습니다. 한도가 초기화된 뒤 다시 시도합니다."
          : family === "auth_failed"
            ? "Claude Code 로그인이 필요합니다. 터미널에서 `claude auth login`을 실행하세요."
            : `Claude Code 오류: ${text}`.slice(0, 500);
      return { ok: false, errorFamily: family, message, httpStatus: status, billed: family === "rate_limited" || family === "auth_failed" ? "no" : "unknown", usage, providerRequestId };
    }
    const stop = o.stop_reason;
    const finishReason = stop === "max_tokens" ? "length" : stop === "refusal" ? "content_filter" : "stop";
    if (finishReason === "content_filter") return { ok: false, errorFamily: "content_filtered", message: "Claude가 안전 정책으로 응답을 거절했습니다.", billed: "yes", usage, providerRequestId };
    const text = typeof o.result === "string" ? o.result : "";
    const common = { finishReason, usage, modelVersion: req.modelId, providerRequestId, raw: { subtype: o.subtype, stop_reason: stop, num_turns: o.num_turns } } as const;
    if (req.output.kind === "object") {
      const object = o.structured_output !== undefined && o.structured_output !== null ? o.structured_output : parseJsonText(text);
      return { ok: true, object, text: object === undefined ? text : undefined, ...common };
    }
    return { ok: true, text, ...common };
  }
}
