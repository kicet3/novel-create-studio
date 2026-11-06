/**
 * Real Telegram Bot API transport (ADR-011 fixed decision: direct `fetch`, no Chat SDK).
 * https://core.telegram.org/bots/api — every method is `POST /bot<token>/<method>` with a JSON body and
 * returns `{ ok, result }` or `{ ok:false, error_code, description, parameters?: { retry_after } }`.
 * The token is never logged or put into error messages.
 */
import type { TelegramTransport } from "../../index.js";
import { TelegramApiError } from "../../application/ports.js";

export function createFetchTelegramTransport(token: string, opts: { baseUrl?: string; fetchImpl?: typeof fetch } = {}): TelegramTransport {
  const base = opts.baseUrl ?? "https://api.telegram.org";
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    async call<T>(method: string, params: Record<string, unknown>, o: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error("timeout")), o.timeoutMs ?? 30_000);
      const onAbort = () => ac.abort(o.signal?.reason);
      o.signal?.addEventListener("abort", onAbort, { once: true });
      let sent = false;
      try {
        const res = await doFetch(`${base}/bot${token}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(params),
          signal: ac.signal,
        });
        sent = true;
        type ApiBody = { ok?: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } };
        const body: ApiBody | null = await res.json().then(
          (b) => b as ApiBody,
          () => null,
        );
        if (body?.ok) return body.result as T;
        throw new TelegramApiError(body?.error_code ?? res.status, body?.description ?? `HTTP ${res.status}`, body?.parameters?.retry_after);
      } catch (err) {
        if (err instanceof TelegramApiError) throw err;
        // aborted after the request may have reached Telegram → unknown delivery (INV-OUT-01)
        const aborted = ac.signal.aborted;
        const msg = (err instanceof Error ? err.message : String(err)).replaceAll(token, "<token>");
        throw new TelegramApiError(aborted || sent ? -1 : 0, aborted ? "request aborted or timed out" : msg);
      } finally {
        clearTimeout(timer);
        o.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
