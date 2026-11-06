/**
 * Production gating of the subscription / OAuth connection methods (InstallConfig `dev_mode` false — the default,
 * like `node apps/server/dist/main.js`): Claude subscription (`claude_cli` → provider `claude_code`), ChatGPT sign-in,
 * xAI sign-in are listed as `dev_only`, their routes answer 422 `oauth_dev_only`, stored OAuth sessions are ignored for
 * calls (kept, not deleted), no boot-time switch to the subscription, no `claude` spawn, no `llm.claude_code` check.
 */
import { afterEach, describe, expect, it } from "vitest";
import { roleModelBindings } from "@ncs/db/schema";
import { eq } from "@ncs/db/orm";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { AUTH_STATUS_SUBSCRIPTION, cliResult, scriptedClaudeCli } from "../support/scripted-claude-cli.js";
import { fakeJwt } from "./mock-http.js";

const ACCOUNT = "acct_prod_1";
/** Codex auth.json-compatible ChatGPT session (dummy tokens) */
const chatgptSession = () =>
  JSON.stringify({
    tokens: {
      id_token: fakeJwt({ email: "me@example.com", "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT, chatgpt_plan_type: "plus" } }),
      access_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT } }),
      refresh_token: "rt_dummy",
      account_id: ACCOUNT,
    },
    last_refresh: new Date().toISOString(),
  });

/** a signed-in (subscription) scripted `claude`; every spawn is recorded */
const signedInCli = () => scriptedClaudeCli((c) => (c.args[0] === "auth" ? { stdout: AUTH_STATUS_SUBSCRIPTION } : { stdout: cliResult({ result: "응답" }) }));

const cores: TestCore[] = [];
const boot = async (opts: Parameters<typeof createTestCore>[0] = {}) => {
  const t = await createTestCore(opts);
  cores.push(t);
  return t;
};
afterEach(async () => {
  while (cores.length) await cores.pop()!.close();
});

async function withoutEnvKeys<T>(fn: () => Promise<T>): Promise<T> {
  const names = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "XAI_API_KEY"];
  const saved = names.map((n) => [n, process.env[n]] as const);
  for (const n of names) delete process.env[n];
  try {
    return await fn();
  } finally {
    for (const [n, v] of saved) if (v !== undefined) process.env[n] = v;
  }
}

const profileOf = async (t: TestCore, provider: string) =>
  ((await t.http("GET", "/api/llm/provider-profiles")).body.items as Array<{ id: string; provider: string; providerKind: string; isActive: boolean }>).find(
    (p) => p.provider === provider && p.providerKind === "llm" && p.isActive,
  )!;

