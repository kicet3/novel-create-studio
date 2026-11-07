/**
 * snowpage — Next.js config. Security headers for every route (the per-request nonce CSP for pages is set in
 * proxy.ts; API responses get a deny-all CSP here). Workspace packages (@ncs/reader-core, @ncs/public-schema) are
 * consumed as built JS (their `dist`, built before `next build` — see package.json / vercel.json).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = join(here, "..", "..");

export const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=(), interest-cohort=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
] as const;

export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  serverExternalPackages: ["postgres"],
  outputFileTracingRoot: monorepoRoot,
  turbopack: { root: monorepoRoot },
  async headers() {
    return [
      { source: "/:path*", headers: [...SECURITY_HEADERS] },
      { source: "/api/:path*", headers: [{ key: "Content-Security-Policy", value: API_CSP }, { key: "X-Robots-Tag", value: "noindex" }] },
    ];
  },
};

export default config;
