import { defineConfig, defaultClientConditions } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * 독자용 읽기 사이트 (pure static SPA). Build: apps/public-reader/dist.
 * Dev: http://127.0.0.1:${PUBLIC_READER_DEV_PORT:-5180}; /api and /data are proxied to the reader server
 * (`pnpm --filter @ncs/public-reader serve`, default http://127.0.0.1:3200). Never proxies to the studio.
 * VITE_BASE: sub-path when hosted below the site root (default "/").
 */
const target = process.env.PUBLIC_READER_SERVER ?? "http://127.0.0.1:3200";

export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
  plugins: [react(), tailwindcss()],
  resolve: { conditions: ["@ncs/source", ...defaultClientConditions] },
  server: {
    host: "127.0.0.1",
    port: Number(process.env.PUBLIC_READER_DEV_PORT ?? 5180),
    strictPort: true,
    proxy: { "/api": { target }, "/data": { target } },
  },
  build: { outDir: "dist", sourcemap: false, emptyOutDir: true, assetsInlineLimit: 0 },
});
