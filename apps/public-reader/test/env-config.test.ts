/** env validation (names only, never values), security headers / CSP, canonical origin. */
import { describe, expect, it } from "vitest";
import config, { API_CSP, SECURITY_HEADERS } from "../next.config";
import { buildPageCsp } from "../src/server/csp";
import { DEFAULT_PUBLIC_ORIGIN, parseEnv } from "../src/server/env";

describe("env", () => {
  it("defaults: public origin novel.snowlink.team, schema ncs_public, secure cookies, previews off", () => {
    const e = parseEnv({ DATABASE_URL: "postgresql://r:p@h:6543/postgres", IP_HASH_SECRET: "s".repeat(32) });
    expect(e).toMatchObject({ publicOrigin: "https://novel.snowlink.team", schema: "ncs_public", cookieSecure: true, allowPreviewOrigins: false, adminToken: null, problems: [] });
    expect(DEFAULT_PUBLIC_ORIGIN).toBe("https://novel.snowlink.team");
    expect(parseEnv({ POSTGRES_URL: "postgres://a:b@c/d" }).databaseUrl).toBe("postgres://a:b@c/d");
  });

  it("reports problems by variable name only", () => {
    const secretUrl = "mysql://user:TOPSECRETPW@host/db";
    const e = parseEnv({ DATABASE_URL: secretUrl, DB_SCHEMA: "public", PUBLIC_ORIGIN: "https://x.example/path", ADMIN_TOKEN: "shortADMINsecret", IP_HASH_SECRET: "tooShortIPsecret", COOKIE_SECURE: "maybe" });
    const text = e.problems.join("\n");
    for (const name of ["DATABASE_URL", "DB_SCHEMA", "PUBLIC_ORIGIN", "ADMIN_TOKEN", "IP_HASH_SECRET", "COOKIE_SECURE"]) expect(text).toContain(name);
    for (const v of ["TOPSECRETPW", "shortADMINsecret", "tooShortIPsecret", "x.example"]) expect(text).not.toContain(v);
    expect(e).toMatchObject({ databaseUrl: null, schema: "ncs_public", publicOrigin: DEFAULT_PUBLIC_ORIGIN, adminToken: null, ipHashSecret: null, cookieSecure: true });
  });

  it("parses BANNED_WORDS (normalized) and booleans", () => {
    const e = parseEnv({ BANNED_WORDS: " 금 칙어 , SPAM,, ", ALLOW_PREVIEW_ORIGINS: "true", COOKIE_SECURE: "false" });
    expect(e.bannedWords).toEqual(["금칙어", "spam"]);
    expect(e.allowPreviewOrigins).toBe(true);
    expect(e.cookieSecure).toBe(false);
  });
});

describe("security headers", () => {
  it("next.config: no x-powered-by, nosniff, referrer policy, no framing, permissions policy; API deny-all CSP", async () => {
    expect(config.poweredByHeader).toBe(false);
    const keys = SECURITY_HEADERS.map((h) => h.key);
    for (const k of ["X-Content-Type-Options", "Referrer-Policy", "X-Frame-Options", "Permissions-Policy"]) expect(keys).toContain(k);
    const rules = await config.headers!();
    expect(rules.find((r) => r.source === "/api/:path*")?.headers).toContainEqual({ key: "Content-Security-Policy", value: API_CSP });
    expect(API_CSP).toContain("frame-ancestors 'none'");
  });

  it("page CSP: nonce + strict-dynamic, no eval in production, no framing", () => {
    const csp = buildPageCsp("abc123", false);
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(buildPageCsp("n", true)).toContain("'unsafe-eval'");
  });
});
