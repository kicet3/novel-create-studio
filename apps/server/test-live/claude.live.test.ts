/**
 * LIVE: the app against REAL Claude (opt-in, `pnpm test:live`; never part of `pnpm test`). Two lanes, each skipped with
 * a printed reason when unavailable:
 *  1. Claude API — the real AnthropicLlmAdapter → api.anthropic.com, when ANTHROPIC_API_KEY is set (the app reads it as
 *     its env fallback for `llm.anthropic.api_key`; the key is never printed). Production mode (API keys only).
 *     Model: NCS_LIVE_MODEL (default claude-haiku-5-5, to save cost).
 *  2. Claude subscription — dev mode on, the real unmodified `claude` CLI (`claude -p`), only when `claude auth status`
 *     reports loggedIn with authMethod "claude.ai". The app never reads CLI credential files nor starts a login.
 *     Model: NCS_LIVE_MODEL if set, else the default role binding.
 * Scenario: support/scenario.ts. Temp NCS_HOME + PGlite, random 127.0.0.1 port (never 3100).
 */
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_MODELS } from "@ncs/shared";
import { ClaudeCliLlmAdapter } from "../src/modules/llm/adapters/claude-cli/claude-cli-adapter.js";
import { createTestCore, type TestCore } from "../test/support/test-core.js";
import { printReport, runLiveScenario } from "./support/scenario.js";

const MODEL_OVERRIDE = process.env.NCS_LIVE_MODEL?.trim() || undefined;
const cores: TestCore[] = [];
afterAll(async () => {
  while (cores.length) await cores.pop()!.close();
});

// ── lane 1: Claude API ──
const apiKeyPresent = !!process.env.ANTHROPIC_API_KEY?.trim();
if (!apiKeyPresent) console.log("[live:claude-api] SKIPPED — ANTHROPIC_API_KEY is not set (set it to run the Claude API lane).");

describe.skipIf(!apiKeyPresent)("live: Claude API (AnthropicLlmAdapter → api.anthropic.com)", () => {
  it("concept turn → titles → brief approval → cast draft", async () => {
    const t = await createTestCore({
      devMode: false,
      anthropicKey: false, // the real key comes from ANTHROPIC_API_KEY (the app's env fallback), never a dummy
      config: { llm: { provider: "anthropic", endpoints: { anthropic_api_base_url: "https://api.anthropic.com" } } },
    });
    cores.push(t);
    const cred = await t.modules.llm.service.resolveCredential("anthropic");
    expect(cred?.method).toBe("api_key");
    const report = await runLiveScenario(t, "claude-api", { modelOverride: MODEL_OVERRIDE ?? DEFAULT_MODELS.haiku });
    printReport(report);
    expect(report.calls.every((c) => c.modelId === null || c.modelId === (MODEL_OVERRIDE ?? DEFAULT_MODELS.haiku))).toBe(true);
    expect(t.claude.requests.length).toBe(0); // nothing went to the local mock
  });
});

// ── lane 2: Claude subscription (claude -p) ──
const cli = new ClaudeCliLlmAdapter({ maxConcurrent: 1, callTimeoutMs: 20 * 60_000 });
const cliStatus = await cli.status(AbortSignal.timeout(30_000)).catch((err: unknown) => ({ installed: false, loggedIn: false, authMethod: null, message: (err as Error).message }));
const subscriptionReady = cliStatus.installed && cliStatus.loggedIn && cliStatus.authMethod === "claude.ai";
if (!subscriptionReady) {
  console.log(
    `[live:claude-subscription] SKIPPED — Claude Code CLI not usable with a subscription (installed=${cliStatus.installed}, loggedIn=${cliStatus.loggedIn}, authMethod=${cliStatus.authMethod ?? "none"}). Sign in yourself with the Claude Code CLI to run this lane.`,
  );
}

describe.skipIf(!subscriptionReady)("live: Claude subscription (dev mode, real `claude -p`)", () => {
  it("concept turn → titles → brief approval → cast draft", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    // the subscription lane must not fall back to an API key (the CLI child env drops it anyway)
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const t = await createTestCore({ devMode: true, anthropicKey: false, claudeCli: cli, config: { llm: { provider: "claude_code" } } });
      cores.push(t);
      expect(t.platform.config.llm.provider).toBe("claude_code");
      const report = await runLiveScenario(t, "claude-subscription", { modelOverride: MODEL_OVERRIDE });
      printReport(report);
      expect(t.claude.requests.length).toBe(0);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});
