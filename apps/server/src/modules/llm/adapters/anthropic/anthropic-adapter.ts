/**
 * Claude API adapter over the official Anthropic TypeScript SDK (`@anthropic-ai/sdk`) — 04 §10.1.
 * Vendor confinement (08 §3.2): this directory is the only place that imports the SDK.
 *
 * Request shape (claude-*-5-5):
 * - streamed (`messages.stream` → `finalMessage()`) so long Korean drafts never hit HTTP timeouts;
 * - adaptive thinking is the model default and counts toward `max_tokens`; sampling params
 *   (temperature/top_p/top_k) are never sent (rejected on current models);
 * - JSON outputs via `output_config.format` (json_schema) when the schema is representable in strict
 *   structured outputs, otherwise the schema is given in the system prompt and the gateway validates
 *   (zod) and repairs — records / `unknown` values cannot be expressed with `additionalProperties:false`;
 * - prompt caching: the system prompt is a cache breakpoint, plus any message marked `cacheBoundary`;
 * - server-side refusal fallback (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`) on
 *   Opus 5.5 / Sonnet 5.5: a safety decline is retried on the fallback model inside the same call.
 * - web search (설계 추가 0011, `req.webSearch`): server tool `web_search_20260209` (dynamic filtering; Opus 5.5/5/4.8/
 *   4.7/4.6, Sonnet 5.5/5/4.6, Fable) or `web_search_20250305` (other models) with `max_uses`. A searching call with an
 *   object output uses prompt-described JSON (citations and strict `output_config.format` are not combined), and the
 *   JSON is read from the text after the last search result. `pause_turn` (server loop limit) is resumed by sending
 *   the paused assistant content back (at most PAUSE_RESUMES times). Sources = cited `web_search_result_location`s,
 *   else the result list; searches = `usage.server_tool_use.web_search_requests` (billed per search by the gateway).
 */
import Anthropic from "@anthropic-ai/sdk";
import { transformJSONSchema } from "@anthropic-ai/sdk/lib/transform-json-schema";
import type { LlmAdapter, LlmCapabilities, LlmCitation, LlmCredential, LlmEnvironmentCheck, LlmInvokeOptions, LlmRequest, LlmResult, LlmUsage, LlmWebSearchResult } from "../../index.js";
import { classifyHttpError } from "../../domain/errors.js";
import { MODEL_LIMITS } from "../../domain/pricing.js";
import { createStreamRelay } from "../shared/stream-relay.js";

/** models that accept the server-side refusal fallback ("default" form) on the Claude API */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-5", "claude-fable-5-1"]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

type JsonSchema = Record<string, unknown>;

/** models with the dynamic-filtering web search tool version (claude-api reference, cached 2026-10-06) */
const DYNAMIC_SEARCH_MODEL = /^claude-(opus-(5|4-[678])|sonnet-(5|4-6)|fable)(-|$)/;
/** `pause_turn` continuations of one searching call */
const PAUSE_RESUMES = 3;

export function webSearchToolFor(modelId: string, maxUses: number): Anthropic.Beta.BetaToolUnion {
  return DYNAMIC_SEARCH_MODEL.test(modelId)
    ? { type: "web_search_20260209", name: "web_search", max_uses: maxUses }
    : { type: "web_search_20250305", name: "web_search", max_uses: maxUses };
}

/** sources, query list and search count of a (possibly resumed) searching call */
export function webSearchOf(blocks: readonly Anthropic.Beta.BetaContentBlock[], searches: number, retrievedAt: string): LlmWebSearchResult {
  const cited: LlmCitation[] = [];
  const listed: LlmCitation[] = [];
  const queries: string[] = [];
  for (const b of blocks) {
    if (b.type === "text") {
      for (const c of (b as Anthropic.Beta.BetaTextBlock).citations ?? []) {
        if (c.type === "web_search_result_location") cited.push({ url: c.url, title: c.title ?? null, retrievedAt });
      }
    } else if (b.type === "server_tool_use" && b.name === "web_search") {
      const q = (b.input as { query?: unknown }).query;
      if (typeof q === "string") queries.push(q.slice(0, 200));
    } else if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
      for (const r of b.content) if (r.type === "web_search_result") listed.push({ url: r.url, title: r.title ?? null, retrievedAt });
    }
  }
  const seen = new Set<string>();
  const citations = (cited.length ? cited : listed.slice(0, 8)).filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)));
  const requests = Math.max(searches, queries.length);
  return { status: requests > 0 ? "used" : "not_used", requests, citations, citationsKind: cited.length ? "cited" : "results", ...(queries.length ? { queries } : {}) };
}

