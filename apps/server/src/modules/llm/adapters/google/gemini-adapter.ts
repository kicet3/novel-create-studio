/**
 * Gemini adapter: Gemini API `models/{m}:streamGenerateContent?alt=sse` with `x-goog-api-key` (Google AI Studio key).
 * generateContent is "legacy but fully supported" (aistudio.google.com/docs/interactions) and needs no server-side
 * storage opt-out, unlike the Interactions API (stores by default).
 * JSON: `generationConfig.responseMimeType=application/json` + `responseJsonSchema` (a JSON Schema subset; length
 * keywords are ignored by Gemini → zod validation + repair retries in the gateway stay). A 400 on the schema retries
 * once with the schema described in the prompt (JSON mime type kept).
 * Thought parts (`thought: true`) are skipped; thinking tokens are billed as output.
 * Web search (설계 추가 0011): grounding with Google Search (`tools: [{google_search: {}}]`); sources =
 * `groundingMetadata.groundingChunks[].web`, searches = `webSearchQueries` (no per-call cap parameter: the cap is in
 * the system prompt).
 */
import type { LlmAdapter, LlmCapabilities, LlmCitation, LlmCredential, LlmEnvironmentCheck, LlmInvokeOptions, LlmRequest, LlmResult, LlmUsage } from "../../index.js";
import { StreamError, credentialOf, fetchWithCredential, httpFailure, jsonInstruction, linkedSignal, parseJsonText, readSse, tapProgress, thrownFailure, trimSlash, type FailureCopy } from "../shared/http.js";

export const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com";

const COPY: FailureCopy = {
  vendor: "Gemini API",
  auth: "Gemini API 키가 올바르지 않거나 권한이 없습니다. 설정 → AI 계정 연결에서 키를 확인하세요.",
  quota: "Gemini API 사용 한도 또는 결제 한도가 소진되었습니다.",
  rate: "Gemini API 요청 한도를 넘었습니다. 잠시 후 다시 시도합니다.",
  unavailable: "Gemini API에 일시적인 문제가 있습니다.",
};

const authHeader = (c: LlmCredential) => ({ "x-goog-api-key": c.token });
const BLOCKED = new Set(["SAFETY", "RECITATION", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "IMAGE_SAFETY"]);

type Body = Record<string, unknown>;

export function buildGenerateBody(req: LlmRequest, withSchema: boolean): Body {
  const obj = req.output.kind === "object" ? req.output : null;
  const system = req.system + (obj && !withSchema ? jsonInstruction(obj.jsonSchema) : "");
  const generationConfig: Body = { maxOutputTokens: req.maxOutputTokens };
  if (obj) {
    generationConfig.responseMimeType = "application/json";
    if (withSchema) generationConfig.responseJsonSchema = obj.jsonSchema;
  }
  return {
    systemInstruction: { parts: [{ text: system }] },
    contents: req.messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
    generationConfig,
    ...(req.webSearch ? { tools: [{ google_search: {} }] } : {}),
  };
}

function mapUsage(u: unknown): LlmUsage {
  const o = (u && typeof u === "object" ? u : {}) as { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number; thoughtsTokenCount?: number };
  return {
    inputTokens: o.promptTokenCount ?? 0,
    outputTokens: (o.candidatesTokenCount ?? 0) + (o.thoughtsTokenCount ?? 0),
    cachedInputTokens: o.cachedContentTokenCount || undefined,
    reasoningTokens: o.thoughtsTokenCount,
  };
}

export async function collectGeminiStream(body: ReadableStream<Uint8Array> | null) {
  let text = "";
  let finish: string | null = null;
  let blockReason: string | null = null;
  let usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
  let model: string | undefined;
  let id: string | undefined;
  const queries: string[] = [];
  const sources: Array<{ url: string; title: string | null }> = [];
  await readSse(body, (d) => {
    const c = d as {
      error?: { message?: string; status?: string };
      candidates?: Array<{
        content?: { parts?: Array<{ text?: unknown; thought?: boolean }> };
        finishReason?: string;
        groundingMetadata?: { webSearchQueries?: unknown[]; groundingChunks?: Array<{ web?: { uri?: unknown; title?: unknown } }> };
      }>;
      usageMetadata?: unknown;
      modelVersion?: string;
      responseId?: string;
      promptFeedback?: { blockReason?: string };
    };
    if (c.error) throw new StreamError(c.error.message ?? c.error.status ?? "error");
    for (const cand of c.candidates ?? []) {
      for (const p of cand.content?.parts ?? []) if (!p.thought && typeof p.text === "string") text += p.text;
      if (cand.finishReason) finish = cand.finishReason;
      const g = cand.groundingMetadata;
      for (const q of g?.webSearchQueries ?? []) if (typeof q === "string" && !queries.includes(q)) queries.push(q.slice(0, 200));
      for (const ch of g?.groundingChunks ?? []) {
        const u = ch.web?.uri;
        if (typeof u === "string" && !sources.some((x) => x.url === u)) sources.push({ url: u, title: typeof ch.web?.title === "string" ? ch.web.title : null });
      }
    }
    if (c.promptFeedback?.blockReason) blockReason = c.promptFeedback.blockReason;
    if (c.usageMetadata) usage = mapUsage(c.usageMetadata);
    model = c.modelVersion ?? model;
    id = c.responseId ?? id;
  });
  return { text, finish, blockReason, usage, model, id, queries, sources };
}

