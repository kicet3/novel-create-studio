/**
 * Claude subscription lane (provider `claude_code`, method `claude_cli`) end to end over the test core, with a
 * scripted `claude` spawn (support/scripted-claude-cli.ts) — the real Claude Code CLI is never started:
 * - GET /api/providers: Claude row with two methods, CLI status (installed / signed in / auth method);
 * - connect = switch on in the app + re-check, disconnect = switch off in the app (CLI login untouched);
 * - role binding → `claude -p` call: zero-priced ledger, CLI list-price estimate kept in provider_calls.usage;
 * - concurrency limit of `claude -p` processes; health check llm.claude_code;
 * - boot-time default-provider detection and rebinding of roles on unconnected providers.
 */
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { AUTH_STATUS_SUBSCRIPTION, cliResult, scriptedClaudeCli, type CliCall, type CliReply } from "../support/scripted-claude-cli.js";
import { runHandle, seedTaskRun } from "./support.js";

const isAuthStatus = (c: CliCall) => c.args[0] === "auth" && c.args[1] === "status";

/** `claude auth status` → signed in with a subscription; `claude -p` → `onPrompt` */
function signedInCli(onPrompt: (c: CliCall) => CliReply = () => ({ stdout: cliResult({ result: "응답" }) }), authStatus = AUTH_STATUS_SUBSCRIPTION, opts: { maxConcurrent?: number } = {}) {
  return scriptedClaudeCli((c) => (isAuthStatus(c) ? { stdout: authStatus } : onPrompt(c)), opts);
}

const cores: TestCore[] = [];
/** the subscription lane exists only in dev mode (`pnpm dev`): these suites boot like `pnpm dev` unless told otherwise */
const boot = async (opts: Parameters<typeof createTestCore>[0] = {}) => {
  const t = await createTestCore({ devMode: true, ...opts });
  cores.push(t);
  return t;
};
afterEach(async () => {
  while (cores.length) await cores.pop()!.close();
});

/** runs `fn` with ANTHROPIC_API_KEY unset (a developer machine may have one) */
async function withoutEnvKey<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    return await fn();
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
}

async function claudeCodeProfileId(t: TestCore): Promise<string> {
  const r = await t.http("GET", "/api/llm/provider-profiles");
  return r.body.items.find((p: { provider: string; providerKind: string }) => p.provider === "claude_code" && p.providerKind === "llm").id;
}