/** text written after the last search result (the answer; earlier text is preamble like "검색해 보겠습니다") */
function textAfterLastSearch(blocks: readonly Anthropic.Beta.BetaContentBlock[]): string {
  let start = 0;
  blocks.forEach((b, i) => {
    if (b.type === "web_search_tool_result" || b.type === "server_tool_use") start = i + 1;
  });
  return blocks
    .slice(start)
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * Strict structured outputs need every object closed (`additionalProperties:false`) and every node typed.
 * Records (`additionalProperties: {schema}`) and untyped nodes (`z.unknown()` → `{}`) are not
 * representable → the caller falls back to prompt-described JSON.
 */
export function isStrictRepresentable(node: unknown, depth = 0): boolean {
  if (depth > 40 || !node || typeof node !== "object") return false;
  const s = node as JsonSchema;
  if (s.$ref) return true;
  const variants = (s.anyOf ?? s.oneOf ?? s.allOf) as unknown[] | undefined;
  if (Array.isArray(variants)) return variants.every((v) => isStrictRepresentable(v, depth + 1));
  const type = s.type;
  if (type === undefined) return "const" in s || Array.isArray(s.enum);
  if (Array.isArray(type)) return type.every((t) => typeof t === "string");
  if (type === "object") {
    const ap = s.additionalProperties;
    const props = (s.properties ?? {}) as Record<string, unknown>;
    if (ap && typeof ap === "object" && Object.keys(ap as object).length > 0) return false;
    if (ap === true || (ap && typeof ap === "object" && !Object.keys(props).length)) return false;
    if (!Object.keys(props).length && ap !== false) return false;
    return Object.values(props).every((p) => isStrictRepresentable(p, depth + 1));
  }
  if (type === "array") return s.items === undefined || isStrictRepresentable(s.items, depth + 1);
  return true;
}

export function buildOutputFormat(jsonSchema: JsonSchema): { strict: true; format: Anthropic.JSONOutputFormat } | { strict: false; instruction: string } {
  if (jsonSchema.type === "object" && isStrictRepresentable(jsonSchema)) {
    try {
      return { strict: true, format: { type: "json_schema", schema: transformJSONSchema(jsonSchema as never) as JsonSchema } };
    } catch {
      /* fall through to prompt-described JSON */
    }
  }
  return {
    strict: false,
    instruction: `\n\n## 출력 형식\n설명이나 코드 블록 없이 아래 JSON Schema를 따르는 JSON 객체 하나만 출력하세요.\n${JSON.stringify(jsonSchema)}`,
  };
}

/** text of the final message (thinking / fallback / other blocks skipped) */
function messageText(m: Anthropic.Beta.BetaMessage): string {
  return m.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** model JSON as text → object; tolerates a ```json fence around it */
export function parseJsonText(text: string): unknown {
  const t = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  const body = fenced ? fenced[1]! : t;
  try {
    return JSON.parse(body);
  } catch {
    const a = body.indexOf("{");
    const b = body.lastIndexOf("}");
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(body.slice(a, b + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function mapStop(r: string | null | undefined): "stop" | "length" | "content_filter" | "other" {
  if (r === "end_turn" || r === "stop_sequence") return "stop";
  if (r === "max_tokens" || r === "model_context_window_exceeded") return "length";
  if (r === "refusal") return "content_filter";
  return "other";
}

function mapUsage(u: Anthropic.Beta.BetaUsage | undefined): LlmUsage {
  const cacheRead = u?.cache_read_input_tokens ?? 0;
  const cacheWrite = u?.cache_creation_input_tokens ?? 0;
  return {
    // input_tokens excludes cached tokens; the ledger prices cache reads separately (cachedInputTokens)
    inputTokens: (u?.input_tokens ?? 0) + cacheRead + cacheWrite,
    outputTokens: u?.output_tokens ?? 0,
    cachedInputTokens: cacheRead || undefined,
    reasoningTokens: (u as { output_tokens_details?: { thinking_tokens?: number } } | undefined)?.output_tokens_details?.thinking_tokens,
  };
}

function retryAfter(headers: Headers | undefined): Date | undefined {
  const ra = headers?.get?.("retry-after");
  return ra && !Number.isNaN(Number(ra)) ? new Date(Date.now() + Number(ra) * 1000) : undefined;
}

export function classifyAnthropicError(err: unknown, signal: AbortSignal, timedOut: boolean): Extract<LlmResult, { ok: false }> {
  if (timedOut || err instanceof Anthropic.APIConnectionTimeoutError || err instanceof Anthropic.APIUserAbortError || (signal.aborted && !(err instanceof Anthropic.APIError))) {
    return { ok: false, errorFamily: "timeout", message: "LLM 응답 시간이 초과되었거나 호출이 중단되었습니다.", billed: "unknown" };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return { ok: false, errorFamily: "provider_unavailable", message: "Anthropic 서버에 연결할 수 없습니다. 네트워크를 확인하세요.", billed: "unknown" };
  }
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    const family =
      err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError
        ? "auth_failed"
        : err instanceof Anthropic.RateLimitError
          ? "rate_limited"
          : classifyHttpError(status, err.message);
    const message =
      family === "auth_failed"
        ? "Anthropic API 키가 올바르지 않거나 권한이 없습니다. 설정에서 키를 확인하세요."
        : family === "quota_exhausted"
          ? "Anthropic 계정의 크레딧 또는 사용 한도가 소진되었습니다."
          : family === "rate_limited"
            ? "Claude API 요청 한도를 넘었습니다. 잠시 후 다시 시도합니다."
            : family === "provider_unavailable"
              ? "Claude API에 일시적인 문제가 있습니다."
              : `Claude API가 요청을 거부했습니다 (HTTP ${status ?? "?"}): ${err.message}`.slice(0, 500);
    return {
      ok: false,
      errorFamily: family,
      message,
      httpStatus: status,
      retryNotBefore: retryAfter(err.headers),
      billed: family === "provider_unavailable" ? "unknown" : "no",
      providerRequestId: err.requestID ?? undefined,
    };
  }
  return { ok: false, errorFamily: "internal", message: `Claude API 호출 중 오류: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500), billed: "unknown" };
}

