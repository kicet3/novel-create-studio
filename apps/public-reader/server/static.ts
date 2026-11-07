/**
 * Static files: the built SPA (dist) and the snapshot (DATA_DIR under /data/). Path-traversal safe (decoded,
 * normalized, must stay inside the root, no dot segments / dotfiles), no directory listing, ETag + 304,
 * long cache for hashed /assets/, revalidation for HTML and data.
 */
import { createReadStream, readFileSync, realpathSync, statSync, type Stats } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json; charset=utf-8",
};

/**
 * URL path (without query) → absolute file path inside `root`, or null when it is not a safe, existing file.
 * Rejects: malformed escapes, NUL, backslashes, `..` / `.` segments, dot files, paths escaping the root.
 */
export function safeResolve(root: string, urlPath: string): { path: string; stat: Stats } | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const segments = decoded.split("/").filter((s) => s !== "");
  if (segments.some((s) => s === "." || s === ".." || s.startsWith("."))) return null;
  const base = resolve(root);
  const full = resolve(base, ...segments);
  if (full !== base && !full.startsWith(base + sep)) return null;
  try {
    // symlinks must not lead outside the root either
    const realBase = realpathSync(base);
    const real = realpathSync(full);
    if (real !== realBase && !real.startsWith(realBase + sep)) return null;
    const st = statSync(real);
    if (!st.isFile()) return null; // directories: no listing
    return { path: real, stat: st };
  } catch {
    return null;
  }
}

export const etagOf = (st: Stats) => `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;

export function sendFile(req: IncomingMessage, res: ServerResponse, file: { path: string; stat: Stats }, cacheControl: string): void {
  const type = TYPES[extname(file.path).toLowerCase()] ?? "application/octet-stream";
  const etag = etagOf(file.stat);
  res.setHeader("Content-Type", type);
  res.setHeader("Cache-Control", cacheControl);
  res.setHeader("ETag", etag);
  res.setHeader("Last-Modified", file.stat.mtime.toUTCString());
  if (req.headers["if-none-match"] === etag) {
    res.statusCode = 304;
    res.end();
    return;
  }
  res.statusCode = 200;
  res.setHeader("Content-Length", String(file.stat.size));
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(file.path).on("error", () => res.destroy()).pipe(res);
}

/** cache policy by path: hashed build assets are immutable; everything else revalidates */
export function cacheFor(urlPath: string): string {
  if (urlPath.startsWith("/assets/")) return "public, max-age=31536000, immutable";
  if (urlPath.startsWith("/data/")) return "public, max-age=0, must-revalidate";
  return "no-cache";
}

/** index.html template (read once; re-read when it changes on disk) */
export function htmlTemplate(staticDir: string): () => string | null {
  let cached: { key: string; html: string } | null = null;
  return () => {
    const p = join(staticDir, "index.html");
    try {
      const st = statSync(p);
      const key = `${st.mtimeMs}:${st.size}`;
      if (cached?.key !== key) cached = { key, html: readFileSync(p, "utf8") };
      return cached.html;
    } catch {
      return null;
    }
  };
}

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** per-page <title> / description / robots for crawlers that do not run scripts */
export function renderHtml(template: string, meta: { title: string; description: string; noindex?: boolean }): string {
  const desc = meta.description.replace(/\s+/g, " ").trim().slice(0, 160);
  let html = template.replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(meta.title)}</title>`);
  html = html.replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${escapeHtml(desc)}" />`);
  if (meta.noindex) html = html.replace("</head>", `  <meta name="robots" content="noindex" />\n  </head>`);
  return html;
}
