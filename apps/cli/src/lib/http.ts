/** Talks to a running server over HTTP (preferred when it is up: avoids a second writer). */
import { readLiveServerLock } from "@ncs/db";
import type { InstallConfig } from "@ncs/shared";

export function serverBaseUrl(config: InstallConfig): string {
  const host = config.server.host === "0.0.0.0" ? "127.0.0.1" : config.server.host === "::" ? "::1" : config.server.host;
  return `http://${host.includes(":") ? `[${host}]` : host}:${config.server.port}`;
}

/**
 * Is a server running for this install? The lock file (`run/server.lock`, 02 §2.3) is authoritative and
 * gives the real host/port (a server started with env-only NCS_HOST/NCS_PORT); the HTTP probe covers
 * servers that predate the lock file.
 */
export async function detectServer(config: InstallConfig, timeoutMs = 1500): Promise<{ running: boolean; version?: string; url: string; pid?: number }> {
  const holder = readLiveServerLock(config.home);
  const target = holder ? { ...config, server: { ...config.server, host: holder.host, port: holder.port } } : config;
  const url = serverBaseUrl(target);
  try {
    const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok && r.status !== 503) return holder ? { running: true, url, pid: holder.pid } : { running: false, url };
    const body = (await r.json().catch(() => ({}))) as { version?: string };
    return { running: true, version: body.version, url, ...(holder ? { pid: holder.pid } : {}) };
  } catch {
    return holder ? { running: true, url, pid: holder.pid } : { running: false, url };
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(config: InstallConfig, method: string, path: string, body?: unknown, timeoutMs = 10 * 60_000): Promise<T> {
  const r = await fetch(`${serverBaseUrl(config)}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  const json = text ? (JSON.parse(text) as unknown) : null;
  if (!r.ok) {
    const e = (json as { error?: { code?: string; message?: string } } | null)?.error;
    throw new HttpError(r.status, e?.code ?? "http_error", e?.message ?? `HTTP ${r.status}`);
  }
  return json as T;
}
