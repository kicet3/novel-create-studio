import { describe, expect, it } from "vitest";
import {
  installConfigFromEnv,
  mergeConfigLayers,
  parseInstallConfig,
  resolveEmbeddedDataDir,
  effectiveTelegramReceiveMode,
  installConfigSchema,
} from "../src/config-schema.js";
import { DEFAULTS, defaultScope, formatUsd, usdToMicros } from "../src/defaults.js";

describe("defaults", () => {
  it("exposes 00 §7 keys verbatim", () => {
    expect(DEFAULTS["budget.novel_monthly_hard_limit_usd"]).toBe(80);
    expect(DEFAULTS["concept.session_budget_usd"]).toBe(6);
    expect(DEFAULTS["novel.default_narration_mode"]).toBe("third_limited");
    expect(defaultScope("run.max_concurrent_global")).toBe("install");
  });
  it("converts money to micro-USD integers", () => {
    expect(usdToMicros(80)).toBe(80_000_000);
    expect(usdToMicros(0.3)).toBe(300_000);
    expect(formatUsd(12_345_678)).toBe("$12.35");
  });
});

describe("InstallConfig", () => {
  it("applies defaults", () => {
    const c = parseInstallConfig({});
    expect(c.deployment_mode).toBe("local_trusted");
    expect(c.server.host).toBe("127.0.0.1");
    expect(c.server.port).toBe(3100);
    expect(c.database.mode).toBe("embedded");
    expect(c.database.embedded_port).toBe(54329);
    expect(resolveEmbeddedDataDir(c)).toBe("~/.ncs/data/pg");
    expect(c.llm.provider).toBe("anthropic");
    expect(effectiveTelegramReceiveMode(c)).toBe("polling");
  });
  it("layers env over file", () => {
    const merged = mergeConfigLayers(
      { server: { port: 4000 }, home: "/tmp/x" },
      installConfigFromEnv({ NCS_HOST: "100.64.0.5", NCS_PORT: "3200", DATABASE_URL: "postgres://u@h/db" }),
    );
    const c = parseInstallConfig(merged);
    expect(c.server.host).toBe("100.64.0.5");
    expect(c.server.port).toBe(3200);
    expect(c.database.mode).toBe("external");
    expect(resolveEmbeddedDataDir(c)).toBe("/tmp/x/data/pg");
  });
  it("maps the Claude API and Telegram base URL env overrides", () => {
    const c = parseInstallConfig(installConfigFromEnv({ NCS_ANTHROPIC_BASE_URL: "http://127.0.0.1:8082", NCS_TELEGRAM_API_BASE_URL: "http://127.0.0.1:8081" }));
    expect(c.llm.endpoints.anthropic_api_base_url).toBe("http://127.0.0.1:8082");
    expect(c.messaging.telegram_api_base_url).toBe("http://127.0.0.1:8081");
    expect(parseInstallConfig({}).llm.endpoints.anthropic_api_base_url).toBeUndefined();
  });
  it("falls back to anthropic for an LLM provider this version does not ship", () => {
    expect(parseInstallConfig({ llm: { provider: "retired-provider" } }).llm.provider).toBe("anthropic");
    expect(parseInstallConfig(installConfigFromEnv({ NCS_LLM_PROVIDER: "openai" })).llm.provider).toBe("openai");
  });
  it("remembers whether llm.provider was chosen (boot-time Claude subscription detection only when not)", () => {
    const d = parseInstallConfig({});
    expect(d.llm).toMatchObject({ provider: "anthropic", provider_explicit: false, claude_code: { max_concurrent: 2, call_timeout_seconds: 1200 } });
    expect(parseInstallConfig({ llm: { provider: "anthropic" } }).llm.provider_explicit).toBe(true);
    expect(parseInstallConfig({ llm: { provider: "claude_code" } }).llm).toMatchObject({ provider: "claude_code", provider_explicit: true });
    expect(parseInstallConfig(installConfigFromEnv({ NCS_LLM_PROVIDER: "claude_code", NCS_CLAUDE_MAX_CONCURRENT: "1" })).llm).toMatchObject({ provider: "claude_code", claude_code: { max_concurrent: 1 } });
    // an unknown value is treated as "not chosen"; re-parsing a parsed config keeps the flag
    expect(parseInstallConfig({ llm: { provider: "retired-provider" } }).llm.provider_explicit).toBe(false);
    expect(parseInstallConfig(parseInstallConfig({})).llm.provider_explicit).toBe(false);
  });
  it("dev mode: off by default, NCS_DEV_MODE=1|true turns it on", () => {
    expect(parseInstallConfig({}).dev_mode).toBe(false);
    expect(parseInstallConfig({ dev_mode: true }).dev_mode).toBe(true);
    for (const v of ["1", "true", "TRUE"]) expect(parseInstallConfig(installConfigFromEnv({ NCS_DEV_MODE: v })).dev_mode, v).toBe(true);
    for (const v of ["0", "false", "no"]) expect(parseInstallConfig(installConfigFromEnv({ NCS_DEV_MODE: v })).dev_mode, v).toBe(false);
    expect(installConfigFromEnv({})).not.toHaveProperty("dev_mode");
    // env wins over config.json
    expect(parseInstallConfig(mergeConfigLayers({ dev_mode: true }, installConfigFromEnv({ NCS_DEV_MODE: "0" }))).dev_mode).toBe(false);
  });
  it("enforces cross-validation rules", () => {
    expect(installConfigSchema.safeParse({ exposure: "public" }).success).toBe(false); // CFG-1
    expect(installConfigSchema.safeParse({ database: { mode: "external" } }).success).toBe(false); // CFG-5
    expect(installConfigSchema.safeParse({ messaging: { telegram_receive_mode: "webhook" } }).success).toBe(false); // CFG-4
  });
  it("CFG-1: local_trusted refuses wildcard / public binds, allows loopback, Tailscale and private (review regression)", () => {
    for (const host of ["0.0.0.0", "::", "8.8.8.8", "2001:4860::1"]) expect(installConfigSchema.safeParse({ server: { host } }).success, host).toBe(false);
    for (const host of ["127.0.0.1", "::1", "localhost", "100.75.75.99", "fd7a:115c:a1e0::1", "192.168.0.10", "10.1.2.3", "snowfall-macmini"]) {
      expect(installConfigSchema.safeParse({ server: { host } }).success, host).toBe(true);
    }
  });
});