export class AnthropicLlmAdapter implements LlmAdapter {
  readonly provider = "anthropic";

  constructor(private readonly opts: { baseURL?: string } = {}) {}

  private client(apiKey: string, timeoutMs?: number): Anthropic {
    // retries are owned by the gateway (budget reservation + ledger per attempt)
    return new Anthropic({ apiKey, baseURL: this.opts.baseURL, maxRetries: 0, timeout: timeoutMs });
  }

  capabilities(modelId: string): LlmCapabilities {
    const lim = MODEL_LIMITS[modelId] ?? { maxOutputTokens: 64_000, maxContextTokens: 200_000 };
    return {
      structuredOutput: "json_schema",
      maxContextTokens: lim.maxContextTokens,
      maxOutputTokens: lim.maxOutputTokens,
      promptCaching: true,
      reportsUsage: true,
      reportsCost: false,
      outputLimitCoversReasoning: true,
    };
  }

  async testEnvironment(input: { apiKey: string; modelId?: string; signal: AbortSignal }): Promise<LlmEnvironmentCheck> {
    if (!input.apiKey) return { status: "fail", errorFamily: "auth_failed", message: "Anthropic API 키가 등록되지 않았습니다. 설정 → 비밀 값에서 키를 입력하세요." };
    const client = this.client(input.apiKey, 15_000);
    try {
      if (input.modelId) await client.models.retrieve(input.modelId, {}, { signal: input.signal });
      else await client.models.list({ limit: 1 }, { signal: input.signal });
      return { status: "pass", message: input.modelId ? `Claude API 연결과 모델(${input.modelId}) 확인을 마쳤습니다.` : "Claude API 연결을 확인했습니다." };
    } catch (err) {
      if (err instanceof Anthropic.NotFoundError && input.modelId) return { status: "warn", message: `모델 ${input.modelId}을(를) 찾을 수 없습니다. 모델 ID를 확인하세요.` };
      const r = classifyAnthropicError(err, input.signal, false);
      if (r.errorFamily === "rate_limited") return { status: "warn", errorFamily: r.errorFamily, message: "요청 한도에 걸려 점검을 끝내지 못했습니다. 잠시 후 다시 확인하세요." };
      return { status: "fail", errorFamily: r.errorFamily, message: r.message };
    }
  }

  webSearchSupport(_modelId: string, _method?: LlmCredential["method"]): true {
    return true;
  }

