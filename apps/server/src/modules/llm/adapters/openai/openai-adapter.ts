/**
 * GPT adapter (OpenAI Responses API shape), two lanes chosen by the credential:
 * - `api_key`: `POST {api}/v1/responses` with `Authorization: Bearer sk-…` (OpenAI API pricing);
 * - `chatgpt_oauth`: `POST {codex}/responses` on the ChatGPT Codex backend with the ChatGPT access token +
 *   `chatgpt-account-id` (ported from ima2-gen lib/codexBackend: `store:false, stream:true`, "responses-lite"
 *   shaping for GPT-6 / GPT-5.6 — instructions and tools move into developer input items, `reasoning.context=all_turns`
 *   — and NO sampling / max_output_tokens params). Plan-billed by the user's ChatGPT subscription.
 *
 * Both lanes stream SSE; text is accumulated from `response.output_text.delta` (the final `response.completed`
 * may carry an empty `output`). No output truncation (ima2's 4,000-char cut is NOT ported — it would cut prose).
 * JSON: `text.format = json_schema` (strict when representable); a 400 on the format retries once with
 * `json_object` + the schema described in the prompt. The gateway's zod validation + repair retries stay.
 * A 401 on an OAuth credential refreshes once (single-flight in the credential store) and replays.
 * Web search (설계 추가 0011): API-key lane only — Responses `tools: [{type:"web_search"}]` + `max_tool_calls`;
 * sources = `url_citation` annotations, searches = `web_search_call` items. The ChatGPT (Codex backend) lane is not
 * verified to accept hosted tools → reported unsupported and the call runs without search.
 */
import type { LlmAdapter, LlmCapabilities, LlmCitation, LlmCredential, LlmEnvironmentCheck, LlmInvokeOptions, LlmRequest, LlmResult, LlmUsage } from "../../index.js";
import {
  StreamError,
  credentialOf,
  fetchWithCredential,
  httpFailure,
  jsonInstruction,
  linkedSignal,
  parseJsonText,
  readSse,
  sanitize,
  thrownFailure,
  tapProgress,
  trimSlash,
  type FailureCopy,
} from "../shared/http.js";
import { jsonSchemaFormat } from "../shared/json-schema.js";

export const OPENAI_API_BASE_URL = "https://api.openai.com";
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
/** lowest Codex client version measured to list the GPT-6 models (ima2-gen, 2026-09-25) */
export const CODEX_CLIENT_VERSION_FLOOR = "0.157.0";

const COPY_API: FailureCopy = {
  vendor: "OpenAI API",
  auth: "OpenAI API 키가 올바르지 않거나 권한이 없습니다. 설정 → AI 계정 연결에서 키를 확인하세요.",
  quota: "OpenAI 계정의 크레딧 또는 사용 한도가 소진되었습니다.",
  rate: "OpenAI API 요청 한도를 넘었습니다. 잠시 후 다시 시도합니다.",
  unavailable: "OpenAI API에 일시적인 문제가 있습니다.",
};
const COPY_CHATGPT: FailureCopy = {
  vendor: "ChatGPT(Codex) 백엔드",
  auth: "ChatGPT 로그인이 만료되었거나 거부되었습니다. 설정 → AI 계정 연결에서 다시 로그인하세요.",
  quota: "ChatGPT 요금제의 사용 한도(5시간·주간 등)에 도달했습니다. 한도가 풀린 뒤 다시 시도하세요.",
  rate: "ChatGPT 요청 한도를 넘었습니다. 잠시 후 다시 시도합니다.",
  unavailable: "ChatGPT(Codex) 백엔드에 일시적인 문제가 있습니다.",
};

/** GPT-6 / GPT-5.6 need the responses-lite shape on the Codex backend */
export function isLiteModel(modelId: string): boolean {
  return /^gpt-(6|5\.6)([.-]|$)/.test(modelId);
}

export interface OpenAiAdapterOptions {
  apiBaseUrl?: string;
  codexBaseUrl?: string;
  codexClientVersion?: string;
}

type Body = Record<string, unknown>;