/** Gemini answers an invalid key with 400 INVALID_ARGUMENT "API key not valid" */
async function geminiFailure(res: Response) {
  const peek = await res
    .clone()
    .text()
    .catch(() => "");
  if (res.status === 400 && /API[_ ]key[_ ]not[_ ]valid|API_KEY_INVALID|API key expired/i.test(peek)) {
    await res.body?.cancel().catch(() => {});
    return { ok: false as const, errorFamily: "auth_failed" as const, message: COPY.auth, httpStatus: 400, billed: "no" as const };
  }
  return httpFailure(res, COPY);
}

export class GeminiLlmAdapter implements LlmAdapter {
  readonly provider = "google";
  private readonly api: string;

  constructor(opts: { apiBaseUrl?: string } = {}) {
    this.api = trimSlash(opts.apiBaseUrl ?? GEMINI_API_BASE_URL);
  }

  webSearchSupport(): true {
    return true;
  }

  capabilities(_modelId: string): LlmCapabilities {
    return { structuredOutput: "json_schema", maxContextTokens: 1_000_000, maxOutputTokens: 65_536, promptCaching: true, reportsUsage: true, reportsCost: false, outputLimitCoversReasoning: true };
  }

  async testEnvironment(input: { apiKey: string; credential?: LlmCredential; modelId?: string; signal: AbortSignal }): Promise<LlmEnvironmentCheck> {
    const cred = credentialOf(input);
    if (!cred.token) return { status: "fail", errorFamily: "auth_failed", message: "Gemini 연결이 없습니다. 설정 → AI 계정 연결에서 Gemini API 키를 등록하세요." };
    const url = input.modelId ? `${this.api}/v1beta/models/${encodeURIComponent(input.modelId)}` : `${this.api}/v1beta/models?pageSize=1`;
    try {
      const res = await fetchWithCredential(url, { method: "GET", signal: input.signal }, cred, authHeader);
      if (res.status === 404 && input.modelId) return { status: "warn", message: `Gemini API 연결은 확인했지만 모델 ${input.modelId}을(를) 찾을 수 없습니다.` };
      if (!res.ok) {
        const f = await geminiFailure(res);
        if (f.errorFamily === "rate_limited") return { status: "warn", errorFamily: f.errorFamily, message: "요청 한도에 걸려 점검을 끝내지 못했습니다. 잠시 후 다시 확인하세요." };
        return { status: "fail", errorFamily: f.errorFamily, message: f.message };
      }
      await res.body?.cancel().catch(() => {});
      return { status: "pass", message: input.modelId ? `Gemini API 연결과 모델(${input.modelId}) 확인을 마쳤습니다.` : "Gemini API 연결을 확인했습니다." };
    } catch (err) {
      const f = thrownFailure(err, false, "Gemini API");
      return { status: "fail", errorFamily: f.errorFamily, message: f.message };
    }
  }

  async invoke(req: LlmRequest, opts: LlmInvokeOptions): Promise<LlmResult> {
    const cred = credentialOf(opts);
    const link = linkedSignal(opts.signal, opts.timeoutMs);
    try {
      let withSchema = req.output.kind === "object";
      for (let attempt = 0; ; attempt++) {
        const res = await fetchWithCredential(
          `${this.api}/v1beta/models/${encodeURIComponent(req.modelId)}:streamGenerateContent?alt=sse`,
          { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify(buildGenerateBody(req, withSchema)), signal: link.signal },
          cred,
          authHeader,
        );
        if (!res.ok) {
          const peek = res.status === 400 ? await res.clone().text().catch(() => "") : "";
          if (res.status === 400 && withSchema && attempt === 0 && !/API[_ ]key/i.test(peek)) {
            await res.body?.cancel().catch(() => {});
            withSchema = false;
            continue;
          }
          return await geminiFailure(res);
        }
        const c = await collectGeminiStream(tapProgress(res.body, opts.onProgress));
        if (c.blockReason || (c.finish && BLOCKED.has(c.finish))) {
          return { ok: false, errorFamily: "content_filtered", message: `Gemini가 안전 정책으로 응답을 거절했습니다 (${c.blockReason ?? c.finish}).`, billed: c.blockReason ? "no" : "yes", usage: c.usage, providerRequestId: c.id };
        }
        const finishReason = !c.finish || c.finish === "STOP" ? "stop" : c.finish === "MAX_TOKENS" ? "length" : "other";
        const now = new Date().toISOString();
        const webSearch = req.webSearch
          ? {
              status: c.queries.length ? ("used" as const) : ("not_used" as const),
              citationsKind: "cited" as const,
              requests: c.queries.length,
              citations: c.sources.slice(0, 12).map((x): LlmCitation => ({ ...x, retrievedAt: now })),
              ...(c.queries.length ? { queries: c.queries } : {}),
            }
          : undefined;
        const usage = webSearch ? { ...c.usage, webSearchRequests: webSearch.requests } : c.usage;
        const common = { finishReason, usage, modelVersion: c.model, providerRequestId: c.id, ...(webSearch ? { webSearch } : {}), raw: { finish: c.finish, structured: withSchema } } as const;
        if (req.output.kind === "object") {
          const object = parseJsonText(c.text);
          return { ok: true, object, text: object === undefined ? c.text : undefined, ...common };
        }
        return { ok: true, text: c.text, ...common };
      }
    } catch (err) {
      return thrownFailure(err, link.timedOut(), "Gemini API");
    } finally {
      link.dispose();
    }
  }
}
