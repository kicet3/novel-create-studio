/**
 * OpenAiLlmAdapter against a local mock of the OpenAI Responses API and the ChatGPT Codex backend (SSE):
 * request shape per lane (API key vs ChatGPT sign-in, responses-lite shaping), text accumulation without
 * truncation, json_schema → json_object fallback, 401 refresh-and-replay, 429 classification. No network.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { OpenAiLlmAdapter, buildResponsesBody, isLiteModel } from "../../src/modules/llm/adapters/openai/openai-adapter.js";
import { strictJsonSchema } from "../../src/modules/llm/adapters/shared/json-schema.js";
import { toJsonSchema } from "../../src/modules/llm/application/gateway.js";
import type { LlmCredential, LlmRequest } from "../../src/modules/llm/index.js";
import { json, sse, startMockHttp, type MockHttp } from "./mock-http.js";

let m: MockHttp;
let adapter: OpenAiLlmAdapter;
beforeAll(async () => {
  m = await startMockHttp();
  adapter = new OpenAiLlmAdapter({ apiBaseUrl: m.base, codexBaseUrl: `${m.base}/codex` });
});
afterAll(() => m.close());
beforeEach(() => m.reset());

const textReq = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  modelId: "gpt-6.1-terra",
  system: "당신은 작가입니다.",
  messages: [
    { role: "user", content: "1화를 써 주세요." },
    { role: "assistant", content: "네." },
    { role: "user", content: "계속" },
  ],
  output: { kind: "text" },
  maxOutputTokens: 16000,
  ...over,
});
const Obj = z.object({ title: z.string(), beats: z.array(z.string()) });
const OptObj = z.object({ title: z.string(), note: z.string().optional() });
const objReq = (schema: z.ZodType = Obj): LlmRequest => textReq({ output: { kind: "object", schemaName: "outline_episode", jsonSchema: toJsonSchema(schema) } });
const opts = (credential?: LlmCredential) => ({ apiKey: credential?.token ?? "sk-test", credential, signal: new AbortController().signal, timeoutMs: 10_000 });

const completed = (usage: Record<string, unknown> = {}) => ({
  type: "response.completed",
  response: { id: "resp_1", model: "gpt-6.1-terra-2026-10-01", status: "completed", output: [], usage: { input_tokens: 100, output_tokens: 50, input_tokens_details: { cached_tokens: 40 }, output_tokens_details: { reasoning_tokens: 7 }, ...usage } },
});
const deltas = (text: string, n = 3) => {
  const size = Math.ceil(text.length / n);
  return Array.from({ length: n }, (_, i) => ({ type: "response.output_text.delta", delta: text.slice(i * size, (i + 1) * size) }));
};

describe("OpenAiLlmAdapter — API key lane (api.openai.com /v1/responses)", () => {
  it("streams text (CRLF SSE), no 4,000-char truncation, maps usage; sends instructions + max_output_tokens + store:false", async () => {
    const long = "가".repeat(6000);
    m.on("POST /v1/responses", (_c, res) => sse(res, [{ type: "response.created", response: { id: "resp_1", model: "gpt-6.1-terra" } }, ...deltas(long), completed()], { crlf: true }));
    const r = await adapter.invoke(textReq(), opts());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toBe(long);
    expect(r.finishReason).toBe("stop");
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 50, cachedInputTokens: 40, reasoningTokens: 7 });
    expect(r.modelVersion).toBe("gpt-6.1-terra-2026-10-01");
    const c = m.captured[0]!;
    expect(c.headers.authorization).toBe("Bearer sk-test");
    expect(c.headers.accept).toBe("text/event-stream");
    expect(c.json).toMatchObject({ model: "gpt-6.1-terra", instructions: "당신은 작가입니다.", max_output_tokens: 16000, store: false, stream: true });
    expect(c.json.input[1]).toEqual({ role: "assistant", content: [{ type: "output_text", text: "네." }] });
    expect(c.json.input[0].content[0].type).toBe("input_text");
    expect(c.json).not.toHaveProperty("temperature");
  });

  it("structured output: strict json_schema when every field is required, strict:false otherwise", async () => {
    m.on("POST /v1/responses", (_c, res) => sse(res, [...deltas(JSON.stringify({ title: "t", beats: ["a"] })), completed()]));
    const r = await adapter.invoke(objReq(), opts());
    expect(r.ok && r.object).toEqual({ title: "t", beats: ["a"] });
    const f = m.captured[0]!.json.text.format;
    expect(f).toMatchObject({ type: "json_schema", name: "outline_episode", strict: true });
    expect(f.schema.additionalProperties).toBe(false);
    expect(f.schema.required).toEqual(["title", "beats"]);

    expect(strictJsonSchema(toJsonSchema(OptObj))).toBeNull();
    expect(strictJsonSchema(toJsonSchema(z.object({ data: z.record(z.string(), z.string()) })))).toBeNull();
    const b = buildResponsesBody(objReq(OptObj), "api", "schema");
    expect((b.text as { format: { strict: boolean } }).format.strict).toBe(false);
  });

  it("a 400 on the schema format retries once with json_object + the schema in the instructions", async () => {
    let n = 0;
    m.on("POST /v1/responses", (_c, res) => {
      if (n++ === 0) return json(res, 400, { error: { message: "Invalid schema for response_format", type: "invalid_request_error" } });
      sse(res, [...deltas('```json\n{"title":"x","beats":[]}\n```'), completed()]);
    });
    const r = await adapter.invoke(objReq(), opts());
    expect(r.ok && r.object).toEqual({ title: "x", beats: [] });
    expect(m.captured).toHaveLength(2);
    expect(m.captured[1]!.json.text.format).toEqual({ type: "json_object" });
    expect(m.captured[1]!.json.instructions).toContain("JSON Schema");
  });

  it("errors: 401 auth_failed (no refresh for API keys), 429 per-minute → rate_limited + retryNotBefore, usage cap → quota_exhausted, 500 → provider_unavailable", async () => {
    m.on("POST /v1/responses", (_c, res) => json(res, 401, { error: { message: "Incorrect API key provided: sk-abcdef123456" } }));
    let r = await adapter.invoke(textReq(), opts());
    expect(r).toMatchObject({ ok: false, errorFamily: "auth_failed", httpStatus: 401, billed: "no" });
    expect(JSON.stringify(r)).not.toContain("sk-abcdef123456");

    m.on("POST /v1/responses", (_c, res) => json(res, 429, { error: { message: "Rate limit reached for gpt-6.1-terra on tokens per min. Please try again in 7.5s.", code: "rate_limit_exceeded" } }));
    const before = Date.now();
    r = await adapter.invoke(textReq(), opts());
    expect(r).toMatchObject({ ok: false, errorFamily: "rate_limited" });
    if (!r.ok) expect(r.retryNotBefore!.getTime()).toBeGreaterThanOrEqual(before + 7000);

    m.on("POST /v1/responses", (_c, res) => json(res, 429, { error: { message: "You've hit your usage limit (5 hours).", code: "usage_limit_reached" } }));
    r = await adapter.invoke(textReq(), opts());
    expect(r).toMatchObject({ ok: false, errorFamily: "quota_exhausted" });

    m.on("POST /v1/responses", (_c, res) => json(res, 503, { error: { message: "overloaded" } }));
    r = await adapter.invoke(textReq(), opts());
    expect(r).toMatchObject({ ok: false, errorFamily: "provider_unavailable", billed: "unknown" });
  });

  it("response.incomplete → length; response.failed → failure; refusal → content_filtered; timeout → timeout", async () => {
    m.on("POST /v1/responses", (_c, res) =>
      sse(res, [...deltas("잘린 글"), { type: "response.incomplete", response: { id: "r", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 1, output_tokens: 2 } } }]),
    );
    let r = await adapter.invoke(textReq(), opts());
    expect(r).toMatchObject({ ok: true, finishReason: "length", text: "잘린 글" });

    m.on("POST /v1/responses", (_c, res) => sse(res, [{ type: "response.failed", response: { error: { code: "server_error", message: "boom" } } }]));
    r = await adapter.invoke(textReq(), opts());
    expect(r).toMatchObject({ ok: false, errorFamily: "provider_unavailable" });

    m.on("POST /v1/responses", (_c, res) => sse(res, [{ type: "response.refusal.delta", delta: "I can't help with that." }, completed()]));
    r = await adapter.invoke(textReq(), opts());
    expect(r).toMatchObject({ ok: false, errorFamily: "content_filtered", billed: "yes" });

    m.on("POST /v1/responses", () => {
      /* never answers */
    });
    r = await adapter.invoke(textReq(), { ...opts(), timeoutMs: 100 });
    expect(r).toMatchObject({ ok: false, errorFamily: "timeout", billed: "unknown" });
  });
});

