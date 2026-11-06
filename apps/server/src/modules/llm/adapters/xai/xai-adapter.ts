/**
 * Grok adapter: xAI's OpenAI-compatible Chat Completions (`POST {api}/v1/chat/completions`, streamed SSE with
 * `stream_options.include_usage`). The bearer is an xAI API key or an xAI OAuth access token (same upstream —
 * ima2-gen lib/grokRuntime.ts); a 401 on the OAuth lane refreshes once and replays.
 * JSON: `response_format: {type:"json_schema", json_schema:{name, schema, strict}}` (docs.x.ai structured outputs);
 * a 400 on the format retries once with the schema described in the prompt. zod validation stays in the gateway.
 * Web search (설계 추가 0011): not supported on this Chat Completions lane → `webSearchSupport` says why; the call runs
 * without search.
 */
import type { LlmAdapter, LlmCapabilities, LlmCredential, LlmEnvironmentCheck, LlmInvokeOptions, LlmRequest, LlmResult, LlmUsage } from "../../index.js";
import { StreamError, credentialOf, fetchWithCredential, httpFailure, jsonInstruction, linkedSignal, parseJsonText, readSse, tapProgress, thrownFailure, trimSlash, type FailureCopy } from "../shared/http.js";
import { jsonSchemaFormat } from "../shared/json-schema.js";
import { BAD_KEY_HINT } from "../../domain/errors.js";

export const XAI_API_BASE_URL = "https://api.x.ai";

const copyFor = (oauth: boolean): FailureCopy => ({
  vendor: "xAI API",
  auth: oauth
    ? "xAI 로그인이 만료되었거나 이 계정으로는 API를 쓸 수 없습니다(403이면 구독 등급 제한일 수 있습니다). 다시 로그인하거나 xAI API 키를 쓰세요."
    : "xAI API 키가 올바르지 않거나 권한이 없습니다. 설정 → AI 계정 연결에서 키를 확인하세요.",
  quota: "xAI 계정의 크레딧 또는 사용 한도가 소진되었습니다.",
  rate: "xAI API 요청 한도를 넘었습니다. 잠시 후 다시 시도합니다.",
  unavailable: "xAI API에 일시적인 문제가 있습니다.",
});

type Body = Record<string, unknown>;

