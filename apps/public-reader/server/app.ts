/**
 * 독자 사이트 HTTP handler (node:http, no framework): security headers on every response, /api/… (reader API),
 * /data/… (the published snapshot, read-only JSON), the built SPA with SPA fallback and per-page <title>/description.
 * It shares no code, database, config or secrets with the studio server.
 */
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { createApi, type ApiOptions } from "./api.js";
import { createCatalog, isSlug, type Catalog } from "./catalog.js";
import { RateLimiter } from "./rate-limit.js";
import { cacheFor, htmlTemplate, renderHtml, safeResolve, sendFile } from "./static.js";
import type { Db } from "./store.js";

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

export interface AppOptions extends Omit<ApiOptions, "catalog" | "limiter" | "db"> {
  db: Db;
  /** published snapshot folder (novels.json, novels/<slug>/…) */
  dataDir: string;
  /** built SPA (vite build → dist) */
  staticDir: string;
  siteName?: string;
  limiter?: RateLimiter;
}

export interface App {
  handler: RequestListener;
  catalog: Catalog;
}

const SITE_DESC = "공개된 연재 소설을 읽는 곳입니다.";

export function createApp(o: AppOptions): App {
  const catalog = createCatalog(o.dataDir);
  const api = createApi({ ...o, catalog, limiter: o.limiter ?? new RateLimiter(o.now) });
  const template = htmlTemplate(o.staticDir);
  const siteName = o.siteName ?? "연재 읽기";

  /** <title> / description for an SPA route (only published things are ever named) */
  function metaFor(path: string): { title: string; description: string; noindex?: boolean; status: number } {
    if (path === "/" || path === "") return { title: siteName, description: SITE_DESC, status: 200 };
    if (path === "/admin") return { title: `운영 · ${siteName}`, description: SITE_DESC, noindex: true, status: 200 };
    const m = /^\/novels\/([^/]+)(?:\/(\d{1,6}))?\/?$/.exec(path);
    if (m) {
      const novel = isSlug(m[1]!) ? catalog.novel(m[1]!) : null;
      if (novel) {
        if (!m[2]) return { title: `${novel.title} · ${siteName}`, description: novel.intro || `${novel.title} — 공개된 ${novel.episodes.length}화`, status: 200 };
        const ep = novel.episodes.find((e) => e.episodeNo === Number(m[2]));
        if (ep) return { title: `${novel.title} ${ep.episodeNo}화${ep.title ? ` · ${ep.title}` : ""} · ${siteName}`, description: novel.intro || novel.title, status: 200 };
      }
    }
    return { title: `찾을 수 없음 · ${siteName}`, description: SITE_DESC, noindex: true, status: 404 };
  }

  function notFound(res: ServerResponse, text = "Not found"): void {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(text);
  }

  const handler: RequestListener = (req: IncomingMessage, res: ServerResponse) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const method = req.method ?? "GET";
    let path: string;
    try {
      path = new URL(req.url ?? "/", "http://x").pathname;
    } catch {
      res.statusCode = 400;
      return void res.end();
    }

    if (path === "/api" || path.startsWith("/api/")) {
      void api(req, res, path);
      return;
    }
    if (method !== "GET" && method !== "HEAD") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET, HEAD");
      return void res.end();
    }
    if (path.startsWith("/data/")) {
      const file = safeResolve(o.dataDir, path.slice("/data".length));
      if (!file || !file.path.endsWith(".json")) return notFound(res);
      return sendFile(req, res, file, cacheFor(path));
    }
    if (path !== "/" && path !== "/index.html") {
      const file = safeResolve(o.staticDir, path);
      if (file) return sendFile(req, res, file, cacheFor(path));
      // a missing asset (has an extension) is a real 404; anything else is an SPA route
      if (/\.[a-z0-9]{1,8}$/i.test(path)) return notFound(res);
    }
    const html = template();
    if (!html) return notFound(res, "앱이 빌드되지 않았습니다 (pnpm --filter @ncs/public-reader build).");
    const meta = metaFor(path === "/index.html" ? "/" : path);
    const body = renderHtml(html, meta);
    res.statusCode = meta.status;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Content-Length", String(Buffer.byteLength(body)));
    res.end(method === "HEAD" ? undefined : body);
  };

  return { handler, catalog };
}
