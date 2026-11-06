/**
 * ClaudeCliLlmAdapter with a fake `claude` process: argv (unmodified CLI, no tools/settings/MCP/session),
 * env (API keys removed so the subscription login is used), stdin transcript, JSON result mapping,
 * errors (not logged in, usage limit, missing binary, timeout). No real CLI call.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ClaudeCliLlmAdapter, cliArgs, renderTranscript } from "../../src/modules/llm/adapters/claude-cli/claude-cli-adapter.js";
import { toJsonSchema } from "../../src/modules/llm/application/gateway.js";
import type { LlmRequest } from "../../src/modules/llm/index.js";

interface Call {
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdin: string;
}

function fakeSpawn(respond: (call: Call) => { stdout?: string; stderr?: string; code?: number; error?: string; hang?: boolean }) {
  const calls: Call[] = [];
  const impl = ((bin: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd: string }) => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill: (s?: string) => void };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    const call: Call = { bin, args, env: opts.env, cwd: opts.cwd, stdin: "" };
    calls.push(call);
    child.kill = () => setImmediate(() => child.emit("close", null));
    let input = "";
    child.stdin.on("data", (d: Buffer) => (input += d.toString()));
    child.stdin.on("finish", () => {
      call.stdin = input;
      const r = respond(call);
      if (r.hang) return;
      setImmediate(() => {
        if (r.error) {
          child.emit("error", Object.assign(new Error(r.error), { code: r.error }));
          return;
        }
        if (r.stdout) child.stdout.write(r.stdout);
        if (r.stderr) child.stderr.write(r.stderr);
        child.emit("close", r.code ?? 0);
      });
    });
    return child;
  }) as never;
  return { impl, calls };
}

const Schema = z.object({ title: z.string(), reason: z.string() });
const req = (over: Partial<LlmRequest> = {}): LlmRequest =>
  ({
    modelId: "claude-opus-5-5",
    system: "당신은 웹소설 기획자입니다.",
    messages: [{ role: "user", content: "가제를 지어 줘" }],
    maxOutputTokens: 4000,
    output: { kind: "object", schemaName: "T", jsonSchema: toJsonSchema(Schema) },
    ...over,
  }) as LlmRequest;
const opts = (signal = new AbortController().signal, timeoutMs = 10_000) => ({ apiKey: "", signal, timeoutMs });

const okResult = {
  type: "result",
  subtype: "success",
  is_error: false,
  stop_reason: "tool_use",
  session_id: "sess_1",
  total_cost_usd: 0.0123,
  usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 50, output_tokens: 40, output_tokens_details: { thinking_tokens: 5 } },
  result: '{"title":"짐꾼의 두 번째 상승","reason":"r"}',
  structured_output: { title: "짐꾼의 두 번째 상승", reason: "r" },
};

describe("ClaudeCliLlmAdapter (Claude subscription via the unmodified claude CLI)", () => {
  it("spawns `claude -p` as a plain model call and maps the JSON result", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
    const { impl, calls } = fakeSpawn(() => ({ stdout: JSON.stringify(okResult) }));
    const r = await new ClaudeCliLlmAdapter({ spawnImpl: impl }).invoke(req(), opts());
    delete process.env.ANTHROPIC_API_KEY;
    expect(r).toMatchObject({ ok: true, object: { title: "짐꾼의 두 번째 상승", reason: "r" }, finishReason: "stop", providerRequestId: "sess_1" });
    if (r.ok) expect(r.usage).toEqual({ inputTokens: 160, outputTokens: 40, cachedInputTokens: 100, reasoningTokens: 5, reportedCostMicros: 12300 });
    const c = calls[0]!;
    expect(c.bin).toBe("claude");
    expect(c.args.slice(0, 5)).toEqual(["-p", "--output-format", "json", "--model", "claude-opus-5-5"]);
    for (const f of ["--no-session-persistence", "--strict-mcp-config", "--disable-slash-commands"]) expect(c.args).toContain(f);
    expect(c.args[c.args.indexOf("--tools") + 1]).toBe("");
    expect(c.args[c.args.indexOf("--setting-sources") + 1]).toBe("");
    expect(JSON.parse(c.args[c.args.indexOf("--json-schema") + 1]!)).toMatchObject({ type: "object", additionalProperties: false });
    expect(c.args[c.args.indexOf("--system-prompt") + 1]).toBe("당신은 웹소설 기획자입니다.");
    expect(c.stdin).toBe("가제를 지어 줘");
    expect(c.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(c.cwd).toMatch(/ncs-claude-cli-/);
  });

  it("subscription billing, gateway limits (concurrency, long timeout) from options", () => {
    const a = new ClaudeCliLlmAdapter({ spawnImpl: fakeSpawn(() => ({})).impl, maxConcurrent: 3, callTimeoutMs: 900_000 });
    expect(a.capabilities("claude-opus-5-5").billing).toBe("subscription");
    expect(a.limits).toEqual({ maxConcurrent: 3, callTimeoutMs: 900_000 });
    expect(new ClaudeCliLlmAdapter({ spawnImpl: fakeSpawn(() => ({})).impl }).limits).toEqual({ maxConcurrent: 2, callTimeoutMs: 1_200_000 });
  });

  it("multi-turn messages become one transcript prompt; non-strict schemas go in the system prompt", () => {
    const t = renderTranscript([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ]);
    expect(t).toContain("<user>\na\n</user>");
    expect(t).toContain("<assistant>\nb\n</assistant>");
    const loose = cliArgs(req({ output: { kind: "object", schemaName: "L", jsonSchema: toJsonSchema(z.object({ v: z.record(z.string(), z.unknown()) })) } }));
    expect(loose.strict).toBe(false);
    expect(loose.args).not.toContain("--json-schema");
    expect(loose.args[loose.args.indexOf("--system-prompt") + 1]).toContain("JSON Schema");
  });

  it("errors: usage limit → rate_limited, not logged in → auth_failed, missing binary, timeout", async () => {
    let { impl } = fakeSpawn(() => ({ stdout: JSON.stringify({ ...okResult, is_error: true, result: "Claude usage limit reached", api_error_status: 429 }) }));
    let r = await new ClaudeCliLlmAdapter({ spawnImpl: impl }).invoke(req(), opts());
    expect(!r.ok && r.errorFamily).toBe("rate_limited");

    ({ impl } = fakeSpawn(() => ({ stdout: "", stderr: "Invalid API key · Please run /login", code: 1 })));
    r = await new ClaudeCliLlmAdapter({ spawnImpl: impl }).invoke(req(), opts());
    expect(!r.ok && r.errorFamily).toBe("auth_failed");

    ({ impl } = fakeSpawn(() => ({ error: "ENOENT" })));
    r = await new ClaudeCliLlmAdapter({ spawnImpl: impl }).invoke(req(), opts());
    expect(!r.ok && r.errorFamily).toBe("auth_failed");

    ({ impl } = fakeSpawn(() => ({ hang: true })));
    r = await new ClaudeCliLlmAdapter({ spawnImpl: impl }).invoke(req(), opts(new AbortController().signal, 30));
    expect(!r.ok && r.errorFamily).toBe("timeout");
  });

  it("status / testEnvironment read only `claude auth status`", async () => {
    let { impl, calls } = fakeSpawn(() => ({ stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }) }));
    const a = new ClaudeCliLlmAdapter({ spawnImpl: impl });
    expect((await a.testEnvironment({ apiKey: "", signal: new AbortController().signal })).status).toBe("pass");
    expect(calls[0]!.args).toEqual(["auth", "status"]);

    ({ impl } = fakeSpawn(() => ({ stdout: JSON.stringify({ loggedIn: false }) })));
    expect((await new ClaudeCliLlmAdapter({ spawnImpl: impl }).testEnvironment({ apiKey: "", signal: new AbortController().signal })).status).toBe("fail");

    ({ impl } = fakeSpawn(() => ({ stdout: JSON.stringify({ loggedIn: true, authMethod: "console" }) })));
    expect((await new ClaudeCliLlmAdapter({ spawnImpl: impl }).testEnvironment({ apiKey: "", signal: new AbortController().signal })).status).toBe("warn");
  });
});
