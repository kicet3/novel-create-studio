/**
 * Test helper: a full ServerCore (all modules, HTTP app) over a fresh migrated PGlite database.
 *
 *   const t = await createTestCore();
 *   const novel = await t.modules.novel.service.createNovel({}, t.owner);
 *   const res = await t.http("POST", "/api/novels", { title: "x" });
 *   await t.close();
 *
 * Background loops are NOT started (call `t.core.runtime.kick(name)` or service.runOnce()).
 * Home dir (storage, secrets key) is a temp dir removed on close().
 *
 * LLM: provider "anthropic" (the real AnthropicLlmAdapter) with a dummy key, pointed at a local scripted
 * Claude Messages API mock (`t.claude`). There is no fake model — a test that runs a model call states the
 * exact response with `t.claude.reply(...)`; unscripted requests fail (see support/scripted-claude.ts).
 * The Claude subscription lane (`claude_code`) runs over a scripted `claude` spawn (support/scripted-claude-cli.ts;
 * default: not installed) — the real Claude Code CLI is never started.
 *
 * Dev mode: like `node apps/server/dist/main.js`, the core boots in PRODUCTION mode by default (`dev_mode: false`:
 * API keys only). Tests of the subscription / OAuth methods (Claude subscription CLI, ChatGPT / xAI sign-in) pass
 * `devMode: true`, like `pnpm dev`.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createTestDb, type TestDb } from "@ncs/db/testing";
import { parseInstallConfig, type InstallConfigInput } from "@ncs/shared";
import { createServerCore, type ServerCore } from "../../src/app-core.js";
import { createLogger, type Clock, type Db } from "../../src/platform/index.js";
import { startScriptedClaude, type ScriptedClaude } from "./scripted-claude.js";
import { scriptedClaudeCli } from "./scripted-claude-cli.js";
import type { LlmAdapter } from "../../src/modules/llm/index.js";

/** dummy Claude API key used against the local scripted mock (never a real key) */
export const TEST_ANTHROPIC_KEY = "sk-ant-api03-test-scripted-claude-0000000000";

export interface TestCore {
  core: ServerCore;
  modules: ServerCore["modules"];
  platform: ServerCore["platform"];
  testDb: TestDb;
  /** local Claude Messages API mock: script model responses per test */
  claude: ScriptedClaude;
  ownerId: string;
  owner: { type: "user"; id: string };
  home: string;
  /** http://127.0.0.1:<port> of the in-process HTTP app (raw fetches, e.g. binary downloads) */
  base: string;
  /** JSON request against the in-process HTTP app */
  http<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }>;
  close(): Promise<void>;
}

export async function createTestCore(
  opts: {
    config?: InstallConfigInput;
    clock?: Clock;
    /** store the dummy Claude API key (default true) */
    anthropicKey?: boolean;
    /** InstallConfig dev_mode (default false = production: subscription / OAuth methods unavailable) */
    devMode?: boolean;
    /** Claude subscription lane (`claude_code`): a ClaudeCliLlmAdapter over a scripted spawn (default: CLI not installed) */
    claudeCli?: LlmAdapter;
  } = {},
): Promise<TestCore> {
  const testDb = await createTestDb();
  const claude = await startScriptedClaude();
  // the install home sits under a dot directory like the default `~/.ncs` (file downloads must still work there)
  const tmpRoot = mkdtempSync(join(tmpdir(), "ncs-test-"));
  const home = join(tmpRoot, ".ncs");
  mkdirSync(home);
  const config = parseInstallConfig({
    ...opts.config,
    dev_mode: opts.devMode ?? opts.config?.dev_mode ?? false,
    llm: { provider: "anthropic", ...opts.config?.llm, endpoints: { anthropic_api_base_url: claude.base, ...opts.config?.llm?.endpoints } },
    home,
    logging: { level: "silent" },
  });
  const core = createServerCore({
    config,
    appVersion: "test",
    db: testDb.db as unknown as Db,
    log: createLogger("silent"),
    databaseMode: "external",
    clock: opts.clock,
    // never the real `claude` executable in tests
    llmAdapters: [opts.claudeCli ?? scriptedClaudeCli().adapter],
  });
  await core.start({ background: false });
  const owner = (await core.modules.novel.service.getOwnerUser())!;
  if (opts.anthropicKey !== false) await core.modules.system.service.secrets.set("llm.anthropic.api_key", TEST_ANTHROPIC_KEY, "test key (scripted Claude mock)");
  const server = core.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    core,
    modules: core.modules,
    platform: core.platform,
    testDb,
    claude,
    ownerId: owner.id,
    owner: { type: "user", id: owner.id },
    home,
    base,
    async http(method, path, body) {
      const r = await fetch(base + path, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      const json = (r.headers.get("content-type") ?? "").includes("json");
      return { status: r.status, body: text ? (json ? JSON.parse(text) : text) : null };
    },
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      await core.stop(5_000);
      await testDb.close();
      await claude.close();
      rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}