describe("OpenAiLlmAdapter — ChatGPT sign-in lane (Codex backend)", () => {
  const cred = (token: string, refresh?: LlmCredential["refresh"]): LlmCredential => ({ method: "chatgpt_oauth", token, headers: { "chatgpt-account-id": "acct_123" }, refresh });

  it("responses-lite shaping for GPT-6: developer input item, empty instructions, no max_output_tokens, lite header + account header", async () => {
    m.on("POST /codex/responses", (_c, res) => sse(res, [...deltas("본문입니다"), { type: "response.completed", response: { id: "r", status: "completed", output: [], usage: { input_tokens: 9, output_tokens: 3 } } }]));
    const r = await adapter.invoke(textReq({ modelId: "gpt-6-luna" }), opts(cred("at_1")));
    expect(r).toMatchObject({ ok: true, text: "본문입니다", usage: { inputTokens: 9, outputTokens: 3 } });
    const c = m.captured[0]!;
    expect(c.headers.authorization).toBe("Bearer at_1");
    expect(c.headers["chatgpt-account-id"]).toBe("acct_123");
    expect(c.headers["x-openai-internal-codex-responses-lite"]).toBe("true");
    expect(c.json).toMatchObject({ model: "gpt-6-luna", store: false, stream: true, instructions: "", parallel_tool_calls: false, reasoning: { context: "all_turns" } });
    expect(c.json.input[0]).toEqual({ role: "developer", content: [{ type: "input_text", text: "당신은 작가입니다." }] });
    expect(c.json).not.toHaveProperty("max_output_tokens");
    expect(isLiteModel("gpt-6.1-sol")).toBe(true);
    expect(isLiteModel("gpt-5.5")).toBe(false);
    const nonLite = buildResponsesBody(textReq({ modelId: "gpt-5.5" }), "chatgpt", null);
    expect(nonLite.instructions).toBe("당신은 작가입니다.");
  });

  it("falls back to output_item.done text when no deltas arrive", async () => {
    m.on("POST /codex/responses", (_c, res) =>
      sse(res, [{ type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "완성 문장" }] } }, { type: "response.completed", response: { status: "completed", output: [] } }]),
    );
    const r = await adapter.invoke(textReq({ modelId: "gpt-6-luna" }), opts(cred("at_1")));
    expect(r).toMatchObject({ ok: true, text: "완성 문장" });
  });

  it("401 → refresh once (credential.refresh) → replay with the new token", async () => {
    m.on("POST /codex/responses", (c, res) => {
      if (c.headers.authorization === "Bearer old") return json(res, 401, { error: { message: "token expired" } });
      sse(res, [...deltas("ok"), completed()]);
    });
    let refreshed = 0;
    const r = await adapter.invoke(textReq({ modelId: "gpt-6-luna" }), opts(cred("old", async () => (refreshed++, cred("new")))));
    expect(r).toMatchObject({ ok: true, text: "ok" });
    expect(refreshed).toBe(1);
    expect(m.captured.map((c) => c.headers.authorization)).toEqual(["Bearer old", "Bearer new"]);

    m.reset();
    m.on("POST /codex/responses", (_c, res) => json(res, 401, { error: { message: "expired" } }));
    const r2 = await adapter.invoke(textReq({ modelId: "gpt-6-luna" }), opts(cred("old", async () => null)));
    expect(r2).toMatchObject({ ok: false, errorFamily: "auth_failed" });
    if (!r2.ok) expect(r2.message).toContain("다시 로그인");
    expect(m.captured).toHaveLength(1);
  });

  it("testEnvironment: GET /models?client_version=… lists the account's models; unknown model → warn", async () => {
    m.on("GET /codex/models", (_c, res) => json(res, 200, { models: [{ slug: "gpt-6-luna" }, { slug: "gpt-6-sol" }, { slug: "hidden", visibility: "hide" }] }));
    const ok = await adapter.testEnvironment({ apiKey: "at", credential: cred("at"), modelId: "gpt-6-luna", signal: new AbortController().signal });
    expect(ok.status).toBe("pass");
    expect(m.captured[0]!.url.searchParams.get("client_version")).toBe("0.157.0");
    const warn = await adapter.testEnvironment({ apiKey: "at", credential: cred("at"), modelId: "hidden", signal: new AbortController().signal });
    expect(warn.status).toBe("warn");
    m.on("GET /v1/models", (_c, res) => json(res, 401, { error: { message: "bad key" } }));
    const bad = await adapter.testEnvironment({ apiKey: "sk-x", signal: new AbortController().signal });
    expect(bad).toMatchObject({ status: "fail", errorFamily: "auth_failed" });
    expect((await adapter.testEnvironment({ apiKey: "", signal: new AbortController().signal })).status).toBe("fail");
  });
});