  private buildParams(req: LlmRequest): { params: Anthropic.Beta.MessageCreateParamsNonStreaming; strict: boolean } {
    const out0 = req.output.kind === "object" ? buildOutputFormat(req.output.jsonSchema) : null;
    // searching + object output → prompt-described JSON (no strict output_config.format next to web citations)
    const out =
      out0?.strict && req.webSearch && req.output.kind === "object"
        ? { strict: false as const, instruction: `\n\n## 출력 형식\n설명이나 코드 블록 없이 아래 JSON Schema를 따르는 JSON 객체 하나만 출력하세요.\n${JSON.stringify(req.output.jsonSchema)}` }
        : out0;
    const systemText = req.system + (out && !out.strict ? out.instruction : "");
    const messages: Anthropic.Beta.BetaMessageParam[] = req.messages.map((m) =>
      m.cacheBoundary
        ? { role: m.role, content: [{ type: "text", text: m.content, cache_control: { type: "ephemeral" } }] }
        : { role: m.role, content: m.content },
    );
    const fallback = FALLBACK_MODELS.has(req.modelId);
    const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
      model: req.modelId,
      max_tokens: req.maxOutputTokens,
      system: [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }],
      messages,
      ...(out?.strict ? { output_config: { format: out.format } } : {}),
      ...(req.webSearch ? { tools: [webSearchToolFor(req.modelId, req.webSearch.maxUses)] } : {}),
      ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
    };
    return { params, strict: !!out?.strict };
  }

  async countInputTokens(req: LlmRequest, opts: { apiKey: string; signal: AbortSignal }): Promise<number> {
    const { params } = this.buildParams(req);
    const r = await this.client(opts.apiKey, 15_000).messages.countTokens(
      {
        model: params.model,
        system: params.system as Anthropic.TextBlockParam[],
        messages: params.messages as Anthropic.MessageParam[],
        ...(params.output_config ? { output_config: params.output_config as Anthropic.OutputConfig } : {}),
        ...(params.tools ? { tools: params.tools as Anthropic.MessageCountTokensTool[] } : {}),
      },
      { signal: opts.signal },
    );
    return r.input_tokens;
  }

  async invoke(req: LlmRequest, opts: LlmInvokeOptions): Promise<LlmResult> {
    const ac = new AbortController();
    let timedOut = false;
    const onAbort = () => ac.abort();
    if (opts.signal.aborted) ac.abort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, opts.timeoutMs);
    try {
      const { params } = this.buildParams(req);
      const client = this.client(opts.apiKey, opts.timeoutMs);
      // live display only: text deltas (JSON text for object outputs); the result below is still finalMessage()
      const relay = opts.onStream ? createStreamRelay("text", opts.onStream) : null;
      const once = async (p: Anthropic.Beta.MessageCreateParamsNonStreaming) => {
        const stream = client.beta.messages.stream(p, {
          signal: ac.signal,
          headers: opts.idempotencyKey ? { "x-ncs-idempotency-key": opts.idempotencyKey } : undefined,
        });
        if (relay) stream.on("streamEvent", (ev) => relay.push(ev));
        if (opts.onProgress) stream.on("streamEvent", () => opts.onProgress!()); // idle-timeout liveness (gateway)
        return stream.finalMessage();
      };
      let msg = await once(params);
      // web search: the server loop can pause (`pause_turn`) — send the paused content back so it continues
      const blocks: Anthropic.Beta.BetaContentBlock[] = [...msg.content];
      let usage = mapUsage(msg.usage);
      let searches = msg.usage?.server_tool_use?.web_search_requests ?? 0;
      for (let i = 0; req.webSearch && msg.stop_reason === "pause_turn" && i < PAUSE_RESUMES; i++) {
        msg = await once({ ...params, messages: [...params.messages, { role: "assistant", content: blocks as unknown as Anthropic.Beta.BetaContentBlockParam[] }] });
        blocks.push(...msg.content);
        const u = mapUsage(msg.usage);
        usage = {
          inputTokens: usage.inputTokens + u.inputTokens,
          outputTokens: usage.outputTokens + u.outputTokens,
          cachedInputTokens: (usage.cachedInputTokens ?? 0) + (u.cachedInputTokens ?? 0) || undefined,
          reasoningTokens: usage.reasoningTokens !== undefined || u.reasoningTokens !== undefined ? (usage.reasoningTokens ?? 0) + (u.reasoningTokens ?? 0) : undefined,
        };
        searches += msg.usage?.server_tool_use?.web_search_requests ?? 0;
      }
      const webSearch = req.webSearch ? webSearchOf(blocks, searches, new Date().toISOString()) : undefined;
      if (webSearch) usage = { ...usage, webSearchRequests: webSearch.requests };
      const text = req.webSearch ? (req.output.kind === "object" ? textAfterLastSearch(blocks) : blocks.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("")) : messageText(msg);
      const finishReason = msg.stop_reason === "pause_turn" ? "length" : mapStop(msg.stop_reason);
      const common = { finishReason, usage, modelVersion: msg.model, providerRequestId: msg.id, ...(webSearch ? { webSearch } : {}), raw: { stop_reason: msg.stop_reason, model: msg.model } };
      if (finishReason === "content_filter") {
        // the whole fallback chain declined (stop_details carries the category)
        const cat = (msg as { stop_details?: { category?: string | null } }).stop_details?.category;
        return { ok: false, errorFamily: "content_filtered", message: `Claude가 안전 정책으로 응답을 거절했습니다${cat ? ` (${cat})` : ""}.`, billed: "yes", usage, providerRequestId: msg.id };
      }
      if (req.output.kind === "object") {
        const object = parseJsonText(text);
        return { ok: true, object, text: object === undefined ? text : undefined, ...common };
      }
      return { ok: true, text, ...common };
    } catch (err) {
      return classifyAnthropicError(err, ac.signal, timedOut);
    } finally {
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", onAbort);
    }
  }
}
