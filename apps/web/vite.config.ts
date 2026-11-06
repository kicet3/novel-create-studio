import { defineConfig, defaultClientConditions } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Dev:   http://${NCS_WEB_HOST:-127.0.0.1}:${NCS_WEB_PORT:-5173}, /api → NCS_API_URL (default http://127.0.0.1:${NCS_PORT:-3100}).
 * Build: apps/web/dist, served statically by @ncs/server in production.
 */
const apiTarget = process.env.NCS_API_URL ?? `http://127.0.0.1:${process.env.NCS_PORT ?? 3100}`;
const host = process.env.NCS_WEB_HOST ?? "127.0.0.1";
const port = Number(process.env.NCS_WEB_PORT ?? 5173);
// Extra Host header values Vite should accept (e.g. a Tailscale MagicDNS name), comma separated.
const allowedHosts = process.env.NCS_ALLOWED_HOSTNAMES?.split(",").map((s) => s.trim()).filter(Boolean);

const proxy = { "/api": { target: apiTarget, changeOrigin: false } };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // resolve workspace packages (@ncs/shared) to their TS sources, keeping Vite's default conditions
  resolve: { conditions: ["@ncs/source", ...defaultClientConditions] },
  server: { host, port, strictPort: true, proxy, allowedHosts },
  preview: { host, port: Number(process.env.NCS_WEB_PREVIEW_PORT ?? 4173), proxy, allowedHosts },
  build: { outDir: "dist", sourcemap: true, emptyOutDir: true },
});
