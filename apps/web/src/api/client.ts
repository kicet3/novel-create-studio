import { apiErrorSchema } from "@ncs/shared";

/**
 * Typed fetch wrapper for the NCS HTTP API (`/api/...`, same origin; Vite proxies to :3100 in dev).
 *
 * - JSON in / JSON out. 204 and empty bodies resolve to `undefined`.
 * - Non-2xx responses throw `ApiRequestError` carrying the server's `{ error: { code, message, details } }`
 *   body (apiErrorSchema in @ncs/shared/dto). Network failures throw with `status = 0`.
 * - Pass a `schema` (any object with `parse`, e.g. a zod schema from @ncs/shared) to validate the response.
 */

export const API_BASE = "/api";

/** Minimal structural type for a response validator (zod schemas satisfy it). */
export interface ResponseParser<T> {
  parse(input: unknown): T;
}

export type QueryValue = string | number | boolean | null | undefined;
export type QueryParams = Record<string, QueryValue | readonly QueryValue[]>;

export interface ApiRequestOptions<T> {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** JSON-serialised request body. */
  body?: unknown;
  query?: QueryParams;
  schema?: ResponseParser<T>;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export class ApiRequestError extends Error {
  override readonly name = "ApiRequestError";
  constructor(
    /** HTTP status; 0 = network failure / no response. */
    readonly status: number,
    /** Server error code (e.g. `not_found`, `validation_failed`), or a client-side code. */
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500;
  }
  get isNetworkError(): boolean {
    return this.status === 0;
  }
}

export function isApiRequestError(e: unknown): e is ApiRequestError {
  return e instanceof ApiRequestError;
}

/** Build `/api/<path>?query`. `path` may start with or without `/`; a leading `/api` is not duplicated. */
export function apiUrl(path: string, query?: QueryParams): string {
  let p = path.startsWith("/") ? path : `/${path}`;
  if (!p.startsWith(`${API_BASE}/`) && p !== API_BASE) p = `${API_BASE}${p}`;
  if (!query) return p;
  const sp = new URLSearchParams();
  for (const [key, raw] of Object.entries(query)) {
    const values = Array.isArray(raw) ? raw : [raw];
    for (const v of values as QueryValue[]) {
      if (v === undefined || v === null) continue;
      sp.append(key, String(v));
    }
  }
  const qs = sp.toString();
  return qs ? `${p}?${qs}` : p;
}

const STATUS_MESSAGES_KO: Record<number, string> = {
  400: "요청 형식이 올바르지 않습니다.",
  401: "인증이 필요합니다.",
  403: "접근 권한이 없습니다.",
  404: "찾을 수 없습니다.",
  409: "다른 변경과 충돌했습니다. 새로 고친 뒤 다시 시도하세요.",
  422: "입력값을 확인하세요.",
  429: "요청이 너무 많습니다. 잠시 후 다시 시도하세요.",
  500: "서버 오류가 발생했습니다.",
  502: "서버에 연결할 수 없습니다.",
  503: "서버를 일시적으로 사용할 수 없습니다.",
};

export async function apiFetch<T = unknown>(path: string, opts: ApiRequestOptions<T> = {}): Promise<T> {
  const { method = "GET", body, query, schema, signal, headers } = opts;
  const init: RequestInit = {
    method,
    signal,
    credentials: "same-origin",
    headers: { Accept: "application/json", ...headers },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }

  let res: Response;
  try {
    res = await fetch(apiUrl(path, query), init);
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiRequestError(0, "network_error", "서버에 연결할 수 없습니다.", e);
  }

  const text = res.status === 204 ? "" : await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      if (res.ok) throw new ApiRequestError(res.status, "invalid_json", "서버 응답을 해석할 수 없습니다.", text);
    }
  }

  if (!res.ok) {
    const parsed = apiErrorSchema.safeParse(data);
    if (parsed.success) {
      const { code, message, details } = parsed.data.error;
      throw new ApiRequestError(res.status, code, message, details);
    }
    throw new ApiRequestError(
      res.status,
      `http_${res.status}`,
      STATUS_MESSAGES_KO[res.status] ?? `요청이 실패했습니다 (HTTP ${res.status}).`,
      data ?? text,
    );
  }

  if (!schema) return data as T;
  try {
    return schema.parse(data);
  } catch (e) {
    throw new ApiRequestError(res.status, "invalid_response", "서버 응답 형식이 예상과 다릅니다.", e);
  }
}

/** Convenience verbs. */
export const api = {
  get: <T = unknown>(path: string, opts?: Omit<ApiRequestOptions<T>, "method" | "body">) =>
    apiFetch<T>(path, { ...opts, method: "GET" }),
  post: <T = unknown>(path: string, body?: unknown, opts?: Omit<ApiRequestOptions<T>, "method" | "body">) =>
    apiFetch<T>(path, { ...opts, method: "POST", body }),
  put: <T = unknown>(path: string, body?: unknown, opts?: Omit<ApiRequestOptions<T>, "method" | "body">) =>
    apiFetch<T>(path, { ...opts, method: "PUT", body }),
  patch: <T = unknown>(path: string, body?: unknown, opts?: Omit<ApiRequestOptions<T>, "method" | "body">) =>
    apiFetch<T>(path, { ...opts, method: "PATCH", body }),
  delete: <T = unknown>(path: string, opts?: Omit<ApiRequestOptions<T>, "method" | "body">) =>
    apiFetch<T>(path, { ...opts, method: "DELETE" }),
};

/** Korean, user-facing message for any thrown value. */
export function errorMessage(e: unknown): string {
  if (isApiRequestError(e)) return e.message;
  if (e instanceof Error) return e.message;
  return "알 수 없는 오류가 발생했습니다.";
}
