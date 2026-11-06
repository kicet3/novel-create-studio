/**
 * Scripted stand-in for the `claude` executable (spawnImpl seam of ClaudeCliLlmAdapter). Tests never run the real
 * Claude Code CLI: every spawn is answered by `respond(call)` (stdout/stderr/exit code, spawn error, or hang).
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { ClaudeCliLlmAdapter, type ClaudeCliOptions } from "../../src/modules/llm/adapters/claude-cli/claude-cli-adapter.js";

export interface CliCall {
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdin: string;
}

export interface CliReply {
  stdout?: string;
  stderr?: string;
  code?: number;
  /** spawn error code, e.g. "ENOENT" (executable not found) */
  error?: string;
  hang?: boolean;
  delayMs?: number;
  /** stdout written in these pieces (a few ms apart) instead of `stdout` at once — e.g. stream-json lines split mid-line */
  stdoutChunks?: string[];
}

export function scriptedSpawn(respond: (call: CliCall) => CliReply) {
  const calls: CliCall[] = [];
  let running = 0;
  let maxRunning = 0;
  const impl = ((bin: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd: string }) => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill: (s?: string) => void };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    const call: CliCall = { bin, args, env: opts.env, cwd: opts.cwd, stdin: "" };
    calls.push(call);
    running++;
    maxRunning = Math.max(maxRunning, running);
    let closed = false;
    const close = (code: number | null) => {
      if (closed) return;
      closed = true;
      running--;
      child.emit("close", code);
    };
    child.kill = () => setImmediate(() => close(null));
    let input = "";
    child.stdin.on("data", (d: Buffer) => (input += d.toString()));
    child.stdin.on("finish", () => {
      call.stdin = input;
      const r = respond(call);
      if (r.hang) return;
      setTimeout(() => {
        if (r.error) {
          closed = true;
          running--;
          child.emit("error", Object.assign(new Error(r.error), { code: r.error }));
          return;
        }
        if (r.stdoutChunks) {
          void (async () => {
            for (const c of r.stdoutChunks!) {
              child.stdout.write(c);
              await new Promise((ok) => setTimeout(ok, 2));
            }
            if (r.stderr) child.stderr.write(r.stderr);
            close(r.code ?? 0);
          })();
          return;
        }
        if (r.stdout) child.stdout.write(r.stdout);
        if (r.stderr) child.stderr.write(r.stderr);
        close(r.code ?? 0);
      }, r.delayMs ?? 0);
    });
    return child;
  }) as never as NonNullable<ClaudeCliOptions["spawnImpl"]>;
  return {
    impl,
    calls,
    get maxRunning() {
      return maxRunning;
    },
  };
}

export const AUTH_STATUS_SUBSCRIPTION = JSON.stringify({ loggedIn: true, authMethod: "claude.ai" });

/** ClaudeCliLlmAdapter over a scripted spawn; default: `claude` is not installed (ENOENT) */
export function scriptedClaudeCli(respond: (call: CliCall) => CliReply = () => ({ error: "ENOENT" }), opts: Omit<ClaudeCliOptions, "spawnImpl"> = {}) {
  const spawn = scriptedSpawn(respond);
  return { adapter: new ClaudeCliLlmAdapter({ ...opts, spawnImpl: spawn.impl }), spawn };
}

/** a successful `claude -p --output-format json` result line */
export function cliResult(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    stop_reason: "end_turn",
    session_id: "sess_test",
    total_cost_usd: 0.05,
    usage: { input_tokens: 100, output_tokens: 50 },
    result: "",
    ...over,
  });
}
