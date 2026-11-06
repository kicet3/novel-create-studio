/**
 * AnthropicLlmAdapter against a local mock of the Claude Messages API (SSE stream):
 * request shape (streaming, cache breakpoints, output_config json_schema, refusal fallback beta,
 * no sampling params) and response/usage/error mapping. No network, no API key.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { AnthropicLlmAdapter, buildOutputFormat, isStrictRepresentable, parseJsonText } from "../../src/modules/llm/adapters/anthropic/anthropic-adapter.js";
import { toJsonSchema } from "../../src/modules/llm/application/gateway.js";
import type { LlmRequest } from "../../src/modules/llm/index.js";

interface Captured {
  path: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
}

let server: Server;
let base = "";
let captured: Captured[] = [];
let reply: (res: ServerResponse) => void = () => {};

function sse(res: ServerResponse, text: string, opts: { stop?: string; usage?: Record<string, number>; model?: string } = {}) {
  res.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_test_1" });
  const ev = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  ev("message_start", {
    type: "message_start",
    message: {
      id: "msg_test_1",
      type: "message",
      role: "assistant",
      model: opts.model ?? "claude-opus-5-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 30, cache_creation_input_tokens: 10, ...opts.usage },
    },
  });
  ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  for (const chunk of [text.slice(0, Math.ceil(text.length / 2)), text.slice(Math.ceil(text.length / 2))]) {
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunk } });
  }
  ev("content_block_stop", { type: "content_block_stop", index: 0 });
  ev("message_delta", { type: "message_delta", delta: { stop_reason: opts.stop ?? "end_turn", stop_sequence: null }, usage: { output_tokens: 42 } });
  ev("message_stop", { type: "message_stop" });
  res.end();
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      captured.push({ path: req.url ?? "", headers: req.headers, body: raw ? JSON.parse(raw) : {} });
      reply(res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  captured = [];
});

const ProposalSchema = z.object({
  reply_text: z.string().default(""),
  working_title: z.object({ title: z.string(), reason: z.string().default("") }).nullable().default(null),
});

function request(over: Partial<LlmRequest> = {}): LlmRequest {
  return {
    modelId: "claude-opus-5-5",
    system: "당신은 컨셉 파트너입니다.",
    messages: [{ role: "user", content: "회귀한 짐꾼 이야기" }],
    maxOutputTokens: 4000,
    output: { kind: "object", schemaName: "ConceptTurnProposal", jsonSchema: toJsonSchema(ProposalSchema) },
    ...over,
  } as LlmRequest;
}

const invoke = (req: LlmRequest) =>
  new AnthropicLlmAdapter({ baseURL: base }).invoke(req, { apiKey: "sk-ant-test", signal: new AbortController().signal, timeoutMs: 10_000, idempotencyKey: "pcl_1" });

describe("AnthropicLlmAdapter (official SDK, mocked Claude API)", () => {
  it("streams a structured-output request with cache breakpoints and the refusal fallback beta", async () => {
    reply = (res) => sse(res, JSON.stringify({ reply_text: "좋아요", working_title: { title: "탑을 오르는 짐꾼", reason: "" } }));
    const r = await invoke(request({ messages: [{ role: "user", content: "고정 맥락", cacheBoundary: true }, { role: "user", content: "새 메시지" }] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.object).toEqual({ reply_text: "좋아요", working_title: { title: "탑을 오르는 짐꾼", reason: "" } });
    expect(r.finishReason).toBe("stop");
    expect(r.providerRequestId).toBe("msg_test_1");
    expect(r.usage).toEqual({ inputTokens: 160, outputTokens: 42, cachedInputTokens: 30, reasoningTokens: undefined });

    const c = captured[0]!;
    expect(c.path).toMatch(/^\/v1\/messages/);
    // SDK 1.x sends the key as a bearer token (older releases used x-api-key)
    expect(c.headers["x-api-key"] ?? String(c.headers.authorization).replace(/^Bearer /, "")).toBe("sk-ant-test");
    expect(String(c.headers["anthropic-beta"])).toContain("server-side-fallback-2026-07-01");
    expect(c.headers["x-ncs-idempotency-key"]).toBe("pcl_1");
    const b = c.body;
    expect(b.model).toBe("claude-opus-5-5");
    expect(b.stream).toBe(true);
    expect(b.max_tokens).toBe(4000);
    expect(b.fallbacks).toBe("default");
    for (const k of ["temperature", "top_p", "top_k", "thinking"]) expect(b).not.toHaveProperty(k);
    expect(b.system).toEqual([{ type: "text", text: "당신은 컨셉 파트너입니다.", cache_control: { type: "ephemeral" } }]);
    const msgs = b.messages as Array<{ content: unknown }>;
    expect(msgs[0]!.content).toEqual([{ type: "text", text: "고정 맥락", cache_control: { type: "ephemeral" } }]);
    expect(msgs[1]!.content).toBe("새 메시지");
    const fmt = (b.output_config as { format: { type: string; schema: Record<string, unknown> } }).format;
    expect(fmt.type).toBe("json_schema");
    expect(fmt.schema.additionalProperties).toBe(false);
  });

  it("schemas with records/unknown fall back to prompt-described JSON (no output_config); fenced JSON parses", async () => {
    const Loose = z.object({ slot_updates: z.array(z.object({ field_path: z.string(), new_value: z.unknown() })), delegate_values: z.record(z.string(), z.unknown()) });
    const js = toJsonSchema(Loose);
    expect(isStrictRepresentable(js)).toBe(false);
    reply = (res) => sse(res, '```json\n{"slot_updates":[{"field_path":"a","new_value":1}],"delegate_values":{"x":"y"}}\n```');
    const r = await invoke(request({ output: { kind: "object", schemaName: "Loose", jsonSchema: js } }));
    expect(r.ok && r.object).toEqual({ slot_updates: [{ field_path: "a", new_value: 1 }], delegate_values: { x: "y" } });
    const b = captured[0]!.body;
    expect(b).not.toHaveProperty("output_config");
    expect(((b.system as Array<{ text: string }>)[0]!.text)).toContain("JSON Schema");
  });

  it("text output, max_tokens → length, haiku has no fallback beta", async () => {
    reply = (res) => sse(res, "본문 일부", { stop: "max_tokens", model: "claude-haiku-5-5" });
    const r = await invoke(request({ modelId: "claude-haiku-5-5", output: { kind: "text" } }));
    expect(r.ok && r.text).toBe("본문 일부");
    expect(r.ok && r.finishReason).toBe("length");
    expect(captured[0]!.body).not.toHaveProperty("fallbacks");
    expect(captured[0]!.headers["anthropic-beta"]).toBeUndefined();
  });

  it("refusal → content_filtered; 401 → auth_failed; 429 → rate_limited with retry-after", async () => {
    reply = (res) => sse(res, "", { stop: "refusal" });
    let r = await invoke(request());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorFamily).toBe("content_filtered");

    reply = (res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
    };
    r = await invoke(request());
    expect(!r.ok && r.errorFamily).toBe("auth_failed");
    expect(!r.ok && r.billed).toBe("no");

    reply = (res) => {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "7" });
      res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }));
    };
    r = await invoke(request());
    expect(!r.ok && r.errorFamily).toBe("rate_limited");
    expect(!r.ok && r.retryNotBefore).toBeInstanceOf(Date);
  });

  it("testEnvironment: missing key fails without a request; models endpoint ok → pass", async () => {
    const a = new AnthropicLlmAdapter({ baseURL: base });
    expect((await a.testEnvironment({ apiKey: "", signal: new AbortController().signal })).status).toBe("fail");
    expect(captured).toHaveLength(0);
    reply = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-01-01T00:00:00Z" }));
    };
    const ok = await a.testEnvironment({ apiKey: "k", modelId: "claude-opus-5-5", signal: new AbortController().signal });
    expect(ok.status).toBe("pass");
    expect(captured[0]!.path).toMatch(/^\/v1\/models\/claude-opus-5-5/);
  });

  it("helpers: buildOutputFormat / parseJsonText", () => {
    expect(buildOutputFormat(toJsonSchema(ProposalSchema)).strict).toBe(true);
    expect(parseJsonText('앞말 {"a":1} 뒷말')).toEqual({ a: 1 });
    expect(parseJsonText("not json")).toBeUndefined();
  });
});
