/**
 * fetch-based helpers shared by the OpenAI / xAI / Gemini adapters and the OAuth flows:
 * abort+timeout wiring, SSE reading, provider error bodies → LlmResult failures, Retry-After parsing,
 * unsigned JWT claim decoding (display / expiry only — never trusted for authorization).
 * Error messages never include tokens or raw upstream bodies beyond a short sanitized excerpt.
 */
import type { ErrorFamily } from "@ncs/shared";
import type { LlmCredential, LlmResult } from "../../index.js";
import { classifyHttpError } from "../../domain/errors.js";

export type Failure = Extract<LlmResult, { ok: false }>;

/** Signal that aborts on the caller's signal or after `timeoutMs`; `timedOut()` tells which. */
export function linkedSignal(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; timedOut(): boolean; dispose(): void } {
  const ac = new AbortController();
  let timedOut = false;
  const onAbort = () => ac.abort();
  if (signal?.aborted) ac.abort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, timeoutMs);
  return {
    signal: ac.signal,
    timedOut: () => timedOut,
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Response body that reports liveness (`LlmInvokeOptions.onProgress`) once now (headers arrived) and on every chunk,
 * so the gateway's idle timeout only fires when the stream really goes silent. No hook → the body unchanged.
 */
export function tapProgress(body: ReadableStream<Uint8Array> | null, onProgress: (() => void) | undefined): ReadableStream<Uint8Array> | null {
  if (!body || !onProgress) return body;
  const ping = () => {
    try {
      onProgress();
    } catch {
      /* liveness only */
    }
  };
  ping();
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, c) {
        ping();
        c.enqueue(chunk);
      },
    }),
  );
}

/** Retry-After (seconds or HTTP date) or "try again in 7.5s" in the message → absolute time */
export function retryNotBefore(headers: Headers | undefined, message = "", now = Date.now()): Date | undefined {
  const ra = headers?.get("retry-after");
  if (ra) {
    const sec = Number(ra);
    if (Number.isFinite(sec)) return new Date(now + sec * 1000);
    const at = Date.parse(ra);
    if (Number.isFinite(at)) return new Date(at);
  }
  const m = /try again in\s*([\d.]+)\s*(ms|milliseconds?|s|secs?|seconds?)\b/i.exec(message);
  if (m) {
    const n = Number(m[1]);
    return new Date(now + (m[2]!.toLowerCase().startsWith("m") ? n : n * 1000));
  }
  const g = /"retryDelay"\s*:\s*"([\d.]+)s"/.exec(message);
  if (g) return new Date(now + Number(g[1]) * 1000);
  return undefined;
}

/** plan / billing caps (ChatGPT 5-hour & weekly windows, credits) — fail fast, never retried */
const PERMANENT_LIMIT_RE =
  /usage[ _]?limit|usage cap|insufficient[_ ]quota|billing[ _](?:hard[ _])?limit|hard limit|spending|insufficient[_ ]credits?|credits? (?:exhausted|depleted|balance)|out of credits|plan limit|monthly|weekly|daily|per day|\b5[- ]?hours?\b/i;
const TRANSIENT_LIMIT_RE = /rate[ _]?limit|per min|per minute|try again in|requests per|tokens per|retryDelay|RESOURCE_EXHAUSTED/i;

export function classifyStatus(status: number, message: string): ErrorFamily {
  if (status === 429) {
    if (PERMANENT_LIMIT_RE.test(message)) return "quota_exhausted";
    if (TRANSIENT_LIMIT_RE.test(message)) return "rate_limited";
    return classifyHttpError(status, message);
  }
  return classifyHttpError(status, message);
}

/** `{error:{message,code,type,status}}` | `{error:"…"}` | `{message}` → short message (no secrets echoed) */
export function errorMessageOf(body: string): { message: string; code?: string } {
  try {
    const j = JSON.parse(body) as { error?: unknown; message?: unknown; detail?: unknown };
    const e = j.error;
    if (typeof e === "string") return { message: e };
    if (e && typeof e === "object") {
      const o = e as { message?: unknown; code?: unknown; type?: unknown; status?: unknown };
      return { message: typeof o.message === "string" ? o.message : "", code: [o.code, o.type, o.status].find((x): x is string => typeof x === "string") };
    }
    if (typeof j.message === "string") return { message: j.message };
    if (typeof j.detail === "string") return { message: j.detail };
  } catch {
    /* not JSON */
  }
  return { message: body.slice(0, 200) };
}

export function sanitize(s: string, max = 300): string {
  return s
    .replace(/(sk-|xai-|AIza)[A-Za-z0-9_-]{6,}/g, "$1***")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer ***")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "***")
    .slice(0, max);
}

export interface FailureCopy {
  vendor: string;
  auth: string;
  quota: string;
  rate: string;
  unavailable: string;
}

