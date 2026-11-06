/**
 * Real Discord REST transport (API v10) over `fetch`. https://discord.com/developers/docs/reference
 * Errors: `{ code, message }` JSON with the HTTP status; 429 carries `retry_after` (seconds, fractional) in the
 * body and the `Retry-After` header. The token is only ever put into the Authorization header and is scrubbed
 * from error messages; it is never logged.
 */
import type { DiscordTransport } from "../../index.js";
import { DiscordApiError } from "../../application/ports.js";

export const DISCORD_API_BASE = "https://discord.com/api/v10";

export function createFetchDiscordTransport(token: string, opts: { baseUrl?: string; fetchImpl?: typeof fetch } = {}): DiscordTransport {
  const base = (opts.baseUrl ?? DISCORD_API_BASE).replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    async request<T>(method: string, path: string, body?: unknown, o: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error("timeout")), o.timeoutMs ?? 30_000);
      const onAbort = () => ac.abort(o.signal?.reason);
      o.signal?.addEventListener("abort", onAbort, { once: true });
      let sent = false;
      try {
        const res = await doFetch(`${base}${path}`, {
          method,
          headers: {
            authorization: `Bot ${token}`,
            "user-agent": "DiscordBot (https://github.com/novel-create-studio, 0.1)",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: ac.signal,
        });
        sent = true;
        if (res.status === 204) return null as T;
        type ErrBody = { code?: number; message?: string; retry_after?: number };
        const json: unknown = await res.json().catch(() => null);
        if (res.ok) return json as T;
        const e = (json ?? {}) as ErrBody;
        const headerRetry = Number(res.headers.get("retry-after"));
        const retryAfter = res.status === 429 ? (e.retry_after ?? (Number.isFinite(headerRetry) && headerRetry > 0 ? headerRetry : 1)) : undefined;
        throw new DiscordApiError(res.status, e.message ?? `HTTP ${res.status}`, retryAfter, e.code);
      } catch (err) {
        if (err instanceof DiscordApiError) throw err;
        const aborted = ac.signal.aborted;
        const msg = (err instanceof Error ? err.message : String(err)).replaceAll(token, "<token>");
        throw new DiscordApiError(aborted || sent ? -1 : 0, aborted ? "request aborted or timed out" : msg);
      } finally {
        clearTimeout(timer);
        o.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

/** default Gateway socket: Node ≥ 22 global WebSocket (no extra dependency). */
export function createNativeDiscordSocket(url: string, h: { onOpen(): void; onMessage(data: string): void; onClose(code: number, reason: string): void }) {
  const ws = new WebSocket(url);
  let closed = false;
  ws.onopen = () => h.onOpen();
  ws.onmessage = (ev) => {
    const d = ev.data;
    if (typeof d === "string") h.onMessage(d);
    else if (d instanceof ArrayBuffer) h.onMessage(new TextDecoder().decode(d));
  };
  ws.onclose = (ev) => {
    if (closed) return;
    closed = true;
    h.onClose(ev.code, ev.reason);
  };
  ws.onerror = () => {
    /* onclose follows */
  };
  return {
    send: (data: string) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    },
    close: (code?: number, reason?: string) => {
      try {
        ws.close(code ?? 1000, reason);
      } catch {
        ws.close();
      }
    },
  };
}