describe("Claude subscription (Claude Code CLI) lane", () => {
  it("Claude row: two methods, CLI status, connect/disconnect only switch the method in the app", async () => {
    const cli = signedInCli();
    const t = await withoutEnvKey(() => boot({ anthropicKey: false, claudeCli: cli.adapter }));
    await withoutEnvKey(async () => {
      const r = await t.http("GET", "/api/providers?refresh=1");
      expect(r.status).toBe(200);
      const claude = r.body.items[0];
      expect(claude).toMatchObject({ provider: "anthropic", connected: true, activeMethod: "claude_cli", health: "healthy", unsupported: [] });
      expect(claude.methods.map((m: { method: string; configured: boolean }) => [m.method, m.configured])).toEqual([
        ["claude_cli", true],
        ["api_key", false],
      ]);
      expect(claude.methods[0].note).toContain("앱은 로그인 정보를 읽거나 저장하지 않습니다");
      expect(claude.methods[0].note).toContain("자동 연재처럼 호출이 많으면 한도에 빨리 닿을 수 있습니다");
      expect(claude.claudeCli).toMatchObject({ installed: true, loggedIn: true, authMethod: "claude.ai", enabled: true, usable: true });
      expect(JSON.stringify(r.body)).not.toMatch(/구독 로그인은|약관상 외부 앱에서 지원하지/);

      const off = await t.http("DELETE", "/api/providers/anthropic/connection?method=claude_cli");
      expect(off.status).toBe(200);
      expect(off.body).toMatchObject({ connected: false, activeMethod: null, claudeCli: { enabled: false, usable: false, loggedIn: true } });
      const test = await t.http("POST", "/api/providers/anthropic/test", { method: "claude_cli" });
      expect(test.body).toMatchObject({ provider: "claude_code", status: "fail", errorFamily: "auth_failed" });

      const on = await t.http("POST", "/api/providers/anthropic/claude-cli");
      expect(on.body).toMatchObject({ connected: true, activeMethod: "claude_cli", claudeCli: { enabled: true, usable: true } });
      const test2 = await t.http("POST", "/api/providers/anthropic/test", { method: "claude_cli" });
      expect(test2.body).toMatchObject({ provider: "claude_code", status: "pass" });

      const sw = await t.http("PUT", "/api/providers/anthropic/active-method", { method: "claude_cli" });
      expect(sw.status).toBe(422);
      const act = await t.http("GET", "/api/activity?actionPrefix=secret.");
      expect(act.body.items.filter((a: { targetId: string }) => a.targetId === "secret.llm.claude_code.enabled").length).toBe(2);
    });
    // the app only ever ran `claude auth status` and `claude -p` (never a login, never a credential read)
    expect(cli.spawn.calls.every((c) => isAuthStatus(c) || c.args[0] === "-p")).toBe(true);
    expect(cli.spawn.calls.some((c) => c.args.includes("login"))).toBe(false);
  });

  it("not signed in / signed in with an API key: not usable, the UI gets the terminal instruction", async () => {
    const out = scriptedClaudeCli((c) => (isAuthStatus(c) ? { stdout: JSON.stringify({ loggedIn: false }) } : { code: 1 }));
    const t = await boot({ anthropicKey: false, claudeCli: out.adapter });
    const r = await withoutEnvKey(() => t.http("GET", "/api/providers"));
    expect(r.body.items[0].claudeCli).toMatchObject({ installed: true, loggedIn: false, usable: false });
    expect(r.body.items[0].claudeCli.message).toContain("claude auth login");
    expect(r.body.items[0].methods[0].configured).toBe(false);

    const console = signedInCli(undefined, JSON.stringify({ loggedIn: true, authMethod: "console" }));
    const t2 = await boot({ anthropicKey: false, claudeCli: console.adapter });
    const r2 = await withoutEnvKey(() => t2.http("GET", "/api/providers"));
    expect(r2.body.items[0]).toMatchObject({ health: "warning", connected: false, claudeCli: { loggedIn: true, authMethod: "console", usable: false } });
  });

  it("role bound to claude_code runs `claude -p`; ledger amount 0, the CLI list-price estimate stays in the call usage", async () => {
    const Schema = z.object({ title: z.string() });
    const cli = signedInCli((c) => ({ stdout: cliResult({ total_cost_usd: 0.4321, structured_output: { title: c.args[c.args.indexOf("--model") + 1]! } }) }));
    const t = await boot({ claudeCli: cli.adapter });
    const novelId = (await t.modules.novel.service.createNovel({}, t.owner)).id;
    const bind = await t.http("PATCH", `/api/novels/${novelId}/model-bindings/writer`, { providerProfileId: await claudeCodeProfileId(t), modelId: "claude-sonnet-5-5" });
    expect(bind.status).toBe(200);

    const { taskId, runId } = await seedTaskRun(t, novelId);
    const out = await t.modules.llm.service.modelCalls.call({
      run: runHandle(novelId, taskId, runId, "writer"),
      purpose: "x",
      system: "s",
      messages: [{ role: "user", content: "가제" }],
      output: { kind: "object", schemaName: "T", schema: Schema },
    });
    expect(out.value).toEqual({ title: "claude-sonnet-5-5" });
    expect(out.costMicros).toBe(0);
    expect(t.claude.requests.length).toBe(0); // nothing went to the Claude API
    const prompt = cli.spawn.calls.find((c) => c.args[0] === "-p")!;
    expect(prompt.stdin).toBe("가제");
    expect(prompt.env.ANTHROPIC_API_KEY).toBeUndefined();

    if (t.modules.budget.implemented) {
      const calls = await t.http("GET", `/api/novels/${novelId}/runs/${runId}/provider-calls`);
      expect(calls.body.items[0]).toMatchObject({ provider: "claude_code", modelId: "claude-sonnet-5-5", maxCostMicros: 0, usage: { reportedCostMicros: 432_100 } });
      const events = await t.modules.budget.service.listCostEvents({ novelId }, { runId });
      expect(events.reduce((s, e) => s + Number(e.amountMicros), 0)).toBe(0);
      const usage = await t.modules.llm.service.runUsage({ novelId }, runId);
      expect(usage).toMatchObject({ calls: 1, costMicros: 0, subscriptionEstimateMicros: 432_100 });
    }
  });

  it("at most `maxConcurrent` `claude -p` processes run at once; the rest wait for a slot", async () => {
    const cli = signedInCli(() => ({ stdout: cliResult({ result: "ok" }), delayMs: 40 }), undefined, { maxConcurrent: 2 });
    const t = await boot({ claudeCli: cli.adapter });
    const novelId = (await t.modules.novel.service.createNovel({}, t.owner)).id;
    await t.http("PATCH", `/api/novels/${novelId}/model-bindings/writer`, { providerProfileId: await claudeCodeProfileId(t), modelId: "claude-opus-5-5" });
    const runs = await Promise.all([0, 1, 2, 3, 4].map(() => seedTaskRun(t, novelId)));
    const outs = await Promise.all(
      runs.map((r, i) =>
        t.modules.llm.service.modelCalls.call({ run: runHandle(novelId, r.taskId, r.runId, "writer"), purpose: "x", system: "s", messages: [{ role: "user", content: `p${i}` }], output: { kind: "text" } }),
      ),
    );
    expect(outs.map((o) => o.value)).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    expect(cli.spawn.calls.filter((c) => c.args[0] === "-p").length).toBe(5);
    expect(cli.spawn.maxRunning).toBeLessThanOrEqual(2);
  });

  it("health check llm.claude_code runs while the CLI is signed in with a subscription", async () => {
    const t = await boot({ claudeCli: signedInCli().adapter });
    const h = await t.modules.system.service.runHealthChecks({ kinds: ["llm_key"] });
    expect(h.find((x) => x.name === "llm.claude_code")).toMatchObject({ status: "pass" });

    const t2 = await boot({});
    const h2 = await t2.modules.system.service.runHealthChecks({ kinds: ["llm_key"] });
    expect(h2.map((x) => x.name)).not.toContain("llm.claude_code");
  });
});

