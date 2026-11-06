/**
 * OAuth device-code logins (ChatGPT, xAI) and token refresh rules, against local mocks of auth.openai.com / auth.x.ai:
 * prompt → poll (pending / slow_down / retryable) → token → secrets store; single-flight refresh, compare-before-write,
 * terminal refresh errors → reauth_required, discovery host allow-list. No network.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createLogger, type SecretProvider } from "../../src/platform/index.js";
import { createCredentialStore } from "../../src/modules/llm/application/credentials.js";
import { createOauthLogins } from "../../src/modules/llm/application/oauth-logins.js";
import { trustedEndpoint } from "../../src/modules/llm/adapters/xai/xai-auth.js";
import { fakeJwt, json, startMockHttp, type MockHttp } from "./mock-http.js";

function memorySecrets(): SecretProvider & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (id) => data.get(id) ?? null,
    set: async (id, v) => void data.set(id, v),
    delete: async (id) => data.delete(id),
    list: async () => [...data.keys()].map((id) => ({ id, label: null, updatedAt: new Date() })),
    has: async (id) => data.has(id),
  };
}

let m: MockHttp;
beforeAll(async () => {
  m = await startMockHttp();
});
afterAll(() => m.close());
beforeEach(() => m.reset());

const log = createLogger("silent");
const setup = (devMode = true) => {
  const secrets = memorySecrets();
  const store = createCredentialStore({ secrets, log, endpoints: { openaiAuthBaseUrl: m.base, xaiAuthBaseUrl: m.base }, env: {}, devMode });
  const connected: string[] = [];
  const logins = createOauthLogins({
    store,
    log,
    openaiAuthBaseUrl: m.base,
    xaiAuthBaseUrl: m.base,
    callbackPort: 0,
    xaiPollFloorMs: 5,
    chatgptPollFloorMs: 5,
    onConnected: async (p) => void connected.push(p),
  });
  return { secrets, store, logins, connected };
};

async function waitFor<T>(fn: () => T, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (ok(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
}

const ACCOUNT = "acct_dev_1";
const chatgptTokens = (n: number) => ({
  access_token: fakeJwt({ n, exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT } }),
  refresh_token: `rt_${n}`,
  id_token: fakeJwt({ email: "Dev@Example.com" }),
});

describe("ChatGPT device-code login", () => {
  it("usercode → prompt with the code → 403 pending → authorization code → exchange (device redirect) → stored", async () => {
    const { logins, store, secrets, connected } = setup();
    m.on("POST /api/accounts/deviceauth/usercode", (c, res) => {
      expect(c.json).toEqual({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
      json(res, 200, { device_auth_id: "dev_1", user_code: "ABCD-EFGH", interval: "1" });
    });
    let polls = 0;
    m.on("POST /api/accounts/deviceauth/token", (c, res) => {
      expect(c.json).toEqual({ device_auth_id: "dev_1", user_code: "ABCD-EFGH" });
      if (polls++ === 0) return json(res, 403, { error: "authorization_pending" });
      json(res, 200, { authorization_code: "ac_1", code_verifier: "ver_1" });
    });
    m.on("POST /oauth/token", (c, res) => {
      expect(c.form?.get("redirect_uri")).toBe(`${m.base}/deviceauth/callback`);
      expect(c.form?.get("code_verifier")).toBe("ver_1");
      json(res, 200, chatgptTokens(1));
    });
    const s = await logins.start("openai", "device", "usr_1");
    expect(s).toMatchObject({ status: "pending", flow: "device", userCode: "ABCD-EFGH", verificationUrl: `${m.base}/codex/device` });
    const done = await waitFor(() => logins.get("openai", s.sessionId), (v) => v.status !== "pending");
    expect(done).toMatchObject({ status: "complete", accountEmail: "de•••@example.com", userCode: null });
    expect(connected).toEqual(["openai"]);
    expect(await store.activeMethod("openai")).toBe("chatgpt_oauth");
    const cred = await store.resolve("openai");
    expect(cred).toMatchObject({ method: "chatgpt_oauth", headers: { "chatgpt-account-id": ACCOUNT } });
    expect(JSON.parse(secrets.data.get("llm.openai.oauth_session")!).tokens.refresh_token).toBe("rt_1");
  });

  it("device login switched off (404 at usercode) → start fails with a Korean hint, nothing stored", async () => {
    const { logins, secrets } = setup();
    m.on("POST /api/accounts/deviceauth/usercode", (_c, res) => json(res, 404, {}));
    await expect(logins.start("openai", "device", null)).rejects.toMatchObject({ status: 502, message: expect.stringContaining("기기 코드 로그인이 꺼져") });
    expect(secrets.data.size).toBe(0);
  });

  it("a token response without refresh token / account id is rejected (nothing persisted)", async () => {
    const { logins, secrets } = setup();
    m.on("POST /api/accounts/deviceauth/usercode", (_c, res) => json(res, 200, { device_auth_id: "d", usercode: "X", interval: 1 }));
    m.on("POST /api/accounts/deviceauth/token", (_c, res) => json(res, 200, { authorization_code: "a", code_verifier: "v" }));
    m.on("POST /oauth/token", (_c, res) => json(res, 200, { access_token: fakeJwt({}) }));
    const s = await logins.start("openai", "device", null);
    const done = await waitFor(() => logins.get("openai", s.sessionId), (v) => v.status !== "pending");
    expect(done.status).toBe("error");
    expect(secrets.data.has("llm.openai.oauth_session")).toBe(false);
  });
});

describe("ChatGPT refresh rules", () => {
  it("single-flight: concurrent 401 refreshes spend the refresh token once; a stored newer token is used without refreshing", async () => {
    const { store, secrets } = setup();
    const t1 = chatgptTokens(1);
    await store.saveOpenaiSession({ accessToken: t1.access_token, refreshToken: "rt_1", idToken: t1.id_token, accountId: ACCOUNT, lastRefresh: new Date().toISOString() });
    let calls = 0;
    m.on("POST /oauth/token", async (_c, res) => {
      calls++;
      await new Promise((r) => setTimeout(r, 30));
      json(res, 200, chatgptTokens(2));
    });
    const cred = (await store.resolve("openai"))!;
    const [a, b] = await Promise.all([cred.refresh!(), cred.refresh!()]);
    expect(calls).toBe(1);
    expect(a!.token).toBe(b!.token);
    expect(a!.token).not.toBe(t1.access_token);
    // the old credential refreshing again finds a newer stored token → no second refresh
    const c = await cred.refresh!();
    expect(c!.token).toBe(a!.token);
    expect(calls).toBe(1);
    expect(JSON.parse(secrets.data.get("llm.openai.oauth_session")!).tokens.refresh_token).toBe("rt_2");
  });

  it("an expiring access token is refreshed before use; invalid_grant → reauth_required, old session kept", async () => {
    const { store } = setup();
    const expiring = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 10, "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT } });
    await store.saveOpenaiSession({ accessToken: expiring, refreshToken: "rt_x", idToken: null, accountId: ACCOUNT, lastRefresh: "" });
    m.on("POST /oauth/token", (_c, res) => json(res, 400, { error: "invalid_grant", error_description: "refresh_token_reused" }));
    const cred = await store.resolve("openai");
    expect(cred!.token).toBe(expiring);
    expect(store.reauthRequired("openai")).toBe(true);
    expect(await store.oauthInfo("openai")).not.toBeNull();
  });

  it("a terminally rejected refresh token is never resent; a new login lifts the block", async () => {
    const { store, secrets } = setup();
    const expired = fakeJwt({ exp: Math.floor(Date.now() / 1000) - 60, "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT } });
    await store.saveOpenaiSession({ accessToken: expired, refreshToken: "rt_dead", idToken: null, accountId: ACCOUNT, lastRefresh: "" });
    let calls = 0;
    m.on("POST /oauth/token", (_c, res) => {
      calls++;
      json(res, 400, { error: "invalid_grant", error_description: "refresh_token_reused" });
    });
    for (let i = 0; i < 5; i++) {
      const cred = await store.resolve("openai");
      await cred!.refresh!();
    }
    expect(calls).toBe(1);
    expect(store.reauthRequired("openai")).toBe(true);
    expect(JSON.stringify([...secrets.data.values()])).toContain("rt_dead"); // session kept, user decides

    // a fresh login (new refresh token) is refreshed normally again
    await store.saveOpenaiSession({ accessToken: expired, refreshToken: "rt_new", idToken: null, accountId: ACCOUNT, lastRefresh: "" });
    expect(store.reauthRequired("openai")).toBe(false);
    m.on("POST /oauth/token", (_c, res) => {
      calls++;
      json(res, 200, chatgptTokens(3));
    });
    const cred = await store.resolve("openai");
    expect(calls).toBe(2);
    expect(cred!.token).not.toBe(expired);
  });
});

describe("xAI device-code login + refresh", () => {
  const discovery = (base: string) => ({
    issuer: base,
    authorization_endpoint: `${base}/oauth2/authorize`,
    token_endpoint: `${base}/oauth2/token`,
    device_authorization_endpoint: `${base}/oauth2/device/code`,
  });

  it("discovery → device code (form: client_id, scope) → pending / retryable → token → stored with expiry and email", async () => {
    const { logins, store } = setup();
    m.on("GET /.well-known/openid-configuration", (_c, res) => json(res, 200, discovery(m.base)));
    m.on("POST /oauth2/device/code", (c, res) => {
      expect(c.form?.get("client_id")).toBe("b1a00492-073a-47ea-816f-4c329264a828");
      expect(c.form?.get("scope")).toContain("api:access");
      json(res, 200, { device_code: "dc_secret", user_code: "WXYZ-1234", verification_uri: "https://accounts.x.ai/device", verification_uri_complete: "https://accounts.x.ai/device?code=WXYZ-1234", expires_in: 600, interval: 0.001 });
    });
    let polls = 0;
    m.on("POST /oauth2/token", (c, res) => {
      expect(c.form?.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
      expect(c.form?.get("device_code")).toBe("dc_secret");
      polls++;
      if (polls === 1) return json(res, 400, { error: "authorization_pending" });
      if (polls === 2) return json(res, 503, { error: "temporarily_unavailable" });
      json(res, 200, { access_token: "xat_1", refresh_token: "xrt_1", expires_in: 3600, id_token: fakeJwt({ email: "grok@x.ai", sub: "u_42" }) });
    });
    const s = await logins.start("xai", "device", "usr_1");
    expect(s).toMatchObject({ userCode: "WXYZ-1234", verificationUrl: "https://accounts.x.ai/device?code=WXYZ-1234" });
    expect(JSON.stringify(s)).not.toContain("dc_secret");
    const done = await waitFor(() => logins.get("xai", s.sessionId), (v) => v.status !== "pending");
    expect(done).toMatchObject({ status: "complete", accountEmail: "gr•••@x.ai" });
    const info = await store.oauthInfo("xai");
    expect(info).toMatchObject({ email: "grok@x.ai", accountId: "u_42", refreshable: true });
    expect(info!.expiresAt).toBeGreaterThan(Date.now() + 3_000_000);
    expect(await store.resolve("xai")).toMatchObject({ method: "xai_oauth", token: "xat_1" });
  });

  it("access_denied ends the login with an error; 3 consecutive 5xx abort it", async () => {
    const { logins } = setup();
    m.on("GET /.well-known/openid-configuration", (_c, res) => json(res, 200, discovery(m.base)));
    m.on("POST /oauth2/device/code", (_c, res) => json(res, 200, { device_code: "d", user_code: "U", verification_uri: `${m.base}/device`, expires_in: 60, interval: 0.001 }));
    m.on("POST /oauth2/token", (_c, res) => json(res, 400, { error: "access_denied" }));
    let s = await logins.start("xai", "device", null);
    let done = await waitFor(() => logins.get("xai", s.sessionId), (v) => v.status !== "pending");
    expect(done).toMatchObject({ status: "error", message: "xAI 로그인이 거부되었습니다." });

    m.on("POST /oauth2/token", (_c, res) => json(res, 502, {}));
    s = await logins.start("xai", "device", null);
    done = await waitFor(() => logins.get("xai", s.sessionId), (v) => v.status !== "pending");
    expect(done.status).toBe("error");
  });

  it("refresh 120 s before expiry (form refresh grant, rotation optional); terminal error → reauth + 30 s negative cache", async () => {
    const { store, secrets } = setup();
    await store.saveXaiSession({ accessToken: "old", refreshToken: "xrt", expiresAt: Date.now() + 60_000, tokenEndpoint: `${m.base}/oauth2/token`, email: null, accountId: null });
    m.on("POST /oauth2/token", (c, res) => {
      expect(c.form?.get("grant_type")).toBe("refresh_token");
      expect(c.form?.get("refresh_token")).toBe("xrt");
      json(res, 200, { access_token: "new", expires_in: 3600 });
    });
    const cred = await store.resolve("xai");
    expect(cred!.token).toBe("new");
    expect(JSON.parse(secrets.data.get("llm.xai.oauth_session")!).refreshToken).toBe("xrt");

    let calls = 0;
    m.on("POST /oauth2/token", (_c, res) => {
      calls++;
      json(res, 400, { error: "invalid_grant" });
    });
    expect(await cred!.refresh!()).toBeNull();
    expect(store.reauthRequired("xai")).toBe(true);
    expect(await cred!.refresh!()).toBeNull();
    expect(calls).toBe(1);
  });

  it("discovery endpoints must be https on auth.x.ai / accounts.x.ai or the configured issuer's origin", () => {
    expect(trustedEndpoint("https://auth.x.ai/oauth2/token", "https://auth.x.ai")).toBe("https://auth.x.ai/oauth2/token");
    expect(trustedEndpoint("https://accounts.x.ai/device", "https://auth.x.ai")).toBe("https://accounts.x.ai/device");
    expect(trustedEndpoint("http://auth.x.ai/oauth2/token", "https://auth.x.ai")).toBeNull();
    expect(trustedEndpoint("https://evil.example/oauth2/token", "https://auth.x.ai")).toBeNull();
    expect(trustedEndpoint("https://user:pw@auth.x.ai/t", "https://auth.x.ai")).toBeNull();
  });
});
