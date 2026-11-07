/** Browser side of the snowpage API (same origin, cookies). Anonymous: no login anywhere. */
import type { ApiErrorDto, SessionDto } from "./api-types";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

let session: Promise<SessionDto> | null = null;

/** CSRF token + whether writes are on (fetched once per page view) */
export function getSession(): Promise<SessionDto> {
  if (!session) {
    session = request<SessionDto>("GET", "/session");
    session.catch(() => {
      session = null;
    });
  }
  return session;
}

async function request<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown, csrf?: string): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (csrf) headers["x-csrf-token"] = csrf;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin", cache: "no-store" });
  } catch {
    throw new HttpError(0, "network", "연결하지 못했습니다. 잠시 뒤에 다시 해 주세요.");
  }
  if (res.status === 204) return undefined as T;
  const type = res.headers.get("content-type") ?? "";
  const json = type.includes("application/json") ? ((await res.json()) as unknown) : null;
  if (!res.ok) {
    const e = (json as ApiErrorDto | null)?.error;
    throw new HttpError(res.status, e?.code ?? "http", e?.message ?? "요청을 처리하지 못했습니다.");
  }
  return json as T;
}

export async function api<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
  if (method === "GET") return request<T>(method, path);
  const s = await getSession();
  try {
    return await request<T>(method, path, body, s.csrf);
  } catch (e) {
    // stale token (cookie cleared): fetch a fresh one and retry once
    if (e instanceof HttpError && e.code === "bad_csrf") {
      session = null;
      return request<T>(method, path, body, (await getSession()).csrf);
    }
    throw e;
  }
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : "문제가 생겼습니다.");
