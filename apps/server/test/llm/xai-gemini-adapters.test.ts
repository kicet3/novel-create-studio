/**
 * XaiLlmAdapter (OpenAI-compatible chat completions, SSE) and GeminiLlmAdapter (streamGenerateContent, SSE)
 * against local mocks: request shape, structured output + fallback, usage, errors, OAuth 401 replay. No network.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { XaiLlmAdapter } from "../../src/modules/llm/adapters/xai/xai-adapter.js";
import { GeminiLlmAdapter } from "../../src/modules/llm/adapters/google/gemini-adapter.js";
import { toJsonSchema } from "../../src/modules/llm/application/gateway.js";
import type { LlmCredential, LlmRequest } from "../../src/modules/llm/index.js";
import { json, sse, startMockHttp, type MockHttp } from "./mock-http.js";

let m: MockHttp;
beforeAll(async () => {
  m = await startMockHttp();
});
afterAll(() => m.close());
beforeEach(() => m.reset());

const Obj = z.object({ title: z.string(), n: z.number().int() });
const req = (modelId: string, object = false): LlmRequest => ({
  modelId,
  system: "시스템",
  messages: [
    { role: "user", content: "질문" },
    { role: "assistant", content: "답" },
    { role: "user", content: "다음" },
  ],
  output: object ? { kind: "object", schemaName: "plan arc", jsonSchema: toJsonSchema(Obj) } : { kind: "text" },
  maxOutputTokens: 4000,
});
const opts = (credential?: LlmCredential) => ({ apiKey: credential?.token ?? "key-test", credential, signal: new AbortController().signal, timeoutMs: 10_000 });

describe("XaiLlmAdapter", () => {
  const xai = () => new XaiLlmAdapter({ apiBaseUrl: m.base });
  const chunk = (content: string, finish: string | null = null) => ({ id: "cmpl_1", model: "grok-4.3", choices: [{ delta: { content }, finish_reason: finish }] });

  it("streams chat completions with system message, max_tokens, include_usage; maps usage incl. reasoning", async () => {
    m.on("POST /v1/chat/completions", (_c, res) =>
      sse(res, [chunk("안녕"), chunk("하세요", "stop"), { id: "cmpl_1", choices: [], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 40, completion_tokens_details: { reasoning_tokens: 15 } } }]),
    );
    const r = await xai().invoke(req("grok-4.3"), opts({ method: "api_key", token: "xai-key" }));
    expect(r).toMatchObject({ ok: true, text: "안녕하세요", finishReason: "stop", usage: { inputTokens: 20, outputTokens: 20, reasoningTokens: 15 } });
    const c = m.captured[0]!;
    expect(c.headers.authorization).toBe("Bearer xai-key");
    expect(c.json).toMatchObject({ model: "grok-4.3", max_tokens: 4000, stream: true, stream_options: { include_usage: true } });
    expect(c.json.messages[0]).toEqual({ role: "system", content: "시스템" });
    expect(c.json.messages).toHaveLength(4);
  });

  it("structured output via response_format json_schema; 400 → prompt-described JSON once", async () => {
    m.on("POST /v1/chat/completions", (_c, res) => sse(res, [chunk('{"title":"a","n":1}', "stop")]));
    let r = await xai().invoke(req("grok-4.7", true), opts());
    expect(r.ok && r.object).toEqual({ title: "a", n: 1 });
    expect(m.captured[0]!.json.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "plan_arc", strict: true } });

    m.reset();
    let n = 0;
    m.on("POST /v1/chat/completions", (_c, res) => (n++ === 0 ? json(res, 400, { error: "Invalid response_format" }) : sse(res, [chunk('{"title":"b","n":2}', "stop")])));
    r = await xai().invoke(req("grok-4.7", true), opts());
    expect(r.ok && r.object).toEqual({ title: "b", n: 2 });
    expect(m.captured[1]!.json.response_format).toBeUndefined();
    expect(m.captured[1]!.json.messages[0].content).toContain("JSON Schema");
  });

  it("invalid key 400 (xAI body shape) → auth_failed without a schema-fallback second call", async () => {
    m.on("POST /v1/chat/completions", (_c, res) =>
      json(res, 400, { code: "Client specified an invalid argument", error: "Incorrect API key provided: xa***yz. You can obtain an API key from https://console.x.ai." }),
    );
    const r = await xai().invoke(req("grok-4.7", true), opts({ method: "api_key", token: "xai-bad" }));
    expect(r).toMatchObject({ ok: false, errorFamily: "auth_failed", httpStatus: 400 });
    expect(m.captured).toHaveLength(1);
    if (!r.ok) expect(r.message).not.toContain("xai-bad");
  });

  it("OAuth lane: 401 → refresh → replay; 403 without refresh → auth_failed hinting at the API key", async () => {
    m.on("POST /v1/chat/completions", (c, res) => (c.headers.authorization === "Bearer stale" ? json(res, 401, { error: "expired" }) : sse(res, [chunk("ok", "stop")])));
    const fresh: LlmCredential = { method: "xai_oauth", token: "fresh" };
    const r = await xai().invoke(req("grok-4.3"), opts({ method: "xai_oauth", token: "stale", refresh: async () => fresh }));
    expect(r).toMatchObject({ ok: true, text: "ok" });

    m.on("POST /v1/chat/completions", (_c, res) => json(res, 403, { error: "OAuth not permitted for this tier" }));
    const f = await xai().invoke(req("grok-4.3"), opts({ method: "xai_oauth", token: "t" }));
    expect(f).toMatchObject({ ok: false, errorFamily: "auth_failed" });
    if (!f.ok) expect(f.message).toContain("API 키");
  });

  it("429 with Retry-After → rate_limited; content_filter finish → content_filtered; testEnvironment lists /v1/models", async () => {
    m.on("POST /v1/chat/completions", (_c, res) => json(res, 429, { error: "Too many requests: rate limit" }, { "retry-after": "3" }));
    const r = await xai().invoke(req("grok-4.3"), opts());
    expect(r).toMatchObject({ ok: false, errorFamily: "rate_limited" });
    if (!r.ok) expect(r.retryNotBefore).toBeInstanceOf(Date);

    m.on("POST /v1/chat/completions", (_c, res) => sse(res, [chunk("", "content_filter")]));
    expect(await xai().invoke(req("grok-4.3"), opts())).toMatchObject({ ok: false, errorFamily: "content_filtered" });

    m.on("GET /v1/models", (_c, res) => json(res, 200, { data: [{ id: "grok-4.3" }] }));
    expect((await xai().testEnvironment({ apiKey: "xai-k", modelId: "grok-4.3", signal: new AbortController().signal })).status).toBe("pass");
    expect((await xai().testEnvironment({ apiKey: "xai-k", modelId: "grok-9", signal: new AbortController().signal })).status).toBe("warn");
  });
});

describe("GeminiLlmAdapter", () => {
  const gem = () => new GeminiLlmAdapter({ apiBaseUrl: m.base });
  const path = (model: string) => `POST /v1beta/models/${model}:streamGenerateContent`;
  const part = (text: string, extra: Record<string, unknown> = {}) => ({ candidates: [{ content: { role: "model", parts: [{ text }] } }], ...extra });

  it("streamGenerateContent?alt=sse with x-goog-api-key, systemInstruction, model role; skips thought parts; usage incl. thoughts", async () => {
    m.on(path("gemini-3.8-flash"), (_c, res) =>
      sse(res, [
        { candidates: [{ content: { parts: [{ text: "생각 중", thought: true }] } }] },
        part("첫 "),
        part("문장", { candidates: [{ content: { parts: [{ text: "문장" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 10, thoughtsTokenCount: 5, cachedContentTokenCount: 8 }, modelVersion: "gemini-3.8-flash-001", responseId: "g1" }),
      ]),
    );
    const r = await gem().invoke(req("gemini-3.8-flash"), opts({ method: "api_key", token: "AIza-test" }));
    expect(r).toMatchObject({ ok: true, text: "첫 문장", finishReason: "stop", usage: { inputTokens: 30, outputTokens: 15, cachedInputTokens: 8, reasoningTokens: 5 }, modelVersion: "gemini-3.8-flash-001" });
    const c = m.captured[0]!;
    expect(c.url.searchParams.get("alt")).toBe("sse");
    expect(c.headers["x-goog-api-key"]).toBe("AIza-test");
    expect(c.headers.authorization).toBeUndefined();
    expect(c.json.systemInstruction).toEqual({ parts: [{ text: "시스템" }] });
    expect(c.json.contents.map((x: { role: string }) => x.role)).toEqual(["user", "model", "user"]);
    expect(c.json.generationConfig).toEqual({ maxOutputTokens: 4000 });
  });

  it("JSON: responseMimeType + responseJsonSchema; 400 on the schema → instruction fallback; invalid key 400 → auth_failed", async () => {
    m.on(path("gemini-4-argon"), (_c, res) => sse(res, [part('{"title":"g","n":3}')]));
    let r = await gem().invoke(req("gemini-4-argon", true), opts());
    expect(r.ok && r.object).toEqual({ title: "g", n: 3 });
    expect(m.captured[0]!.json.generationConfig).toMatchObject({ responseMimeType: "application/json", responseJsonSchema: { type: "object" } });

    m.reset();
    let n = 0;
    m.on(path("gemini-4-argon"), (_c, res) => (n++ === 0 ? json(res, 400, { error: { code: 400, message: "schema too complex", status: "INVALID_ARGUMENT" } }) : sse(res, [part('{"title":"h","n":4}')])));
    r = await gem().invoke(req("gemini-4-argon", true), opts());
    expect(r.ok && r.object).toEqual({ title: "h", n: 4 });
    expect(m.captured[1]!.json.generationConfig.responseJsonSchema).toBeUndefined();
    expect(m.captured[1]!.json.generationConfig.responseMimeType).toBe("application/json");

    m.on(path("gemini-4-argon"), (_c, res) => json(res, 400, { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } }));
    expect(await gem().invoke(req("gemini-4-argon"), opts())).toMatchObject({ ok: false, errorFamily: "auth_failed" });
  });

  it("429 RESOURCE_EXHAUSTED with retryDelay → rate_limited; SAFETY / blockReason → content_filtered; MAX_TOKENS → length", async () => {
    m.on(path("gemini-3.8-flash"), (_c, res) =>
      json(res, 429, { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for requests per minute.", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "12s" }] } }),
    );
    const before = Date.now();
    const r = await gem().invoke(req("gemini-3.8-flash"), opts());
    expect(r).toMatchObject({ ok: false, errorFamily: "rate_limited" });
    if (!r.ok) expect(r.retryNotBefore!.getTime()).toBeGreaterThanOrEqual(before + 11_000);

    m.on(path("gemini-3.8-flash"), (_c, res) => sse(res, [{ promptFeedback: { blockReason: "SAFETY" } }]));
    expect(await gem().invoke(req("gemini-3.8-flash"), opts())).toMatchObject({ ok: false, errorFamily: "content_filtered", billed: "no" });
    m.on(path("gemini-3.8-flash"), (_c, res) => sse(res, [{ candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "SAFETY" }] }]));
    expect(await gem().invoke(req("gemini-3.8-flash"), opts())).toMatchObject({ ok: false, errorFamily: "content_filtered" });
    m.on(path("gemini-3.8-flash"), (_c, res) => sse(res, [{ candidates: [{ content: { parts: [{ text: "잘림" }] }, finishReason: "MAX_TOKENS" }] }]));
    expect(await gem().invoke(req("gemini-3.8-flash"), opts())).toMatchObject({ ok: true, finishReason: "length", text: "잘림" });
  });

  it("testEnvironment: GET /v1beta/models/{id}; 404 → warn", async () => {
    m.on("GET /v1beta/models/gemini-3.8-flash", (_c, res) => json(res, 200, { name: "models/gemini-3.8-flash" }));
    expect((await gem().testEnvironment({ apiKey: "AIza", modelId: "gemini-3.8-flash", signal: new AbortController().signal })).status).toBe("pass");
    expect((await gem().testEnvironment({ apiKey: "AIza", modelId: "nope", signal: new AbortController().signal })).status).toBe("warn");
    expect((await gem().testEnvironment({ apiKey: "", signal: new AbortController().signal })).status).toBe("fail");
  });
});