export function buildChatBody(req: LlmRequest, withFormat: boolean): Body {
  const obj = req.output.kind === "object" ? req.output : null;
  const system = req.system + (obj && !withFormat ? jsonInstruction(obj.jsonSchema) : "");
  const body: Body = {
    model: req.modelId,
    messages: [{ role: "system", content: system }, ...req.messages.map((m) => ({ role: m.role, content: m.content }))],
    max_tokens: req.maxOutputTokens,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (obj && withFormat) {
    const f = jsonSchemaFormat(obj.schemaName, obj.jsonSchema);
    body.response_format = { type: "json_schema", json_schema: { name: f.name, schema: f.schema, strict: f.strict } };
  }
  return body;
}

function mapUsage(u: unknown): LlmUsage {
  const o = (u && typeof u === "object" ? u : {}) as {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  const input = o.prompt_tokens ?? 0;
  let output = o.completion_tokens ?? 0;
  // reasoning tokens are billed as output; some responses report them outside completion_tokens
  if (typeof o.total_tokens === "number" && o.total_tokens > input + output) output = o.total_tokens - input;
  return { inputTokens: input, outputTokens: output, cachedInputTokens: o.prompt_tokens_details?.cached_tokens || undefined, reasoningTokens: o.completion_tokens_details?.reasoning_tokens };
}

export async function collectChatStream(body: ReadableStream<Uint8Array> | null): Promise<{ text: string; finish: string | null; usage: LlmUsage; id?: string; model?: string; refusal: string }> {
  let text = "";
  let refusal = "";
  let finish: string | null = null;
  let usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
  let id: string | undefined;
  let model: string | undefined;
  await readSse(body, (d) => {
    const c = d as { id?: string; model?: string; error?: { message?: string } | string; choices?: Array<{ delta?: { content?: unknown; refusal?: unknown }; finish_reason?: string | null }>; usage?: unknown };
    if (c.error) throw new StreamError(typeof c.error === "string" ? c.error : (c.error.message ?? "error"));
    id ??= c.id;
    model ??= c.model;
    for (const ch of c.choices ?? []) {
      if (typeof ch.delta?.content === "string") text += ch.delta.content;
      if (typeof ch.delta?.refusal === "string") refusal += ch.delta.refusal;
      if (ch.finish_reason) finish = ch.finish_reason;
    }
    if (c.usage) usage = mapUsage(c.usage);
  });
  return { text, finish, usage, id, model, refusal };
}

export class XaiLlmAdapter implements LlmAdapter {
  readonly provider = "xai";
  private readonly api: string;

  constructor(opts: { apiBaseUrl?: string } = {}) {
    this.api = trimSlash(opts.apiBaseUrl ?? XAI_API_BASE_URL);
  }

  /** 설계 추가 0011: Chat Completions has no current search tool (Live Search was retired for the Agent Tools API) */
  webSearchSupport(): string {
    return "Grok(xAI) 연결은 인터넷 검색을 아직 지원하지 않아 검색 없이 진행합니다.";
  }

  capabilities(_modelId: string): LlmCapabilities {
    return { structuredOutput: "json_schema", maxContextTokens: 500_000, maxOutputTokens: 128_000, promptCaching: true, reportsUsage: true, reportsCost: false, outputLimitCoversReasoning: "unknown" };
  }

  async testEnvironment(input: { apiKey: string; credential?: LlmCredential; modelId?: string; signal: AbortSignal }): Promise<LlmEnvironmentCheck> {
    const cred = credentialOf(input);
    if (!cred.token) return { status: "fail", errorFamily: "auth_failed", message: "Grok 연결이 없습니다. 설정 → AI 계정 연결에서 xAI API 키를 등록하거나 로그인하세요." };
    const copy = copyFor(cred.method === "xai_oauth");
    try {
      const res = await fetchWithCredential(`${this.api}/v1/models`, { method: "GET", signal: input.signal }, cred);
      if (!res.ok) {
        const f = await httpFailure(res, copy);
        if (f.errorFamily === "rate_limited") return { status: "warn", errorFamily: f.errorFamily, message: "요청 한도에 걸려 점검을 끝내지 못했습니다. 잠시 후 다시 확인하세요." };
        return { status: "fail", errorFamily: f.errorFamily, message: f.message };
      }
      const j = (await res.json().catch(() => ({}))) as { data?: Array<{ id?: string }> };
      const ids = (j.data ?? []).map((m) => m.id);
      if (input.modelId && ids.length && !ids.includes(input.modelId)) return { status: "warn", message: `xAI API 연결은 확인했지만 모델 ${input.modelId}을(를) 찾을 수 없습니다.` };
      return { status: "pass", message: input.modelId ? `xAI API 연결과 모델(${input.modelId}) 확인을 마쳤습니다.` : "xAI API 연결을 확인했습니다." };
    } catch (err) {
      const f = thrownFailure(err, false, "xAI API");
      return { status: "fail", errorFamily: f.errorFamily, message: f.message };
    }
  }

  async invoke(req: LlmRequest, opts: LlmInvokeOptions): Promise<LlmResult> {
    const cred = credentialOf(opts);
    const copy = copyFor(cred.method === "xai_oauth");
    const link = linkedSignal(opts.signal, opts.timeoutMs);
    try {
      let withFormat = req.output.kind === "object";
      for (let attempt = 0; ; attempt++) {
        const res = await fetchWithCredential(
          `${this.api}/v1/chat/completions`,
          { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify(buildChatBody(req, withFormat)), signal: link.signal },
          cred,
        );
        if (!res.ok) {
          const peek = res.status === 400 ? await res.clone().text().catch(() => "") : "";
          if (res.status === 400 && withFormat && attempt === 0 && !BAD_KEY_HINT.test(peek) && !/quota|credit|billing/i.test(peek)) {
            await res.body?.cancel().catch(() => {});
            withFormat = false;
            continue;
          }
          return await httpFailure(res, copy);
        }
        const c = await collectChatStream(tapProgress(res.body, opts.onProgress));
        const finishReason = c.finish === "stop" ? "stop" : c.finish === "length" ? "length" : c.finish === "content_filter" ? "content_filter" : c.finish ? "other" : "stop";
        if (finishReason === "content_filter" || (c.refusal && !c.text)) {
          return { ok: false, errorFamily: "content_filtered", message: "Grok이 안전 정책으로 응답을 거절했습니다.", billed: "yes", usage: c.usage, providerRequestId: c.id };
        }
        const common = { finishReason, usage: c.usage, modelVersion: c.model, providerRequestId: c.id, raw: { finish: c.finish, structured: withFormat } } as const;
        if (req.output.kind === "object") {
          const object = parseJsonText(c.text);
          return { ok: true, object, text: object === undefined ? c.text : undefined, ...common };
        }
        return { ok: true, text: c.text, ...common };
      }
    } catch (err) {
      return thrownFailure(err, link.timedOut(), "xAI API");
    } finally {
      link.dispose();
    }
  }
}
