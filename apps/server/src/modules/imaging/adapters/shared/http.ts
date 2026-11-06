/**
 * fetch helpers of the image adapters: abort + timeout, 401 → refresh once → replay (OAuth credentials; a 401 is
 * rejected before billing, so the replay is safe), HTTP error → ImageResult failure. Image POSTs are NOT retried on
 * 5xx / resets — the provider may already have generated and billed the image (ima2-gen grokImageCore).
 * Messages never contain tokens or more than a short sanitized excerpt of the upstream body.
 */
import type { ErrorFamily } from "@ncs/shared";
import type { LlmCredential } from "../../../llm/index.js";
import type { ImageResult } from "../../index.js";

export type ImageFailure = Extract<ImageResult, { ok: false }>;

export function linkedSignal(signal: AbortSignal, timeoutMs: number): { signal: AbortSignal; timedOut(): boolean; dispose(): void } {
  const ac = new AbortController();
  let timedOut = false;
  const onAbort = () => ac.abort();
  if (signal.aborted) ac.abort();
  else signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, timeoutMs);
  return {
    signal: ac.signal,
    timedOut: () => timedOut,
    dispose() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    },
  };
}

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

export function sanitize(s: string, max = 240): string {
  return s
    .replace(/(sk-|xai-|AIza)[A-Za-z0-9_-]{6,}/g, "$1***")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer ***")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "***")
    .slice(0, max);
}

export function errorMessageOf(body: string): { message: string; code?: string } {
  try {
    const j = JSON.parse(body) as { error?: unknown; message?: unknown; detail?: unknown; code?: unknown };
    const e = j.error;
    if (typeof e === "string") return { message: e, code: typeof j.code === "string" ? j.code : undefined };
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

const PERMANENT_LIMIT_RE = /usage[ _]?limit|insufficient[_ ]quota|billing|hard limit|spending|credits?|plan limit|monthly|weekly|daily|per day|\b5[- ]?hours?\b/i;
const SAFETY_RE = /safety|moderation|content[_ ]policy|policy[_ ]violation|content_filter|blocked/i;

export function classify(status: number, text: string): ErrorFamily {
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 400 && /API_KEY_INVALID|API key not valid|invalid api key|incorrect api key/i.test(text)) return "auth_failed";
  if (status === 429) return PERMANENT_LIMIT_RE.test(text) ? "quota_exhausted" : "rate_limited";
  if (status === 402) return "quota_exhausted";
  if (status === 408) return "timeout";
  if (status >= 500) return "provider_unavailable";
  if (SAFETY_RE.test(text)) return "content_filtered";
  return "internal";
}

export interface FailureCopy {
  vendor: string;
  auth: string;
}

export async function httpFailure(res: Response, copy: FailureCopy): Promise<ImageFailure> {
  const body = await res.text().catch(() => "");
  const { message, code } = errorMessageOf(body);
  const family = classify(res.status, `${message} ${code ?? ""} ${body.slice(0, 500)}`);
  const detail = sanitize(message || code || "");
  const text =
    family === "auth_failed"
      ? copy.auth
      : family === "quota_exhausted"
        ? `${copy.vendor} 계정의 크레딧 또는 사용 한도가 소진되었습니다.`
        : family === "rate_limited"
          ? `${copy.vendor} 요청 한도를 넘었습니다. 잠시 후 다시 시도하세요.`
          : family === "provider_unavailable"
            ? `${copy.vendor}에 일시적인 문제가 있습니다 (HTTP ${res.status}).`
            : family === "content_filtered"
              ? `${copy.vendor}의 안전 정책으로 이미지를 만들 수 없습니다. 프롬프트를 바꿔 보세요.${detail ? ` (${detail})` : ""}`
              : `${copy.vendor}가 요청을 거부했습니다 (HTTP ${res.status})${detail ? `: ${detail}` : "."}`;
  return {
    ok: false,
    errorFamily: family,
    message: text.slice(0, 500),
    httpStatus: res.status,
    billed: family === "provider_unavailable" ? "unknown" : "no",
    providerRequestId: res.headers.get("x-request-id") ?? res.headers.get("request-id") ?? undefined,
  };
}

export function thrownFailure(err: unknown, timedOut: boolean, aborted: boolean, vendor: string): ImageFailure {
  if (timedOut) return { ok: false, errorFamily: "timeout", message: `${vendor} 응답 시간이 초과되었습니다. 공급자에서 비용이 청구되었을 수 있습니다.`, billed: "unknown" };
  if (aborted || (err instanceof Error && err.name === "AbortError")) return { ok: false, errorFamily: "timeout", message: "생성이 취소되었습니다.", billed: "unknown" };
  if (err instanceof TypeError) return { ok: false, errorFamily: "provider_unavailable", message: `${vendor} 서버에 연결할 수 없습니다. 네트워크를 확인하세요.`, billed: "unknown" };
  return { ok: false, errorFamily: "internal", message: `${vendor} 호출 중 오류: ${sanitize(err instanceof Error ? err.message : String(err))}`, billed: "unknown" };
}

export const trimSlash = (u: string) => u.replace(/\/+$/, "");

export function decodeBase64(b64: string): Uint8Array {
  const clean = b64.replace(/^data:[^;]+;base64,/, "");
  return new Uint8Array(Buffer.from(clean, "base64"));
}

/** JSON body of a 2xx response; a non-JSON body becomes a failure */
export async function readJson(res: Response, vendor: string): Promise<{ ok: true; body: unknown } | ImageFailure> {
  const text = await res.text();
  try {
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, errorFamily: "invalid_output", message: `${vendor} 응답을 해석할 수 없습니다.`, billed: "unknown" };
  }
}

export const noImage = (vendor: string): ImageFailure => ({
  ok: false,
  errorFamily: "invalid_output",
  message: `${vendor} 응답에 이미지가 없습니다.`,
  billed: "unknown",
});
