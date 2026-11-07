/**
 * `pnpm --filter @ncs/public-reader serve` — the reader site on its own small Node server.
 *
 *   HOST          bind address (default 127.0.0.1 — loopback only; exposing it publicly is a manual decision)
 *   PORT          default 3200
 *   DATA_DIR      published snapshot (default $NCS_HOME/public-site/data, NCS_HOME default ~/.ncs)
 *   DB_PATH       reader accounts / likes / ratings / comments SQLite file (default <DATA_DIR>/../reader.db)
 *   STATIC_DIR    built SPA (default ../dist next to this file)
 *   ADMIN_TOKEN   enables /admin (comment moderation) — unset = disabled. Use a long random value.
 *   PUBLIC_ORIGIN exact origin(s) allowed to POST, comma separated (e.g. https://reader.example.com)
 *   COOKIE_SECURE 1 → Secure cookies (set when served over https)
 *   TRUST_PROXY   1 → take the client IP from X-Forwarded-For (only behind your own reverse proxy)
 *
 * Reads no studio config, env file or secret. Node ≥ 22.5 (node:sqlite).
 */
import { createServer, type IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { openStore } from "./store.js";

const env = process.env;
const expand = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
const home = expand(env.NCS_HOME?.trim() || "~/.ncs");
const dataDir = resolve(expand(env.DATA_DIR?.trim() || join(home, "public-site", "data")));
const dbPath = resolve(expand(env.DB_PATH?.trim() || join(dataDir, "..", "reader.db")));
const here = dirname(fileURLToPath(import.meta.url));
const staticDir = resolve(expand(env.STATIC_DIR?.trim() || join(here, "..", "dist")));
const host = env.HOST?.trim() || "127.0.0.1";
const port = Number(env.PORT ?? 3200);
const trustProxy = /^(1|true|yes|on)$/i.test(env.TRUST_PROXY ?? "");
const allowedOrigins = (env.PUBLIC_ORIGIN ?? "")
  .split(",")
  .map((s) => s.trim().replace(/\/+$/, ""))
  .filter(Boolean);
const secureCookies = /^(1|true|yes|on)$/i.test(env.COOKIE_SECURE ?? "") || allowedOrigins.some((o) => o.startsWith("https://"));
const adminToken = env.ADMIN_TOKEN?.trim() || undefined;
if (adminToken && adminToken.length < 24) {
  console.error("[public-reader] ADMIN_TOKEN must be at least 24 characters — admin stays disabled.");
}

const clientIp = (req: IncomingMessage) => {
  if (trustProxy) {
    const xff = String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim();
    if (xff) return xff;
  }
  return req.socket.remoteAddress ?? "unknown";
};

const db = openStore(dbPath);
const { handler } = createApp({
  db,
  dataDir,
  staticDir,
  adminToken: adminToken && adminToken.length >= 24 ? adminToken : undefined,
  allowedOrigins,
  secureCookies,
  clientIp,
});
const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, handler);
server.listen(port, host, () => {
  console.log(`[public-reader] http://${host}:${port}  data=${dataDir}  admin=${adminToken && adminToken.length >= 24 ? "on" : "off"}`);
});
const stop = () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
