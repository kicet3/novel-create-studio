/** Published snapshot (static JSON under DATA_BASE) + the optional reader API (likes / ratings / comments). */
import { useCallback, useEffect, useRef, useState } from "react";
import { publicPaths, type PublicEpisode, type PublicNovelHome, type PublicNovelList } from "@ncs/reader-core/snapshot";
import type { ApiErrorDto, SessionDto } from "../../server/api-types.js";

const BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/+$/, "");
export const DATA_BASE = (import.meta.env.VITE_DATA_BASE as string | undefined)?.replace(/\/+$/, "") ?? `${BASE}/data`;
export const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/+$/, "") ?? `${BASE}/api`;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const cache = new Map<string, Promise<unknown>>();

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal, headers: { accept: "application/json" }, credentials: "same-origin" });
  if (!res.ok) throw new HttpError(res.status, "http", res.status === 404 ? "찾을 수 없습니다." : "불러오지 못했습니다.");
  return (await res.json()) as T;
}

/** cached per URL for this page view (the snapshot changes rarely; a reload picks up new episodes) */
function cached<T>(url: string): Promise<T> {
  let p = cache.get(url) as Promise<T> | undefined;
  if (!p) {
    p = getJson<T>(url);
    cache.set(url, p);
    p.catch(() => cache.delete(url));
  }
  return p;
}

export const loadList = () => cached<PublicNovelList>(`${DATA_BASE}/${publicPaths.list}`);
export const loadNovel = (slug: string) => cached<PublicNovelHome>(`${DATA_BASE}/${publicPaths.home(slug)}`);
export const loadEpisode = (slug: string, no: number) => cached<PublicEpisode>(`${DATA_BASE}/${publicPaths.episode(slug, no)}`);

export interface AsyncState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload: () => void;
}

/** run `fn` when `key` changes; keeps the previous data while loading the next key */
export function useAsync<T>(key: string | null, fn: () => Promise<T>): AsyncState<T> {
  const [state, setState] = useState<{ key: string | null; data?: T; error?: Error; loading: boolean }>({ key: null, loading: !!key });
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (!key) return;
    let alive = true;
    setState((s) => ({ ...s, key, loading: true, error: undefined }));
    fnRef.current().then(
      (data) => {
        if (alive) setState({ key, data, loading: false });
      },
      (error: unknown) => {
        if (alive) setState((s) => ({ ...s, key, error: error instanceof Error ? error : new Error(String(error)), loading: false }));
      },
    );
    return () => {
      alive = false;
    };
  }, [key, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data: state.data, error: state.error, loading: state.loading, reload };
}

// ── reader API ───────────────────────────────────────────────────────────
let csrf = "";
export const setCsrf = (t: string) => {
  csrf = t;
};

export async function api<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json", ...extraHeaders };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET" && csrf) headers["x-csrf-token"] = csrf;
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin" });
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
  if (json === null) throw new HttpError(res.status, "not_json", "읽기 전용 사이트입니다.");
  const s = json as Partial<SessionDto>;
  if (typeof s.csrf === "string") setCsrf(s.csrf);
  return json as T;
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : "문제가 생겼습니다.");
