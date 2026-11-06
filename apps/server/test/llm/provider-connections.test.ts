/**
 * Provider connections end to end over HTTP (test core + local mocks of auth.openai.com, the Codex backend, the
 * OpenAI API): API keys, ChatGPT browser sign-in (PKCE + loopback callback), refresh on 401, Codex CLI import,
 * active-method switch, disconnect, health checks, cross-provider role bindings. Tokens never appear in responses.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { fakeJwt, json, sse, startMockHttp, type MockHttp } from "./mock-http.js";
import { runHandle, seedTaskRun } from "./support.js";

let t: TestCore;
let m: MockHttp;
let novelId: string;
const ACCOUNT = "acct_7f3e9b2c11";

const idToken = (email = "writer@example.com") =>
  fakeJwt({ email, "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT, chatgpt_plan_type: "plus" } });
const accessToken = (n: number, expInSec = 3600) => fakeJwt({ n, exp: Math.floor(Date.now() / 1000) + expInSec, "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT } });

beforeAll(async () => {
  m = await startMockHttp();
  t = await createTestCore({
    devMode: true, // ChatGPT / xAI sign-in lanes exist only in dev mode
    anthropicKey: false, // starts with nothing connected
    config: {
      llm: {
        endpoints: {
          openai_auth_base_url: m.base,
          openai_codex_base_url: `${m.base}/codex`,
          openai_api_base_url: m.base,
          openai_login_callback_port: 0,
          xai_api_base_url: m.base,
          google_api_base_url: m.base,
          anthropic_api_base_url: m.base,
        },
      },
    } as never,
  });
  novelId = (await t.modules.novel.service.createNovel({}, t.owner)).id;
});
afterAll(async () => {
  await t.close();
  await m.close();
});

const tokensNeverLeak = (body: unknown, ...secrets: string[]) => {
  const s = JSON.stringify(body);
  for (const x of secrets) expect(s).not.toContain(x);
};

async function poll(path: string, until: (b: any) => boolean, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const r = await t.http("GET", path);
    if (until(r.body) || Date.now() > end) return r;
    await new Promise((res) => setTimeout(res, 20));
  }
}

describe("provider connections (/api/providers)", () => {
  it("lists the four providers with methods, unsupported sign-ins and terms notes; nothing connected", async () => {
    const saved = { a: process.env.ANTHROPIC_API_KEY, o: process.env.OPENAI_API_KEY, x: process.env.XAI_API_KEY, g: process.env.GEMINI_API_KEY, g2: process.env.GOOGLE_API_KEY };
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "XAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"]) delete process.env[k];
    try {
      const r = await t.http("GET", "/api/providers");
      expect(r.status).toBe(200);
      expect(r.body.items.map((p: { provider: string }) => p.provider)).toEqual(["anthropic", "openai", "xai", "google"]);
      const [claude, gpt, grok, gemini] = r.body.items;
      expect(claude.methods.map((x: { method: string; flows: string[]; label: string }) => [x.method, x.flows, x.label])).toEqual([
        ["claude_cli", ["cli"], "Claude 구독 (Claude Code CLI)"],
        ["api_key", ["api_key"], "Console API 키"],
      ]);
      expect(claude.unsupported).toEqual([]);
      expect(claude.claudeCli).toMatchObject({ installed: false, loggedIn: false, usable: false, enabled: true });
      expect(gpt.claudeCli).toBeNull();
      expect(claude.imageGeneration).toBe(false);
      expect(gpt.methods.map((x: { method: string; flows: string[] }) => [x.method, x.flows])).toEqual([
        ["chatgpt_oauth", ["browser", "device", "import_codex"]],
        ["api_key", ["api_key"]],
      ]);
      expect(grok.methods.find((x: { method: string }) => x.method === "xai_oauth").experimental).toBe(true);
      expect(gemini.methods.map((x: { method: string }) => x.method)).toEqual(["api_key"]);
      expect(gemini.unsupported[0].label).toContain("Google 계정 로그인");
      for (const p of r.body.items) {
        expect(p).toMatchObject({ connected: false, activeMethod: null, health: "not_connected" });
        expect(p.termsNote).toMatch(/약관/);
      }
    } finally {
      for (const [k, v] of Object.entries({ ANTHROPIC_API_KEY: saved.a, OPENAI_API_KEY: saved.o, XAI_API_KEY: saved.x, GEMINI_API_KEY: saved.g, GOOGLE_API_KEY: saved.g2 })) if (v !== undefined) process.env[k] = v;
    }
  });

  it("API key: shape check, stored encrypted (write-only), audited, connection test against the provider", async () => {
    const bad = await t.http("PUT", "/api/providers/anthropic/api-key", { apiKey: "not-a-claude-key" });
    expect(bad.status).toBe(422);
    const ws = await t.http("PUT", "/api/providers/anthropic/api-key", { apiKey: "sk-ant- with space" });
    expect(ws.status).toBe(400);

    const ok = await t.http("PUT", "/api/providers/xai/api-key", { apiKey: "xai-secret-key-123456" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ provider: "xai", connected: true, activeMethod: "api_key", health: "healthy" });
    tokensNeverLeak(ok.body, "xai-secret-key-123456");
    expect(await t.modules.system.service.secrets.get("llm.xai.api_key")).toBe("xai-secret-key-123456");
    const secrets = await t.http("GET", "/api/system/secrets");
    tokensNeverLeak(secrets.body, "xai-secret-key-123456");
    const act = await t.http("GET", "/api/activity?actionPrefix=secret.");
    expect(act.body.items[0]).toMatchObject({ action: "secret.set" });
    tokensNeverLeak(act.body, "xai-secret-key-123456");

    m.on("GET /v1/models", (c, res) => (c.headers.authorization === "Bearer xai-secret-key-123456" ? json(res, 200, { data: [{ id: "grok-4.3" }] }) : json(res, 401, { error: "bad" })));
    const test = await t.http("POST", "/api/providers/xai/test", { modelId: "grok-4.3" });
    expect(test.body).toMatchObject({ provider: "xai", status: "pass" });
  });

  it("ChatGPT browser sign-in: authorize URL (PKCE S256), state-checked loopback callback, code exchange, masked status", async () => {
    const at = accessToken(1);
    m.on("POST /oauth/token", (c, res) => {
      expect(c.form?.get("grant_type")).toBe("authorization_code");
      expect(c.form?.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
      expect(c.form?.get("code")).toBe("code-123");
      expect(c.form?.get("code_verifier")?.length).toBeGreaterThan(40);
      json(res, 200, { access_token: at, refresh_token: "rt_1", id_token: idToken() });
    });
    const start = await t.http("POST", "/api/providers/openai/oauth", { flow: "browser" });
    expect(start.status).toBe(201);
    expect(start.body).toMatchObject({ provider: "openai", flow: "browser", status: "pending", userCode: null });
    const auth = new URL(start.body.verificationUrl);
    expect(auth.origin + auth.pathname).toBe(`${m.base}/oauth/authorize`);
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(auth.searchParams.get("originator")).toBe("codex_cli_rs");
    const redirect = auth.searchParams.get("redirect_uri")!;
    expect(redirect).toMatch(/^http:\/\/localhost:\d+\/auth\/callback$/);

    const cb = redirect.replace("localhost", "127.0.0.1");
    const wrong = await fetch(`${cb}?code=code-123&state=forged`);
    expect(wrong.status).toBe(400);
    const right = await fetch(`${cb}?code=code-123&state=${encodeURIComponent(auth.searchParams.get("state")!)}`);
    expect(right.status).toBe(200);

    const done = await poll(`/api/providers/openai/oauth/${start.body.sessionId}`, (b) => b.status !== "pending");
    expect(done.body).toMatchObject({ status: "complete", accountEmail: "wr•••@example.com", verificationUrl: null });

    const st = await t.http("GET", "/api/providers/openai");
    expect(st.body).toMatchObject({ connected: true, activeMethod: "chatgpt_oauth", health: "healthy", account: { email: "wr•••@example.com", plan: "plus", accountId: "acct_7f3…" } });
    expect(st.body.expiresAt).toBeTruthy();
    tokensNeverLeak(st.body, at, "rt_1", ACCOUNT);
    tokensNeverLeak(done.body, at, "rt_1");
  });

  it("calls go to the Codex backend with the session; a 401 refreshes (JSON refresh grant) and replays; the new session is stored", async () => {
    const b = await t.http("GET", `/api/novels/${novelId}/model-bindings`);
    expect(b.status).toBe(200);
    const profiles = (await t.http("GET", "/api/llm/provider-profiles")).body.items as Array<{ id: string; provider: string; isActive: boolean; models: Array<{ id: string }> }>;
    const openai = profiles.find((p) => p.provider === "openai" && p.isActive)!;
    expect(openai.models.map((x) => x.id)).toContain("gpt-6-luna");
    const bind = await t.http("PATCH", `/api/novels/${novelId}/model-bindings/writer`, { providerProfileId: openai.id, modelId: "gpt-6-luna" });
    expect(bind.status).toBe(200);
    expect(bind.body).toMatchObject({ providerProfileId: openai.id, modelId: "gpt-6-luna" });

    const fresh = accessToken(2);
    let refreshCalls = 0;
    m.on("POST /oauth/token", (c, res) => {
      refreshCalls++;
      expect(c.json).toMatchObject({ grant_type: "refresh_token", refresh_token: "rt_1", client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
      json(res, 200, { access_token: fresh, refresh_token: "rt_2" });
    });
    m.on("POST /codex/responses", (c, res) => {
      if (c.headers.authorization !== `Bearer ${fresh}`) return json(res, 401, { error: { message: "token revoked" } });
      expect(c.headers["chatgpt-account-id"]).toBe(ACCOUNT);
      sse(res, [{ type: "response.output_text.delta", delta: "GPT 원고" }, { type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 4 } } }]);
    });
    const { taskId, runId } = await seedTaskRun(t, novelId, { role: "writer" });
    const out = await t.modules.llm.service.modelCalls.call({ run: runHandle(novelId, taskId, runId, "writer"), purpose: "draft", system: "s", messages: [{ role: "user", content: "써 줘" }], output: { kind: "text" } });
    expect(out).toMatchObject({ value: "GPT 원고", modelId: "gpt-6-luna" });
    expect(refreshCalls).toBe(1);
    const stored = JSON.parse((await t.modules.system.service.secrets.get("llm.openai.oauth_session"))!);
    expect(stored.tokens).toMatchObject({ access_token: fresh, refresh_token: "rt_2", account_id: ACCOUNT });

    // a binding cannot point at a model that the profile does not list
    const bad = await t.http("PATCH", `/api/novels/${novelId}/model-bindings/writer`, { providerProfileId: openai.id, modelId: "claude-opus-5-5" });
    expect(bad.status).toBe(422);
  });

  it("health checks: default provider always, other providers only while connected; connection test on the Codex lane", async () => {
    m.on("GET /codex/models", (_c, res) => json(res, 200, { models: [{ slug: "gpt-6-luna" }] }));
    m.on("GET /v1/models", (_c, res) => json(res, 200, { data: [{ id: "grok-4.3" }] }));
    const h = await t.modules.system.service.runHealthChecks({ kinds: ["llm_key"] });
    const names = h.map((x) => x.name).sort();
    expect(names).toContain("llm.anthropic");
    expect(names).toContain("llm.openai");
    expect(names).toContain("llm.xai");
    expect(names).not.toContain("llm.google");
    expect(h.find((x) => x.name === "llm.openai")!.status).toBe("pass");
    const test = await t.http("POST", "/api/providers/openai/test", { modelId: "gpt-6-luna" });
    expect(test.body).toMatchObject({ provider: "openai", status: "pass" });
  });

  it("active method switch between ChatGPT sign-in and API key; disconnect one method, then all", async () => {
    const key = await t.http("PUT", "/api/providers/openai/api-key", { apiKey: "sk-proj-abcdef123456" });
    expect(key.body.activeMethod).toBe("api_key");
    const sw = await t.http("PUT", "/api/providers/openai/active-method", { method: "chatgpt_oauth" });
    expect(sw.body).toMatchObject({ activeMethod: "chatgpt_oauth", connected: true });
    const bad = await t.http("PUT", "/api/providers/anthropic/active-method", { method: "chatgpt_oauth" });
    expect(bad.status).toBe(422);

    const d1 = await t.http("DELETE", "/api/providers/openai/connection?method=chatgpt_oauth");
    expect(d1.body).toMatchObject({ connected: true, activeMethod: "api_key", account: null });
    expect(await t.modules.system.service.secrets.has("llm.openai.oauth_session")).toBe(false);
    const d2 = await t.http("DELETE", "/api/providers/openai/connection");
    expect(d2.body).toMatchObject({ connected: false, activeMethod: null });
    const act = await t.http("GET", "/api/activity?actionPrefix=secret.deleted");
    expect(act.body.items.length).toBeGreaterThanOrEqual(2);
  });

  it("imports the Codex CLI session once (CODEX_HOME/auth.json), never for other providers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ncs-codex-"));
    const saved = process.env.CODEX_HOME;
    process.env.CODEX_HOME = dir;
    try {
      const missing = await t.http("POST", "/api/providers/openai/import-codex");
      expect(missing.status).toBe(422);
      writeFileSync(join(dir, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: idToken("me@codex.dev"), access_token: accessToken(9), refresh_token: "rt_cli", account_id: ACCOUNT } }));
      const r = await t.http("POST", "/api/providers/openai/import-codex");
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ connected: true, activeMethod: "chatgpt_oauth", account: { email: "me•••@codex.dev" } });
      tokensNeverLeak(r.body, "rt_cli");
      expect((await t.http("POST", "/api/providers/xai/import-codex")).status).toBe(422);
    } finally {
      if (saved === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("disconnect cannot remove an environment-variable API key → 409 naming the variable; stays connected", async () => {
    const saved = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = "xai-env-key-1234567890";
    try {
      const before = await t.http("GET", "/api/providers/xai");
      expect(before.body).toMatchObject({ connected: true, activeMethod: "api_key" });
      const r = await t.http("DELETE", "/api/providers/xai/connection?method=api_key");
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe("api_key_from_env");
      expect(r.body.error.message).toContain("XAI_API_KEY");
      tokensNeverLeak(r.body, "xai-env-key-1234567890");
      const all = await t.http("DELETE", "/api/providers/xai/connection");
      expect(all.status).toBe(409);
    } finally {
      if (saved === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = saved;
    }
    const after = await t.http("DELETE", "/api/providers/xai/connection?method=api_key");
    expect(after.status).toBe(200);
  });

  it("OAuth start validation: unsupported flows → 422, unknown session → 404, cancel → cancelled", async () => {
    expect((await t.http("POST", "/api/providers/google/oauth", { flow: "device" })).status).toBe(422);
    expect((await t.http("POST", "/api/providers/xai/oauth", { flow: "browser" })).status).toBe(422);
    expect((await t.http("GET", "/api/providers/openai/oauth/doesnotexist1")).status).toBe(404);
    const s = await t.http("POST", "/api/providers/openai/oauth", { flow: "browser" });
    expect(s.status).toBe(201);
    const again = await t.http("POST", "/api/providers/openai/oauth", { flow: "browser" });
    expect((await t.http("GET", `/api/providers/openai/oauth/${s.body.sessionId}`)).body.status).toBe("cancelled");
    expect((await t.http("DELETE", `/api/providers/openai/oauth/${again.body.sessionId}`)).status).toBe(204);
    expect((await t.http("GET", `/api/providers/openai/oauth/${again.body.sessionId}`)).body.status).toBe("cancelled");
  });
});