describe("production (dev_mode false): subscription / OAuth methods", () => {
  it("default boot is production; system info exposes devMode", async () => {
    const t = await boot();
    expect(t.platform.config.dev_mode).toBe(false);
    expect((await t.http("GET", "/api/system/info")).body).toMatchObject({ devMode: false });
    const dev = await boot({ devMode: true });
    expect((await dev.http("GET", "/api/system/info")).body).toMatchObject({ devMode: true });
  });

  it("GET /api/providers lists the OAuth methods as dev_only (API-key methods available); `claude` is never spawned", async () => {
    await withoutEnvKeys(async () => {
      const cli = signedInCli();
      const t = await boot({ anthropicKey: false, claudeCli: cli.adapter, config: { llm: { provider: undefined } } });
      const r = await t.http("GET", "/api/providers?refresh=1");
      expect(r.status).toBe(200);
      const methods = (r.body.items as Array<{ provider: string; methods: Array<{ method: string; availability: string; unavailableReason: string | null }> }>).flatMap((p) =>
        p.methods.map((m) => ({ provider: p.provider, ...m })),
      );
      for (const m of methods) {
        if (m.method === "api_key") expect(m, `${m.provider}`).toMatchObject({ availability: "available", unavailableReason: null });
        else {
          expect(m, `${m.provider}.${m.method}`).toMatchObject({ availability: "dev_only" });
          expect(m.unavailableReason).toContain("개발 모드에서만");
          expect(m.unavailableReason).toContain("NCS_DEV_MODE=1");
        }
      }
      expect(methods.filter((m) => m.availability === "dev_only").map((m) => m.method).sort()).toEqual(["chatgpt_oauth", "claude_cli", "xai_oauth"]);
      const claude = r.body.items[0];
      expect(claude).toMatchObject({ provider: "anthropic", connected: false, activeMethod: null, claudeCli: { usable: false } });
      // no boot-time switch to the subscription, no `claude auth status`, no health check llm.claude_code
      expect(t.platform.config.llm.provider).toBe("anthropic");
      const health = await t.modules.system.service.runHealthChecks({ kinds: ["llm_key"], record: false });
      expect(health.map((h) => h.name)).not.toContain("llm.claude_code");
      expect(await t.modules.llm.service.applyClaudeSubscriptionDefault({ refreshCli: true })).toBe(false);
      expect(cli.spawn.calls).toEqual([]);
    });
  });

  it("routes that start a login, import Codex, enable the CLI or test / switch to an OAuth method → 422 oauth_dev_only", async () => {
    const cli = signedInCli();
    const t = await boot({ claudeCli: cli.adapter });
    const reqs: Array<[string, string, unknown?]> = [
      ["POST", "/api/providers/anthropic/claude-cli"],
      ["POST", "/api/providers/openai/oauth", { flow: "browser" }],
      ["POST", "/api/providers/openai/oauth", { flow: "device" }],
      ["POST", "/api/providers/xai/oauth", { flow: "device" }],
      ["POST", "/api/providers/openai/import-codex"],
      ["POST", "/api/providers/anthropic/test", { method: "claude_cli" }],
      ["POST", "/api/providers/openai/test", { method: "chatgpt_oauth" }],
      ["POST", "/api/providers/xai/test", { method: "xai_oauth" }],
      ["PUT", "/api/providers/openai/active-method", { method: "chatgpt_oauth" }],
      ["PUT", "/api/providers/xai/active-method", { method: "xai_oauth" }],
      ["POST", "/api/llm/test", { provider: "claude_code" }],
    ];
    for (const [method, path, body] of reqs) {
      const r = await t.http(method, path, body);
      expect({ path, body, status: r.status, code: r.body?.error?.code }).toEqual({ path, body, status: 422, code: "oauth_dev_only" });
      expect(r.body.error.message).toContain("개발 모드에서만");
    }
    // API-key routes are unaffected
    expect((await t.http("PUT", "/api/providers/openai/api-key", { apiKey: "sk-test-openai-dummy-key-000" })).status).toBe(200);
    expect(cli.spawn.calls).toEqual([]);
  });

  it("a stored ChatGPT session is ignored for calls (kept, works again in dev mode); an API key still connects", async () => {
    await withoutEnvKeys(async () => {
      const t = await boot();
      await t.modules.system.service.secrets.set("llm.openai.oauth_session", chatgptSession(), "ChatGPT 로그인 세션");
      await t.modules.system.service.secrets.set("llm.openai.active_method", "chatgpt_oauth", "AI 연결 방식 선택");

      expect(await t.modules.llm.service.resolveCredential("openai")).toBeNull();
      expect(await t.modules.llm.service.resolveCredential("claude_code")).toBeNull();
      expect(await t.modules.llm.service.providers.isCallProviderConnected("openai")).toBe(false);
      expect(await t.modules.llm.service.providers.isCallProviderConnected("claude_code")).toBe(false);
      const st = (await t.http("GET", "/api/providers/openai")).body;
      expect(st).toMatchObject({ connected: false, activeMethod: null, health: "not_connected", account: null });
      expect(st.methods.find((m: { method: string }) => m.method === "chatgpt_oauth")).toMatchObject({ availability: "dev_only", configured: true });
      // not deleted
      expect(await t.modules.system.service.secrets.has("llm.openai.oauth_session")).toBe(true);

      await t.http("PUT", "/api/providers/openai/api-key", { apiKey: "sk-test-openai-dummy-key-000" });
      expect(await t.modules.llm.service.resolveCredential("openai")).toMatchObject({ method: "api_key" });

      // the same stored session resolves in dev mode
      const dev = await boot({ devMode: true });
      await dev.modules.system.service.secrets.set("llm.openai.oauth_session", chatgptSession(), "ChatGPT 로그인 세션");
      expect(await dev.modules.llm.service.resolveCredential("openai")).toMatchObject({ method: "chatgpt_oauth" });
    });
  });

  it("boot rebinds roles on claude_code and on OAuth-only connections to the configured provider; profiles stay active", async () => {
    await withoutEnvKeys(async () => {
      const cli = signedInCli();
      const t = await boot({ claudeCli: cli.adapter });
      await t.modules.system.service.secrets.set("llm.openai.oauth_session", chatgptSession(), "ChatGPT 로그인 세션");
      const novelId = (await t.modules.novel.service.createNovel({}, t.owner)).id;
      const anthropic = await profileOf(t, "anthropic");
      const cc = await profileOf(t, "claude_code");
      const openai = await profileOf(t, "openai");
      const google = await profileOf(t, "google");
      // binding to the subscription is refused in production
      const refused = await t.http("PATCH", `/api/novels/${novelId}/model-bindings/writer`, { providerProfileId: cc.id, modelId: "claude-sonnet-5-5" });
      expect(refused).toMatchObject({ status: 422, body: { error: { code: "oauth_dev_only" } } });

      // bindings left over from a dev-mode run (written directly)
      const rows = await t.testDb.db.select().from(roleModelBindings).where(eq(roleModelBindings.novelId, novelId));
      const byRole = new Map(rows.map((r) => [r.agentRole, r]));
      await t.testDb.db.update(roleModelBindings).set({ providerProfileId: cc.id, modelId: "claude-sonnet-5-5" }).where(eq(roleModelBindings.id, byRole.get("writer")!.id));
      await t.testDb.db.update(roleModelBindings).set({ providerProfileId: openai.id, modelId: "gpt-6.1-sol" }).where(eq(roleModelBindings.id, byRole.get("planner")!.id));
      // a provider with nothing connected is not touched (same as before: the user may connect it later)
      await t.testDb.db.update(roleModelBindings).set({ providerProfileId: google.id, modelId: "gemini-3.8-flash" }).where(eq(roleModelBindings.id, byRole.get("line_editor")!.id));

      await t.modules.llm.start!();
      const after = (await t.http("GET", `/api/novels/${novelId}/model-bindings`)).body.items as Array<{ agentRole: string; providerProfileId: string; modelId: string }>;
      const role = (r: string) => after.find((b) => b.agentRole === r)!;
      expect(role("writer")).toMatchObject({ providerProfileId: anthropic.id });
      expect(role("writer").modelId).toMatch(/^claude-/);
      expect(role("planner")).toMatchObject({ providerProfileId: anthropic.id });
      expect(role("line_editor")).toMatchObject({ providerProfileId: google.id });
      for (const p of [cc, openai]) expect((await profileOf(t, p.provider)).id).toBe(p.id); // still active
      expect(await t.modules.system.service.secrets.has("llm.openai.oauth_session")).toBe(true);
      expect(cli.spawn.calls).toEqual([]);
    });
  });

  it("an explicit llm.provider = claude_code falls back to anthropic outside dev mode", async () => {
    const cli = signedInCli();
    const t = await boot({ claudeCli: cli.adapter, config: { llm: { provider: "claude_code" } } });
    expect(t.platform.config.llm.provider).toBe("anthropic");
    const novelId = (await t.modules.novel.service.createNovel({}, t.owner)).id;
    const anthropic = await profileOf(t, "anthropic");
    const b = (await t.http("GET", `/api/novels/${novelId}/model-bindings`)).body.items as Array<{ providerProfileId: string }>;
    expect(b.every((x) => x.providerProfileId === anthropic.id)).toBe(true);
    expect(cli.spawn.calls).toEqual([]);
  });

  it("dev mode keeps today's behaviour (subscription methods available, auto-default to claude_code)", async () => {
    await withoutEnvKeys(async () => {
      const cli = signedInCli();
      const t = await boot({ devMode: true, anthropicKey: false, claudeCli: cli.adapter, config: { llm: { provider: undefined } } });
      expect(t.platform.config.llm.provider).toBe("claude_code");
      const r = await t.http("GET", "/api/providers");
      expect(r.body.items.flatMap((p: { methods: Array<{ availability: string }> }) => p.methods).every((m: { availability: string }) => m.availability === "available")).toBe(true);
      expect(r.body.items[0]).toMatchObject({ connected: true, activeMethod: "claude_cli" });
      expect(cli.spawn.calls.some((c) => c.args[0] === "auth")).toBe(true);
    });
  });
});