describe("boot-time default provider detection", () => {
  it("no provider chosen + no Anthropic key + CLI signed in with a subscription → claude_code; roles on unconnected providers move", async () => {
    await withoutEnvKey(async () => {
      const t = await boot({ anthropicKey: false, claudeCli: signedInCli().adapter, config: { llm: { provider: undefined } } });
      expect(t.platform.config.llm.provider).toBe("claude_code");
      const info = await t.http("GET", "/api/system/info");
      expect(info.body.llmProvider).toBe("claude_code");
      const st = await t.http("GET", "/api/providers");
      expect(st.body.items[0].isDefault).toBe(true);

      const novelId = (await t.modules.novel.service.createNovel({}, t.owner)).id;
      const ccId = await claudeCodeProfileId(t);
      const bindings = await t.http("GET", `/api/novels/${novelId}/model-bindings`);
      expect(bindings.body.items.every((b: { providerProfileId: string; modelId: string }) => b.providerProfileId === ccId && b.modelId === "claude-opus-5-5")).toBe(true);

      // a role moved to a provider without a connection is moved back on the next boot
      const profiles = (await t.http("GET", "/api/llm/provider-profiles")).body.items as Array<{ id: string; provider: string; providerKind: string }>;
      const openai = profiles.find((p) => p.provider === "openai" && p.providerKind === "llm")!;
      await t.http("PATCH", `/api/novels/${novelId}/model-bindings/planner`, { providerProfileId: openai.id, modelId: "gpt-6.1-sol" });
      await t.modules.llm.start!();
      const after = await t.http("GET", `/api/novels/${novelId}/model-bindings`);
      expect(after.body.items.find((b: { agentRole: string }) => b.agentRole === "planner")).toMatchObject({ providerProfileId: ccId, modelId: "claude-opus-5-5" });
      // profiles are not deactivated (the user can connect GPT later)
      const again = (await t.http("GET", "/api/llm/provider-profiles")).body.items as Array<{ id: string; isActive: boolean }>;
      expect(again.find((p) => p.id === openai.id)!.isActive).toBe(true);
    });
  });

  it("signed out at boot, signed in later: [연결]/상태 새로고침 makes claude_code the default without a restart", async () => {
    await withoutEnvKey(async () => {
      let signedIn = false;
      const cli = scriptedClaudeCli((c) =>
        isAuthStatus(c) ? { stdout: signedIn ? AUTH_STATUS_SUBSCRIPTION : JSON.stringify({ loggedIn: false }) } : { stdout: cliResult({ result: "응답" }) },
      );
      const t = await boot({ anthropicKey: false, claudeCli: cli.adapter, config: { llm: { provider: undefined } } });
      expect(t.platform.config.llm.provider).toBe("anthropic");
      const before = (await t.modules.novel.service.createNovel({}, t.owner)).id;

      signedIn = true; // the user ran `claude auth login` in a terminal
      const on = await t.http("POST", "/api/providers/anthropic/claude-cli");
      expect(on.body).toMatchObject({ connected: true, activeMethod: "claude_cli", isDefault: true });
      expect(t.platform.config.llm.provider).toBe("claude_code");

      const ccId = await claudeCodeProfileId(t);
      const after = (await t.modules.novel.service.createNovel({}, t.owner)).id;
      for (const id of [before, after]) {
        const b = await t.http("GET", `/api/novels/${id}/model-bindings`);
        expect(b.body.items.every((x: { providerProfileId: string }) => x.providerProfileId === ccId)).toBe(true);
      }
      // the Anthropic API-key health check is no longer active (no key, not the default)
      const results = await t.modules.system.service.runHealthChecks({ names: ["llm.anthropic", "llm.claude_code"], record: false });
      expect(JSON.stringify(results)).not.toContain("Anthropic API 키가 등록되지 않았습니다");
      expect(results.some((r) => r.status === "pass")).toBe(true);
    });
  });

  it("an explicit llm.provider, an Anthropic API key or a non-subscription CLI login keeps anthropic", async () => {
    await withoutEnvKey(async () => {
      const explicit = await boot({ anthropicKey: false, claudeCli: signedInCli().adapter });
      expect(explicit.platform.config.llm.provider).toBe("anthropic");

      process.env.ANTHROPIC_API_KEY = "sk-ant-api03-env-key-for-detection-test";
      try {
        const withKey = await boot({ anthropicKey: false, claudeCli: signedInCli().adapter, config: { llm: { provider: undefined } } });
        expect(withKey.platform.config.llm.provider).toBe("anthropic");
      } finally {
        delete process.env.ANTHROPIC_API_KEY;
      }

      const consoleLogin = await boot({ anthropicKey: false, claudeCli: signedInCli(undefined, JSON.stringify({ loggedIn: true, authMethod: "console" })).adapter, config: { llm: { provider: undefined } } });
      expect(consoleLogin.platform.config.llm.provider).toBe("anthropic");

      const missing = await boot({ anthropicKey: false, config: { llm: { provider: undefined } } });
      expect(missing.platform.config.llm.provider).toBe("anthropic");
    });
  });
});

describe("createSlotLimiter", () => {
  it("FIFO slots; a waiter whose signal aborts gives up without taking a slot", async () => {
    const { createSlotLimiter } = await import("../../src/modules/llm/application/gateway.js");
    const l = createSlotLimiter(1);
    const never = new AbortController().signal;
    expect(await l.acquire(never)).toBe(true);
    const ac = new AbortController();
    const aborted = l.acquire(ac.signal);
    const next = l.acquire(never);
    expect(l.waiting).toBe(2);
    ac.abort();
    expect(await aborted).toBe(false);
    l.release();
    expect(await next).toBe(true);
    expect(l.busy).toBe(1);
    l.release();
    expect(l.busy).toBe(0);
  });
});