export function buildResponsesBody(req: LlmRequest, lane: "api" | "chatgpt", format: "schema" | "json_object" | null): Body {
  const wantsJson = req.output.kind === "object";
  const instructions = req.system + (wantsJson && format === "json_object" ? jsonInstruction((req.output as { jsonSchema: Body }).jsonSchema) : "");
  const input: Body[] = req.messages.map((m) => ({ role: m.role, content: [{ type: m.role === "assistant" ? "output_text" : "input_text", text: m.content }] }));
  const text =
    wantsJson && req.output.kind === "object"
      ? { format: format === "json_object" ? { type: "json_object" } : jsonSchemaFormat(req.output.schemaName, req.output.jsonSchema) }
      : undefined;
  if (lane === "api") {
    const search = req.webSearch ? { tools: [{ type: "web_search" }], max_tool_calls: req.webSearch.maxUses } : {};
    return { model: req.modelId, instructions, input, max_output_tokens: req.maxOutputTokens, store: false, stream: true, ...(text ? { text } : {}), ...search };
  }
  const body: Body = { model: req.modelId, input, store: false, stream: true, ...(text ? { text } : {}) };
  if (!isLiteModel(req.modelId)) return { ...body, instructions };
  return {
    ...body,
    input: [{ role: "developer", content: [{ type: "input_text", text: instructions }] }, ...input],
    instructions: "",
    parallel_tool_calls: false,
    reasoning: { context: "all_turns" },
  };
}

interface Collected {
  text: string;
  doneText: string;
  messageText: string;
  refusal: string;
  usage: LlmUsage;
  status: "completed" | "incomplete";
  incompleteReason: string | null;
  model?: string;
  id?: string;
  /** web search: url_citation annotations + web_search_call items */
  citations: Array<{ url: string; title: string | null }>;
  searches: number;
  queries: string[];
}