/** HTTP error response → LlmResult failure (body consumed) */
export async function httpFailure(res: Response, copy: FailureCopy): Promise<Failure> {
  const body = await res.text().catch(() => "");
  const { message, code } = errorMessageOf(body);
  const family = classifyStatus(res.status, `${message} ${code ?? ""} ${body.slice(0, 500)}`);
  const text =
    family === "auth_failed"
      ? copy.auth
      : family === "quota_exhausted"
        ? copy.quota
        : family === "rate_limited"
          ? copy.rate
          : family === "provider_unavailable"
            ? copy.unavailable
            : `${copy.vendor}가 요청을 거부했습니다 (HTTP ${res.status}): ${sanitize(message || code || "")}`;
  return {
    ok: false,
    errorFamily: family,
    message: text.slice(0, 500),
    httpStatus: res.status,
    retryNotBefore: family === "rate_limited" ? retryNotBefore(res.headers, `${message} ${body.slice(0, 2000)}`) : undefined,
    billed: family === "provider_unavailable" ? "unknown" : "no",
    providerRequestId: res.headers.get("x-request-id") ?? res.headers.get("request-id") ?? undefined,
  };
}

export function thrownFailure(err: unknown, timedOut: boolean, vendor: string): Failure {
  if (timedOut || (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError"))) {
    return { ok: false, errorFamily: "timeout", message: "LLM 응답 시간이 초과되었거나 호출이 중단되었습니다.", billed: "unknown" };
  }
  if (err instanceof TypeError) {
    return { ok: false, errorFamily: "provider_unavailable", message: `${vendor} 서버에 연결할 수 없습니다. 네트워크를 확인하세요.`, billed: "unknown" };
  }
  if (err instanceof StreamError) {
    return { ok: false, errorFamily: err.family, message: `${vendor} 응답 오류: ${sanitize(err.message)}`, billed: "unknown" };
  }
  return { ok: false, errorFamily: "internal", message: `${vendor} 호출 중 오류: ${sanitize(err instanceof Error ? err.message : String(err))}`, billed: "unknown" };
}

/** error reported inside an SSE stream */
export class StreamError extends Error {
  constructor(
    message: string,
    readonly family: ErrorFamily = "provider_unavailable",
  ) {
    super(message);
    this.name = "StreamError";
  }
}

/** Reads an SSE body; calls `onData(json, eventName)` per `data:` block (`[DONE]` and non-JSON blocks skipped). */
export async function readSse(body: ReadableStream<Uint8Array> | null, onData: (data: unknown, event: string | null) => void): Promise<void> {
  if (!body) return;
  const decoder = new TextDecoder();
  let buf = "";
  const flush = (block: string) => {
    let event: string | null = null;
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (!data.length) return;
    const raw = data.join("\n");
    if (raw.trim() === "[DONE]") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    onData(parsed, event);
  };
  const reader = body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let m: RegExpExecArray | null;
    while ((m = /\r?\n\r?\n/.exec(buf))) {
      flush(buf.slice(0, m.index));
      buf = buf.slice(m.index + m[0].length);
    }
  }
  buf += decoder.decode();
  if (buf.trim()) flush(buf);
}

/**
 * fetch with the credential's bearer + headers; on 401 with an OAuth credential, refresh once and replay
 * (only string bodies are replayable; a 401 is rejected before billing).
 */
export async function fetchWithCredential(
  url: string,
  init: RequestInit & { body?: string },
  credential: LlmCredential,
  authHeader: (c: LlmCredential) => Record<string, string> = (c) => ({ authorization: `Bearer ${c.token}` }),
): Promise<Response> {
  const send = (c: LlmCredential) => fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), ...authHeader(c), ...c.headers } });
  const res = await send(credential);
  if (res.status !== 401 || !credential.refresh) return res;
  const fresh = await credential.refresh().catch(() => null);
  if (!fresh || fresh.token === credential.token) return res;
  await res.body?.cancel().catch(() => {});
  return send(fresh);
}

export function credentialOf(opts: { apiKey: string; credential?: LlmCredential }): LlmCredential {
  return opts.credential ?? { method: "api_key", token: opts.apiKey };
}

/** unsigned JWT payload (display/expiry only) */
export function jwtClaims(token: string | null | undefined): Record<string, unknown> | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const o = JSON.parse(json) as unknown;
    return o && typeof o === "object" ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** model JSON as text → object; tolerates a ```json fence / prose around one object */
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

export function jsonInstruction(jsonSchema: Record<string, unknown>): string {
  return `\n\n## 출력 형식\n설명이나 코드 블록 없이 아래 JSON Schema를 따르는 JSON 객체 하나만 출력하세요.\n${JSON.stringify(jsonSchema)}`;
}

export const trimSlash = (u: string) => u.replace(/\/+$/, "");
