/**
 * Image adapters against local mock HTTP servers (no network): request shape per provider, credential headers,
 * 401 refresh + replay, cost reporting, error classification, Gemini Interactions → generateContent fallback.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LlmCredential } from "../../src/modules/llm/index.js";
import { OpenAiImageAdapter } from "../../src/modules/imaging/adapters/openai/openai-image-adapter.js";
import { XaiImageAdapter } from "../../src/modules/imaging/adapters/xai/xai-image-adapter.js";
import { GeminiImageAdapter } from "../../src/modules/imaging/adapters/google/gemini-image-adapter.js";
import { composePrompt, estimateMicros, findModel, openAiSize, validateParams } from "../../src/modules/imaging/domain/catalog.js";
import { sniffImage } from "../../src/modules/imaging/domain/image-meta.js";
import { json, startMockHttp, type MockHttp } from "../llm/mock-http.js";
import { PNG_B64 } from "./fixtures.js";


let m: MockHttp;
beforeAll(async () => {
  m = await startMockHttp();
});
afterAll(async () => {
  await m.close();
});
beforeEach(() => m.reset());

const key = (token: string): LlmCredential => ({ method: "api_key", token });
const opts = (credential: LlmCredential, timeoutMs = 5_000) => ({ credential, signal: new AbortController().signal, timeoutMs });
const req = { modelId: "gpt-image-2.6-flare", prompt: "달빛 아래 성", n: 2, aspectRatio: "3:2", resolution: "1k" as const, quality: "high" as const };

describe("catalog (pure)", () => {
  it("maps aspect + resolution to OpenAI sizes (multiples of 16) and validates params", () => {
    expect(openAiSize("1:1", "1k")).toBe("1024x1024");
    expect(openAiSize("3:2", "1k")).toBe("1536x1024");
    expect(openAiSize("16:9", "2k")).toBe("2048x1152");
    for (const s of ["16:9", "9:16", "3:2", "2:3"]) {
      const [w, h] = openAiSize(s, "2k")!.split("x").map(Number);
      expect(w! % 16).toBe(0);
      expect(h! % 16).toBe(0);
    }
    const lite = findModel("google", "gemini-3.1-flash-lite-image")!;
    expect(validateParams(lite, { aspectRatio: "1:1", resolution: "2k", count: 1 })).toContain("해상도");
    expect(validateParams(lite, { aspectRatio: "1:1", resolution: "1k", count: 5 })).toContain("4장까지");
    expect(validateParams(findModel("xai", "grok-imagine-image-2.0")!, { aspectRatio: "7:3", resolution: "1k", count: 1 })).toContain("화면비");
  });

  it("estimates per image × n (OpenAI scaled by quality and pixels) and composes the prompt", () => {
    const flare = findModel("openai", "gpt-image-2.6-flare")!;
    expect(estimateMicros("openai", flare, { aspectRatio: "1:1", resolution: "1k", quality: "medium", n: 1 })).toBe(53_000);
    expect(estimateMicros("openai", flare, { aspectRatio: "3:2", resolution: "1k", quality: "high", n: 2 })).toBe(Math.round(53_000 * (211 / 53) * 1.5) * 2);
    expect(estimateMicros("xai", findModel("xai", "grok-imagine-image-2.0")!, { aspectRatio: "16:9", resolution: "2k", n: 3 })).toBe(180_000);
    expect(estimateMicros("google", findModel("google", "gemini-3-pro-image")!, { aspectRatio: "1:1", resolution: "4k", n: 1 }, { "4k": 250_000 })).toBe(250_000);
    expect(composePrompt("성", "수채화", "글자")).toBe("성\n\n스타일 지시: 수채화\n\n이미지에 넣지 말 것: 글자");
  });

  it("sniffs PNG / JPEG / WebP dimensions", () => {
    expect(sniffImage(Buffer.from(PNG_B64, "base64"))).toEqual({ mimeType: "image/png", width: 1, height: 1 });
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 20, 0, 30, 3, 0, 0, 0]);
    expect(sniffImage(jpeg)).toEqual({ mimeType: "image/jpeg", width: 30, height: 20 });
    const webp = new Uint8Array(30);
    webp.set(Buffer.from("RIFF"), 0);
    webp.set(Buffer.from("WEBPVP8X"), 8);
    webp.set([99, 0, 0, 49, 0, 0], 24);
    expect(sniffImage(webp)).toEqual({ mimeType: "image/webp", width: 100, height: 50 });
    expect(sniffImage(Uint8Array.from([1, 2, 3]))).toBeNull();
  });
});

describe("OpenAI image adapter", () => {
  it("API key lane: POST /v1/images/generations with size/quality/n, decodes b64_json, returns usage", async () => {
    m.on("POST /v1/images/generations", (_c, res) =>
      json(res, 200, { data: [{ b64_json: PNG_B64 }, { b64_json: PNG_B64, revised_prompt: "moonlit castle" }], usage: { input_tokens: 20, output_tokens: 4000 } }),
    );
    const a = new OpenAiImageAdapter({ apiBaseUrl: m.base, codexBaseUrl: `${m.base}/codex` });
    const r = await a.generate(req, opts(key("sk-test-123456")));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.images).toHaveLength(2);
    expect(r.images[1]!.revisedPrompt).toBe("moonlit castle");
    expect(r.usage).toEqual({ inputTokens: 20, outputTokens: 4000 });
    const c = m.captured[0]!;
    expect(c.headers.authorization).toBe("Bearer sk-test-123456");
    expect(c.json).toMatchObject({ model: "gpt-image-2.6-flare", prompt: "달빛 아래 성", n: 2, size: "1536x1024", quality: "high", output_format: "png" });
    expect(c.json).not.toHaveProperty("response_format");
  });

  it("ChatGPT lane: Codex backend images/generations with gpt-image-2 + account header; 401 → refresh once → replay", async () => {
    let calls = 0;
    m.on("POST /codex/images/generations", (c, res) => {
      calls++;
      if (c.headers.authorization === "Bearer old-access") return json(res, 401, { error: { message: "expired" } });
      json(res, 200, { data: [{ b64_json: PNG_B64 }] });
    });
    let refreshed = 0;
    const cred: LlmCredential = {
      method: "chatgpt_oauth",
      token: "old-access",
      headers: { "chatgpt-account-id": "acct_1" },
      refresh: async () => {
        refreshed++;
        return { method: "chatgpt_oauth", token: "new-access", headers: { "chatgpt-account-id": "acct_1" } };
      },
    };
    const a = new OpenAiImageAdapter({ apiBaseUrl: m.base, codexBaseUrl: `${m.base}/codex` });
    const r = await a.generate({ ...req, modelId: "gpt-image-2", aspectRatio: "1:1", n: 1 }, opts(cred));
    expect(r.ok).toBe(true);
    expect(calls).toBe(2);
    expect(refreshed).toBe(1);
    const last = m.captured.at(-1)!;
    expect(last.headers["chatgpt-account-id"]).toBe("acct_1");
    expect(last.headers.authorization).toBe("Bearer new-access");
    expect(last.json).toMatchObject({ model: "gpt-image-2", size: "1024x1024", n: 1 });
    expect(last.json).not.toHaveProperty("output_format");
  });

  it("classifies errors: 401 key → auth_failed, 429 quota vs rate, safety 400 → content_filtered, empty data → invalid_output", async () => {
    const a = new OpenAiImageAdapter({ apiBaseUrl: m.base });
    m.on("POST /v1/images/generations", (_c, res) => json(res, 401, { error: { message: "Incorrect API key provided: sk-abc***" } }));
    let r = await a.generate(req, opts(key("sk-bad-123456")));
    expect(r).toMatchObject({ ok: false, errorFamily: "auth_failed", billed: "no" });
    if (!r.ok) expect(r.message).not.toContain("sk-bad");
    m.on("POST /v1/images/generations", (_c, res) => json(res, 429, { error: { message: "You exceeded your current quota, please check your plan and billing details.", code: "insufficient_quota" } }));
    expect(await a.generate(req, opts(key("sk-x-123456")))).toMatchObject({ ok: false, errorFamily: "quota_exhausted" });
    m.on("POST /v1/images/generations", (_c, res) => json(res, 429, { error: { message: "Rate limit reached for images per min. Please try again in 7s" } }));
    expect(await a.generate(req, opts(key("sk-x-123456")))).toMatchObject({ ok: false, errorFamily: "rate_limited" });
    m.on("POST /v1/images/generations", (_c, res) => json(res, 400, { error: { message: "Your request was rejected by the safety system.", code: "moderation_blocked" } }));
    expect(await a.generate(req, opts(key("sk-x-123456")))).toMatchObject({ ok: false, errorFamily: "content_filtered" });
    m.on("POST /v1/images/generations", (_c, res) => json(res, 200, { data: [] }));
    expect(await a.generate(req, opts(key("sk-x-123456")))).toMatchObject({ ok: false, errorFamily: "invalid_output" });
  });

  it("times out without retrying the POST", async () => {
    let calls = 0;
    m.on("POST /v1/images/generations", () => {
      calls++; // never answers
    });
    const a = new OpenAiImageAdapter({ apiBaseUrl: m.base });
    const r = await a.generate(req, opts(key("sk-x-123456"), 150));
    expect(r).toMatchObject({ ok: false, errorFamily: "timeout", billed: "unknown" });
    expect(calls).toBe(1);
  });
});

describe("xAI image adapter", () => {
  it("POST /v1/images/generations with b64_json + aspect_ratio + resolution + quality; cost from usd ticks", async () => {
    m.on("POST /v1/images/generations", (_c, res) =>
      json(res, 200, { data: [{ b64_json: PNG_B64, mime_type: "image/png", revised_prompt: "a castle under the moon" }], usage: { cost_in_usd_ticks: 600_000_000 } }),
    );
    const a = new XaiImageAdapter({ apiBaseUrl: m.base });
    const r = await a.generate({ modelId: "grok-imagine-image-2.0", prompt: "성", n: 1, aspectRatio: "16:9", resolution: "2k", quality: "low" }, opts(key("xai-key-123456")));
    expect(r).toMatchObject({ ok: true, reportedCostMicros: 60_000 });
    expect(m.captured[0]!.json).toEqual({ model: "grok-imagine-image-2.0", prompt: "성", n: 1, response_format: "b64_json", aspect_ratio: "16:9", resolution: "2k", quality: "low" });
  });

  it("does not send quality to grok-imagine-image; OAuth 403 → auth_failed with the API-key hint; untrusted url ignored", async () => {
    m.on("POST /v1/images/generations", (_c, res) => json(res, 403, { error: "OAuth tokens are not allowed for this endpoint" }));
    const a = new XaiImageAdapter({ apiBaseUrl: m.base });
    const r = await a.generate({ modelId: "grok-imagine-image", prompt: "x", n: 1, aspectRatio: "1:1", resolution: "1k", quality: "low" }, opts({ method: "xai_oauth", token: "oauth-tok" }));
    expect(r).toMatchObject({ ok: false, errorFamily: "auth_failed" });
    if (!r.ok) expect(r.message).toContain("API 키로 연결");
    expect(m.captured[0]!.json).not.toHaveProperty("quality");
    m.on("POST /v1/images/generations", (_c, res) => json(res, 200, { data: [{ url: "http://169.254.169.254/latest" }] }));
    expect(await a.generate({ modelId: "grok-imagine-image", prompt: "x", n: 1, aspectRatio: "1:1", resolution: "1k" }, opts(key("xai-k-123456")))).toMatchObject({
      ok: false,
      errorFamily: "invalid_output",
    });
    expect(m.captured.filter((c) => c.path.includes("latest"))).toHaveLength(0);
  });
});

describe("Gemini image adapter", () => {
  it("Interactions API: x-goog-api-key, Api-Revision, response_format image; loops n times; reads steps[].content image", async () => {
    let i = 0;
    m.on("POST /v1beta/interactions", (_c, res) => {
      i++;
      if (i === 1) return json(res, 200, { output_image: { data: PNG_B64, mime_type: "image/png" }, output_text: "여기 있습니다" });
      json(res, 200, { steps: [{ type: "thought", content: [] }, { type: "model_output", content: [{ type: "text", text: "두 번째" }, { type: "image", data: PNG_B64 }] }] });
    });
    const a = new GeminiImageAdapter({ apiBaseUrl: m.base });
    const r = await a.generate({ modelId: "gemini-nano-banana-2.1", prompt: "성", n: 2, aspectRatio: "16:9", resolution: "2k" }, opts(key("AIzaTestKey123456")));
    expect(r).toMatchObject({ ok: true, text: "여기 있습니다" });
    if (r.ok) expect(r.images.map((x) => x.mimeType)).toEqual(["image/png", "image/png"]);
    const c = m.captured[0]!;
    expect(c.headers["x-goog-api-key"]).toBe("AIzaTestKey123456");
    expect(c.headers["api-revision"]).toBe("2026-05-20");
    expect(c.headers.authorization).toBeUndefined();
    expect(c.json).toEqual({
      model: "gemini-nano-banana-2.1",
      input: [{ type: "text", text: "성" }],
      response_format: { type: "image", mime_type: "image/png", aspect_ratio: "16:9", image_size: "2K" },
      store: false,
    });
    expect(m.captured).toHaveLength(2);
  });

  it("falls back to generateContent when Interactions is 404; SAFETY → content_filtered; bad key 400 → auth_failed", async () => {
    m.on("POST /v1beta/models/gemini-3-pro-image:generateContent", (_c, res) =>
      json(res, 200, { candidates: [{ content: { parts: [{ text: "생각", thought: true }, { inlineData: { mimeType: "image/png", data: PNG_B64 } }] } }] }),
    );
    const a = new GeminiImageAdapter({ apiBaseUrl: m.base });
    const r = await a.generate({ modelId: "gemini-3-pro-image", prompt: "성", n: 1, aspectRatio: "1:1", resolution: "1k" }, opts(key("AIzaK123456")));
    expect(r.ok).toBe(true);
    expect(m.captured.map((c) => c.path)).toEqual(["/v1beta/interactions", "/v1beta/models/gemini-3-pro-image:generateContent"]);
    expect(m.captured[1]!.json.generationConfig).toEqual({ responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "1:1", imageSize: "1K" } });

    m.on("POST /v1beta/models/gemini-3-pro-image:generateContent", (_c, res) => json(res, 200, { candidates: [{ finishReason: "IMAGE_SAFETY", content: { parts: [] } }] }));
    expect(await a.generate({ modelId: "gemini-3-pro-image", prompt: "x", n: 1, aspectRatio: "1:1", resolution: "1k" }, opts(key("AIzaK123456")))).toMatchObject({
      ok: false,
      errorFamily: "content_filtered",
    });

    const b = new GeminiImageAdapter({ apiBaseUrl: m.base });
    m.on("POST /v1beta/interactions", (_c, res) => json(res, 400, { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } }));
    expect(await b.generate({ modelId: "gemini-nano-banana-2.1", prompt: "x", n: 1, aspectRatio: "1:1", resolution: "1k" }, opts(key("AIzaBad123456")))).toMatchObject({
      ok: false,
      errorFamily: "auth_failed",
    });
  });

  it("returns the images made so far when a later loop step fails (partialFailure)", async () => {
    let i = 0;
    m.on("POST /v1beta/interactions", (_c, res) => {
      i++;
      if (i === 1) return json(res, 200, { output_image: { data: PNG_B64 } });
      json(res, 429, { error: { message: "Resource has been exhausted (e.g. check quota). per minute", status: "RESOURCE_EXHAUSTED" } });
    });
    const a = new GeminiImageAdapter({ apiBaseUrl: m.base });
    const r = await a.generate({ modelId: "gemini-nano-banana-2.1", prompt: "x", n: 3, aspectRatio: "1:1", resolution: "1k" }, opts(key("AIzaK123456")));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.images).toHaveLength(1);
      expect(r.partialFailure).toContain("3장 중 1장");
    }
  });
});