function mapUsage(u: unknown): LlmUsage {
  const o = (u && typeof u === "object" ? u : {}) as {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
  return {
    inputTokens: o.input_tokens ?? 0,
    outputTokens: o.output_tokens ?? 0,
    cachedInputTokens: o.input_tokens_details?.cached_tokens || undefined,
    reasoningTokens: o.output_tokens_details?.reasoning_tokens,
  };
}

function failureFamily(code: string | undefined, message: string) {
  const s = `${code ?? ""} ${message}`;
  if (/insufficient_quota|usage_limit|usage limit|billing|quota/i.test(s)) return "quota_exhausted" as const;
  if (/rate_limit|rate limit/i.test(s)) return "rate_limited" as const;
  if (/content_filter|safety|policy/i.test(s)) return "content_filtered" as const;
  if (/invalid_request|context_length|invalid_prompt/i.test(s)) return "internal" as const;
  return "provider_unavailable" as const;
}

export async function collectResponsesStream(body: ReadableStream<Uint8Array> | null): Promise<Collected> {
  const c: Collected = { text: "", doneText: "", messageText: "", refusal: "", usage: { inputTokens: 0, outputTokens: 0 }, status: "completed", incompleteReason: null, citations: [], searches: 0, queries: [] };
  const cite = (a: unknown) => {
    const x = a as { type?: string; url?: unknown; title?: unknown } | null;
    if (x?.type === "url_citation" && typeof x.url === "string" && !c.citations.some((y) => y.url === x.url)) c.citations.push({ url: x.url, title: typeof x.title === "string" ? x.title : null });
  };
  let terminal = false;
  await readSse(body, (d) => {
    const ev = d as { type?: string; delta?: unknown; text?: unknown; annotation?: unknown; item?: { type?: string; content?: unknown[]; action?: { type?: string; query?: unknown } }; response?: Body; error?: { code?: string; message?: string } };
    switch (ev.type) {
      case "response.created":
      case "response.in_progress":
        if (ev.response) {
          c.id ??= ev.response.id as string | undefined;
          c.model ??= ev.response.model as string | undefined;
        }
        break;
      case "response.output_text.delta":
        if (typeof ev.delta === "string") c.text += ev.delta;
        break;
      case "response.output_text.done":
        if (typeof ev.text === "string") c.doneText += ev.text;
        break;
      case "response.refusal.delta":
        if (typeof ev.delta === "string") c.refusal += ev.delta;
        break;
      case "response.output_text.annotation.added":
        cite(ev.annotation);
        break;
      case "response.output_item.done":
        if (ev.item?.type === "web_search_call") {
          c.searches++;
          if (typeof ev.item.action?.query === "string") c.queries.push(ev.item.action.query.slice(0, 200));
        }
        if (ev.item?.type === "message" && Array.isArray(ev.item.content)) {
          for (const part of ev.item.content as Array<{ type?: string; text?: unknown; refusal?: unknown; annotations?: unknown[] }>) {
            for (const a of part.annotations ?? []) cite(a);
            if (part.type === "refusal" && typeof part.refusal === "string") c.refusal ||= part.refusal;
            else if (typeof part.text === "string") c.messageText += part.text;
            else if (part.text && typeof part.text === "object" && typeof (part.text as { value?: unknown }).value === "string") c.messageText += (part.text as { value: string }).value;
          }
        }
        break;
      case "response.completed":
      case "response.done":
      case "response.incomplete": {
        terminal = true;
        const r = ev.response ?? {};
        c.usage = mapUsage(r.usage);
        c.id = (r.id as string | undefined) ?? c.id;
        c.model = (r.model as string | undefined) ?? c.model;
        if (ev.type === "response.incomplete" || r.status === "incomplete") {
          c.status = "incomplete";
          c.incompleteReason = ((r.incomplete_details as { reason?: string } | undefined)?.reason ?? "max_output_tokens") as string;
        }
        break;
      }
      case "response.failed": {
        const e = (ev.response?.error ?? {}) as { code?: string; message?: string };
        throw new StreamError(e.message ?? "response.failed", failureFamily(e.code, e.message ?? ""));
      }
      case "error": {
        const e = ev.error ?? (ev as { code?: string; message?: string });
        throw new StreamError(e.message ?? "error", failureFamily(e.code, e.message ?? ""));
      }
      default:
        break;
    }
  });
  if (!terminal && !c.text && !c.doneText && !c.messageText) throw new StreamError("응답 스트림이 완료 이벤트 없이 끝났습니다.");
  return c;
}

export class OpenAiLlmAdapter implements LlmAdapter {
  readonly provider = "openai";
  private readonly api: string;
  private readonly codex: string;
  private readonly clientVersion: string;

  constructor(opts: OpenAiAdapterOptions = {}) {
    this.api = trimSlash(opts.apiBaseUrl ?? OPENAI_API_BASE_URL);
    this.codex = trimSlash(opts.codexBaseUrl ?? CODEX_BASE_URL);
    this.clientVersion = opts.codexClientVersion ?? CODEX_CLIENT_VERSION_FLOOR;
  }

  capabilities(_modelId: string): LlmCapabilities {
    return {
      structuredOutput: "json_schema",
      maxContextTokens: 272_000,
      maxOutputTokens: 128_000,
      promptCaching: true,
      reportsUsage: true,
      reportsCost: false,
      outputLimitCoversReasoning: true,
    };
  }

  webSearchSupport(_modelId: string, method?: LlmCredential["method"]): true | string {
    return method === "chatgpt_oauth" ? "ChatGPT 로그인 연결은 인터넷 검색을 아직 지원하지 않아 검색 없이 진행합니다. 검색이 필요하면 OpenAI API 키로 연결하세요." : true;
  }

  private lane(c: LlmCredential): "api" | "chatgpt" {
    return c.method === "chatgpt_oauth" ? "chatgpt" : "api";
  }

  async testEnvironment(input: { apiKey: string; credential?: LlmCredential; modelId?: string; signal: AbortSignal }): Promise<LlmEnvironmentCheck> {
    const cred = credentialOf(input);
    if (!cred.token) return { status: "fail", errorFamily: "auth_failed", message: "GPT 연결이 없습니다. 설정 → AI 계정 연결에서 ChatGPT 로그인 또는 API 키를 등록하세요." };
    const lane = this.lane(cred);
    const copy = lane === "chatgpt" ? COPY_CHATGPT : COPY_API;
    const url = lane === "chatgpt" ? `${this.codex}/models?client_version=${encodeURIComponent(this.clientVersion)}` : `${this.api}/v1/models`;
    try {
      const res = await fetchWithCredential(url, { method: "GET", signal: input.signal }, cred);
      if (!res.ok) {
        const f = await httpFailure(res, copy);
        if (f.errorFamily === "rate_limited") return { status: "warn", errorFamily: f.errorFamily, message: "요청 한도에 걸려 점검을 끝내지 못했습니다. 잠시 후 다시 확인하세요." };
        return { status: "fail", errorFamily: f.errorFamily, message: f.message };
      }
      const j = (await res.json().catch(() => ({}))) as { data?: Array<{ id?: string }>; models?: Array<{ slug?: string; visibility?: string }> };
      const ids = lane === "chatgpt" ? (j.models ?? []).filter((m) => m.visibility !== "hide").map((m) => m.slug) : (j.data ?? []).map((m) => m.id);
      const what = lane === "chatgpt" ? "ChatGPT 로그인(Codex 백엔드)" : "OpenAI API";
      if (input.modelId && ids.length && !ids.includes(input.modelId)) {
        return { status: "warn", message: `${what} 연결은 확인했지만 이 계정에서 모델 ${input.modelId}을(를) 찾을 수 없습니다.` };
      }
      return { status: "pass", message: input.modelId ? `${what} 연결과 모델(${input.modelId}) 확인을 마쳤습니다.` : `${what} 연결을 확인했습니다.` };
    } catch (err) {
      const f = thrownFailure(err, false, copy.vendor);
      return { status: "fail", errorFamily: f.errorFamily, message: f.message };
    }
  }

  async invoke(req: LlmRequest, opts: LlmInvokeOptions): Promise<LlmResult> {
    const cred = credentialOf(opts);
    const lane = this.lane(cred);
    const copy = lane === "chatgpt" ? COPY_CHATGPT : COPY_API;
    const link = linkedSignal(opts.signal, opts.timeoutMs);
    try {
      let format: "schema" | "json_object" | null = req.output.kind === "object" ? "schema" : null;
      for (let attempt = 0; ; attempt++) {
        const body = buildResponsesBody(req, lane, format);
        const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream" };
        if (lane === "chatgpt" && isLiteModel(req.modelId)) headers["x-openai-internal-codex-responses-lite"] = "true";
        if (lane === "api" && opts.idempotencyKey) headers["x-ncs-idempotency-key"] = opts.idempotencyKey;
        const url = lane === "chatgpt" ? `${this.codex}/responses` : `${this.api}/v1/responses`;
        const res = await fetchWithCredential(url, { method: "POST", headers, body: JSON.stringify(body), signal: link.signal }, cred);
        if (!res.ok) {
          // the schema format was rejected (unsupported keyword / not accepted on this lane) → json_object once
          if (res.status === 400 && format === "schema" && attempt === 0) {
            await res.body?.cancel().catch(() => {});
            format = "json_object";
            continue;
          }
          return await httpFailure(res, copy);
        }
        const c = await collectResponsesStream(tapProgress(res.body, opts.onProgress)); // idle-timeout liveness (gateway)
        const text = c.text || c.doneText || c.messageText;
        const finishReason = c.status === "incomplete" ? (c.incompleteReason === "content_filter" ? "content_filter" : "length") : "stop";
        if (c.refusal && !text) {
          return { ok: false, errorFamily: "content_filtered", message: `GPT가 안전 정책으로 응답을 거절했습니다: ${sanitize(c.refusal, 200)}`, billed: "yes", usage: c.usage, providerRequestId: c.id };
        }
        if (finishReason === "content_filter") {
          return { ok: false, errorFamily: "content_filtered", message: "GPT가 안전 정책으로 응답을 중단했습니다.", billed: "yes", usage: c.usage, providerRequestId: c.id };
        }
        const now = new Date().toISOString();
        const webSearch = req.webSearch
          ? {
              status: c.searches > 0 ? ("used" as const) : ("not_used" as const),
              citationsKind: "cited" as const,
              requests: c.searches,
              citations: c.citations.slice(0, 12).map((x): LlmCitation => ({ ...x, retrievedAt: now })),
              ...(c.queries.length ? { queries: c.queries } : {}),
            }
          : undefined;
        const usage = webSearch ? { ...c.usage, webSearchRequests: webSearch.requests } : c.usage;
        const common = { finishReason, usage, modelVersion: c.model, providerRequestId: c.id, ...(webSearch ? { webSearch } : {}), raw: { lane, status: c.status, incomplete: c.incompleteReason, format } } as const;
        if (req.output.kind === "object") {
          const object = parseJsonText(text);
          return { ok: true, object, text: object === undefined ? text : undefined, ...common };
        }
        return { ok: true, text, ...common };
      }
    } catch (err) {
      return thrownFailure(err, link.timedOut(), copy.vendor);
    } finally {
      link.dispose();
    }
  }
}
