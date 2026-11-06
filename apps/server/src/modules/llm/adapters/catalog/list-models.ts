/**
 * Provider model catalogs (install settings → 모델 → [모델 목록 불러오기]). API-key lanes only:
 * Anthropic `GET /v1/models`, OpenAI `GET /v1/models`, xAI `GET /v1/models`, Gemini `GET /v1beta/models`.
 * The key is sent only to the provider's own endpoint; it is never logged and errors never echo it.
 * The Claude subscription CLI is never asked (the service answers with a fixed list instead).
 */
import { linkedSignal } from "../shared/http.js";

export interface CatalogModel {
  id: string;
  label: string | null;
  maxContextTokens: number | null;
  maxOutputTokens: number | null;
}

export interface CatalogEndpoints {
  anthropic?: string;
  openai?: string;
  xai?: string;
  google?: string;
}

export class CatalogError extends Error {
  constructor(
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = "CatalogError";
  }
}

const trim = (u: string) => u.replace(/\/+$/, "");
const DEFAULT_BASE: Record<string, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
  xai: "https://api.x.ai",
  google: "https://generativelanguage.googleapis.com",
};
const LABEL: Record<string, string> = { anthropic: "Claude API", openai: "OpenAI API", xai: "xAI API", google: "Gemini API" };
const num = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Lists the models the API key can use (max 1000, sorted by id). Throws CatalogError (Korean message, no secrets). */
export async function listProviderModels(provider: string, apiKey: string, endpoints: CatalogEndpoints, signal?: AbortSignal): Promise<CatalogModel[]> {
  const base = trim(endpoints[provider as keyof CatalogEndpoints] ?? DEFAULT_BASE[provider] ?? "");
  if (!base) throw new CatalogError(null, `모델 목록을 불러올 수 없는 공급자입니다: ${provider}`);
  const link = linkedSignal(signal, 15_000);
  try {
    if (provider === "anthropic") {
      const out: CatalogModel[] = [];
      let after: string | null = null;
      for (let page = 0; page < 10; page++) {
        const q: string = `limit=100${after ? `&after_id=${encodeURIComponent(after)}` : ""}`;
        const j = await getJson(`${base}/v1/models?${q}`, { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }, provider, link.signal);
        const data = Array.isArray(j.data) ? (j.data as Array<Record<string, unknown>>) : [];
        for (const m of data) {
          const id = str(m.id);
          if (id) out.push({ id, label: str(m.display_name), maxContextTokens: num(m.max_input_tokens), maxOutputTokens: num(m.max_tokens) });
        }
        if (!j.has_more || !str(j.last_id)) break;
        after = str(j.last_id);
      }
      return finish(out);
    }
    if (provider === "openai" || provider === "xai") {
      const j = await getJson(`${base}/v1/models`, { authorization: `Bearer ${apiKey}` }, provider, link.signal);
      const data = Array.isArray(j.data) ? (j.data as Array<Record<string, unknown>>) : [];
      return finish(data.flatMap((m) => (str(m.id) ? [{ id: str(m.id)!, label: null, maxContextTokens: num(m.context_window ?? m.context_length), maxOutputTokens: null }] : [])));
    }
    if (provider === "google") {
      const out: CatalogModel[] = [];
      let token: string | null = null;
      for (let page = 0; page < 10; page++) {
        const q: string = `pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`;
        const j = await getJson(`${base}/v1beta/models?${q}`, { "x-goog-api-key": apiKey }, provider, link.signal);
        const data = Array.isArray(j.models) ? (j.models as Array<Record<string, unknown>>) : [];
        for (const m of data) {
          const methods = Array.isArray(m.supportedGenerationMethods) ? (m.supportedGenerationMethods as unknown[]) : null;
          if (methods && !methods.includes("generateContent")) continue;
          const name = str(m.name);
          if (!name) continue;
          out.push({ id: name.replace(/^models\//, ""), label: str(m.displayName), maxContextTokens: num(m.inputTokenLimit), maxOutputTokens: num(m.outputTokenLimit) });
        }
        token = str(j.nextPageToken);
        if (!token) break;
      }
      return finish(out);
    }
    throw new CatalogError(null, `모델 목록을 불러올 수 없는 공급자입니다: ${provider}`);
  } catch (err) {
    if (err instanceof CatalogError) throw err;
    throw new CatalogError(null, link.timedOut() ? `${LABEL[provider] ?? provider} 응답이 늦어 모델 목록을 불러오지 못했습니다.` : `${LABEL[provider] ?? provider}에 연결하지 못해 모델 목록을 불러오지 못했습니다.`);
  } finally {
    link.dispose();
  }
}

function finish(list: CatalogModel[]): CatalogModel[] {
  const seen = new Map<string, CatalogModel>();
  for (const m of list) if (!seen.has(m.id)) seen.set(m.id, m);
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id)).slice(0, 1000);
}

async function getJson(url: string, headers: Record<string, string>, provider: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const res = await fetch(url, { method: "GET", headers: { accept: "application/json", ...headers }, signal });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    const who = LABEL[provider] ?? provider;
    if (res.status === 401 || res.status === 403) throw new CatalogError(res.status, `${who}가 API 키를 거부했습니다. 설정 → AI 계정 연결에서 키를 확인하세요.`);
    if (res.status === 429) throw new CatalogError(res.status, `${who} 요청 한도에 걸렸습니다. 잠시 후 다시 시도하세요.`);
    throw new CatalogError(res.status, `${who}가 모델 목록 요청에 HTTP ${res.status}로 응답했습니다.`);
  }
  const j = (await res.json().catch(() => null)) as unknown;
  if (!j || typeof j !== "object") throw new CatalogError(res.status, `${LABEL[provider] ?? provider}의 모델 목록 응답을 읽지 못했습니다.`);
  return j as Record<string, unknown>;
}
