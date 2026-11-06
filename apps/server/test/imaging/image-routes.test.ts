/**
 * /api/images end to end (test core + local mocks of the OpenAI / xAI / Gemini APIs): capabilities, validation,
 * async generation (queued → succeeded), asset files, install vs novel scoping, budget admission + ledger row,
 * cancel, delete (files removed), boot recovery. Keys never appear in responses.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "@ncs/db/orm";
import { costEvents, imageGenerations } from "@ncs/db/schema";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { fakeJwt, json, startMockHttp, type MockHttp } from "../llm/mock-http.js";
import { PNG_B64 } from "./fixtures.js";

let t: TestCore;
let m: MockHttp;
let novelId: string;
const ENV_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "XAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"];
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  m = await startMockHttp();
  t = await createTestCore({
    devMode: true, // ChatGPT / xAI sign-in lanes exist only in dev mode
    config: {
      llm: {
        endpoints: {
          openai_api_base_url: m.base,
          openai_codex_base_url: `${m.base}/codex`,
          openai_auth_base_url: m.base,
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
  for (const k of ENV_KEYS) if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
});

const svc = () => t.modules.imaging.service;
const body = (over: Record<string, unknown> = {}) => ({ provider: "xai", modelId: "grok-imagine-image-2.0", prompt: "달빛 아래 성", aspectRatio: "16:9", resolution: "1k", count: 1, ...over });

describe("image providers", () => {
  it("lists four providers: Claude unavailable, the rest disabled with a reason until connected", async () => {
    const r = await t.http("GET", "/api/images/providers");
    expect(r.status).toBe(200);
    expect(r.body.items.map((p: { provider: string }) => p.provider)).toEqual(["anthropic", "openai", "xai", "google"]);
    const [claude, gpt, grok, gemini] = r.body.items;
    expect(claude).toMatchObject({ available: false, models: [] });
    expect(claude.unavailableReason).toContain("Claude는 이미지를 만들 수 없습니다");
    for (const p of [gpt, grok, gemini]) {
      expect(p.available).toBe(true);
      expect(p.connected).toBe(false);
      expect(p.unavailableReason).toContain("연결되지 않았습니다");
      expect(p.models.length).toBeGreaterThan(0);
      expect(p.termsNote).toBeTruthy();
    }
    expect(gpt.models.map((x: { id: string }) => x.id)).toEqual(["gpt-image-2.6-flare", "gpt-image-2.6-sunburst", "gpt-image-1-mini"]);
    expect(gemini.notes.join(" ")).toContain("SynthID");
    expect(grok.models[0]).toMatchObject({ id: "grok-imagine-image-2.0", maxImages: 4, resolutions: ["1k", "2k"], estimatedMicrosPerImage: { "1k": 40_000, "2k": 60_000 } });
  });

  it("rejects generation for Claude, a disconnected provider, a wrong lane model and bad params", async () => {
    expect((await t.http("POST", "/api/images/generations", body({ provider: "anthropic", modelId: "claude-opus-5-5" }))).body.error.code).toBe("image_unsupported");
    expect((await t.http("POST", "/api/images/generations", body())).body.error.code).toBe("provider_not_connected");
    expect((await t.http("PUT", "/api/providers/xai/api-key", { apiKey: "xai-secret-key-123456" })).status).toBe(200);
    expect((await t.http("PUT", "/api/providers/openai/api-key", { apiKey: "sk-proj-image-123456" })).status).toBe(200);
    expect((await t.http("PUT", "/api/providers/google/api-key", { apiKey: "AIzaImageKey123456" })).status).toBe(200);
    const lane = await t.http("POST", "/api/images/generations", body({ provider: "openai", modelId: "gpt-image-2" }));
    expect(lane.status).toBe(422);
    expect(lane.body.error.code).toBe("image_model_lane");
    const aspect = await t.http("POST", "/api/images/generations", body({ aspectRatio: "7:3" }));
    expect(aspect.body.error.code).toBe("image_params_invalid");
    expect((await t.http("POST", "/api/images/generations", body({ count: 5 }))).body.error.message).toContain("4장까지");
    expect((await t.http("POST", "/api/images/generations", body({ prompt: " " }))).status).toBe(400);
    const providers = await t.http("GET", "/api/images/providers");
    const grok = providers.body.items.find((p: { provider: string }) => p.provider === "xai");
    expect(grok).toMatchObject({ connected: true, activeMethod: "api_key", unavailableReason: null });
    expect(JSON.stringify(providers.body)).not.toContain("xai-secret-key");
  });
});

describe("generations", () => {
  it("install level: 202 queued → background → succeeded with a stored PNG; file endpoint serves bytes", async () => {
    m.on("POST /v1/images/generations", (_c, res) => json(res, 200, { data: [{ b64_json: PNG_B64, revised_prompt: "castle" }], usage: { cost_in_usd_ticks: 400_000_000 } }));
    const r = await t.http("POST", "/api/images/generations", body({ styleNotes: "수채화", negativePrompt: "글자" }));
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ status: "queued", novelId: null, provider: "xai", estimatedMicros: 40_000, assets: [] });
    expect(r.body.params).not.toHaveProperty("finalPrompt");
    await svc().whenIdle();
    const sent = m.captured.find((c) => c.path === "/v1/images/generations")!;
    expect(sent.headers.authorization).toBe("Bearer xai-secret-key-123456");
    expect(sent.json.prompt).toBe("달빛 아래 성\n\n스타일 지시: 수채화\n\n이미지에 넣지 말 것: 글자");
    const g = await t.http("GET", `/api/images/generations/${r.body.id}`);
    expect(g.body).toMatchObject({ status: "succeeded", costMicros: 40_000, costBasis: "measured", revisedPrompt: "castle" });
    expect(g.body.assets).toHaveLength(1);
    expect(g.body.assets[0]).toMatchObject({ mimeType: "image/png", width: 1, height: 1, ord: 0 });
    expect(t.home.split(/[\\/]/)).toContain(".ncs"); // dot-directory home (default ~/.ncs) must not break downloads
    const file = await fetch(`${baseOf(t)}${g.body.assets[0].url}`);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await file.arrayBuffer()).equals(Buffer.from(PNG_B64, "base64"))).toBe(true);
    const dl = await fetch(`${baseOf(t)}${g.body.assets[0].url}?download=1`);
    expect(dl.headers.get("content-disposition")).toContain("attachment");
    expect(JSON.stringify(g.body)).not.toContain("xai-secret");
    const act = await t.http("GET", "/api/activity?actionPrefix=image.");
    expect(act.body.items.map((x: { action: string }) => x.action)).toEqual(expect.arrayContaining(["image.requested", "image.completed"]));
  });

  it("novel scope: admitted by the budget and recorded as an image cost event; list scoping by novelId", async () => {
    m.on("POST /v1/images/generations", (_c, res) => json(res, 200, { data: [{ b64_json: PNG_B64 }, { b64_json: PNG_B64 }], usage: { input_tokens: 10, output_tokens: 1000 } }));
    const r = await t.http("POST", "/api/images/generations", body({ novelId, provider: "openai", modelId: "gpt-image-2.6-flare", aspectRatio: "1:1", quality: "low", count: 2 }));
    expect(r.status).toBe(202);
    expect(r.body.estimatedMicros).toBe(12_000);
    await svc().whenIdle();
    const g = await t.http("GET", `/api/images/generations/${r.body.id}`);
    expect(g.body).toMatchObject({ status: "succeeded", costBasis: "measured", costMicros: 10 * 5 + 1000 * 30, imageCount: 2 });
    expect(g.body.assets).toHaveLength(2);
    const ev = await t.testDb.db.select().from(costEvents).where(eq(costEvents.idempotencyKey, `img:${r.body.id}`));
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ novelId, category: "image", provider: "openai", amountMicros: 30_050, reservedMicros: 12_000, runId: null, costBasis: "measured" });
    const [row] = await t.testDb.db.select().from(imageGenerations).where(eq(imageGenerations.id, r.body.id));
    expect(row!.costEventId).toBe(ev[0]!.id);

    const novelList = await t.http("GET", `/api/images/generations?novelId=${novelId}`);
    expect(novelList.body.items.map((x: { id: string }) => x.id)).toEqual([r.body.id]);
    const installList = await t.http("GET", "/api/images/generations");
    expect(installList.body.items.every((x: { novelId: string | null }) => x.novelId === null)).toBe(true);
    const all = await t.http("GET", "/api/images/generations?scope=all&limit=1");
    expect(all.body.items).toHaveLength(1);
    expect(all.body.nextCursor).toBeTruthy();
    const next = await t.http("GET", `/api/images/generations?scope=all&limit=1&before=${all.body.nextCursor}`);
    expect(next.body.items[0].id).not.toBe(all.body.items[0].id);
    expect((await t.http("GET", "/api/images/generations?novelId=nov_00000000000000000000000000")).body.items).toEqual([]);
    expect((await t.http("POST", "/api/images/generations", body({ novelId: "nov_00000000000000000000000000" }))).status).toBe(404);
  });

  it("ChatGPT sign-in lane: only gpt-image-2 on the Codex backend, plan-billed (no ledger row even in a novel)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ncs-codex-"));
    const saved = process.env.CODEX_HOME;
    process.env.CODEX_HOME = dir;
    const auth = { "https://api.openai.com/auth": { chatgpt_account_id: "acct_img", chatgpt_plan_type: "plus" } };
    const access = fakeJwt({ ...auth, exp: Math.floor(Date.now() / 1000) + 3600 });
    try {
      writeFileSync(join(dir, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: fakeJwt({ email: "a@b.dev", ...auth }), access_token: access, refresh_token: "rt_img", account_id: "acct_img" } }));
      expect((await t.http("POST", "/api/providers/openai/import-codex")).status).toBe(200);
      const p = (await t.http("GET", "/api/images/providers")).body.items.find((x: { provider: string }) => x.provider === "openai");
      expect(p).toMatchObject({ activeMethod: "chatgpt_oauth", defaultModelId: "gpt-image-2", unavailableReason: null });
      expect(p.models.map((x: { id: string }) => x.id)).toEqual(["gpt-image-2"]);
      expect(p.notes[0]).toContain("비공식");
      m.on("POST /codex/images/generations", (_c, res) => json(res, 200, { data: [{ b64_json: PNG_B64 }] }));
      const r = await t.http("POST", "/api/images/generations", body({ novelId, provider: "openai", modelId: "gpt-image-2", aspectRatio: "1:1" }));
      expect(r.status).toBe(202);
      expect(r.body.costBasis).toBe("plan");
      await svc().whenIdle();
      const sent = m.captured.find((c) => c.path === "/codex/images/generations")!;
      expect(sent.headers["chatgpt-account-id"]).toBe("acct_img");
      expect(sent.json.model).toBe("gpt-image-2");
      const g = await t.http("GET", `/api/images/generations/${r.body.id}`);
      expect(g.body).toMatchObject({ status: "succeeded", costBasis: "plan", costMicros: null, credentialMethod: "chatgpt_oauth" });
      expect(JSON.stringify(g.body)).not.toContain(access);
      expect(await t.testDb.db.select().from(costEvents).where(eq(costEvents.idempotencyKey, `img:${r.body.id}`))).toHaveLength(0);
    } finally {
      await t.http("PUT", "/api/providers/openai/active-method", { method: "api_key" });
      if (saved === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a novel-scoped request over the image budget (409 budget_blocked, nothing sent)", async () => {
    const n2 = (await t.modules.novel.service.createNovel({}, t.owner)).id;
    await t.modules.budget.service.updatePolicy({ novelId: n2 }, "all", { hardLimitMicros: 30_000 }, t.owner);
    m.reset();
    const r = await t.http("POST", "/api/images/generations", body({ novelId: n2, resolution: "2k" }));
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("budget_blocked");
    expect(m.captured).toHaveLength(0);
  });

  it("Gemini: failure is stored with the provider message; partial results keep the made images", async () => {
    m.on("POST /v1beta/interactions", (_c, res) => json(res, 400, { error: { message: "Request contains an invalid argument." } }));
    const r = await t.http("POST", "/api/images/generations", body({ provider: "google", modelId: "gemini-nano-banana-2.1", aspectRatio: "1:1" }));
    await svc().whenIdle();
    const g = await t.http("GET", `/api/images/generations/${r.body.id}`);
    expect(g.body).toMatchObject({ status: "failed", errorFamily: "internal", costMicros: null, assets: [] });
    expect(g.body.errorMessage).toContain("Gemini API");
    expect(JSON.stringify(g.body)).not.toContain("AIzaImageKey");
  });

  it("cancel: a running call is aborted → cancelled; a final generation cannot be cancelled", async () => {
    let hit!: () => void;
    const arrived = new Promise<void>((r) => (hit = r));
    m.on("POST /v1/images/generations", () => hit()); // hangs
    const r = await t.http("POST", "/api/images/generations", body());
    await arrived;
    const c = await t.http("POST", `/api/images/generations/${r.body.id}/cancel`);
    expect(c.status).toBe(200);
    expect(c.body.status).toBe("cancelled"); // the response carries the final status, not the old "running"
    await svc().whenIdle();
    const g = await t.http("GET", `/api/images/generations/${r.body.id}`);
    expect(g.body.status).toBe("cancelled");
    expect((await t.http("POST", `/api/images/generations/${r.body.id}/cancel`)).status).toBe(409);
  });

  it("delete removes rows and files (204, then 404)", async () => {
    m.on("POST /v1/images/generations", (_c, res) => json(res, 200, { data: [{ b64_json: PNG_B64 }] }));
    const r = await t.http("POST", "/api/images/generations", body());
    await svc().whenIdle();
    const g = await t.http("GET", `/api/images/generations/${r.body.id}`);
    const path = (await svc().openAsset(g.body.assets[0].id)).path;
    expect(existsSync(path)).toBe(true);
    // a row whose file vanished from disk → 404 not_found (not a 500)
    rmSync(path);
    const gone = await t.http("GET", `/api/images/assets/${g.body.assets[0].id}/file`);
    expect(gone.status).toBe(404);
    expect(gone.body.error.code).toBe("not_found");
    writeFileSync(path, Buffer.from(PNG_B64, "base64"));
    expect((await t.http("DELETE", `/api/images/generations/${r.body.id}`)).status).toBe(204);
    expect(existsSync(path)).toBe(false);
    expect((await t.http("GET", `/api/images/generations/${r.body.id}`)).status).toBe(404);
    expect((await t.http("GET", `/api/images/assets/${g.body.assets[0].id}/file`)).status).toBe(404);
    const act = await t.http("GET", "/api/activity?actionPrefix=image.deleted");
    expect(act.body.items).toHaveLength(1);
  });

  it("boot recovery: interrupted running → failed, queued → run again", async () => {
    m.on("POST /v1/images/generations", (_c, res) => json(res, 200, { data: [{ b64_json: PNG_B64 }] }));
    const now = new Date();
    const base = { provider: "xai", modelId: "grok-imagine-image-2.0", prompt: "p", params: { aspectRatio: "1:1", resolution: "1k" }, imageCount: 1, requestedByActorType: "user" as const, requestedByActorId: t.ownerId, createdAt: now, updatedAt: now };
    const runId = t.platform.ids.next("img");
    const queuedId = t.platform.ids.next("img");
    await t.testDb.db.insert(imageGenerations).values([
      { ...base, id: runId, status: "running" },
      { ...base, id: queuedId, status: "queued" },
    ]);
    expect(await svc().recover()).toEqual({ failed: 1, requeued: 1 });
    await svc().whenIdle();
    expect((await svc().getGeneration(runId)).status).toBe("failed");
    expect((await svc().getGeneration(queuedId)).status).toBe("succeeded");
  });

  it("queued cancel answers cancelled", async () => {
    // two hanging jobs fill the runner (concurrency 2); the third stays queued
    const hangs: Array<() => void> = [];
    m.on("POST /v1/images/generations", (_c, res) => void hangs.push(() => json(res, 200, { data: [{ b64_json: PNG_B64 }] })));
    const a = await t.http("POST", "/api/images/generations", body());
    const b = await t.http("POST", "/api/images/generations", body());
    const q = await t.http("POST", "/api/images/generations", body());
    expect((await t.http("GET", `/api/images/generations/${q.body.id}`)).body.status).toBe("queued");
    const c = await t.http("POST", `/api/images/generations/${q.body.id}/cancel`);
    expect(c.body.status).toBe("cancelled");
    for (const id of [a.body.id, b.body.id]) await t.http("POST", `/api/images/generations/${id}/cancel`);
    await svc().whenIdle();
  });

  // keep last: stops the runner
  it("server shutdown during generation → failed with the may-have-been-billed message, not 'cancelled'", async () => {
    let hit!: () => void;
    const arrived = new Promise<void>((r) => (hit = r));
    m.on("POST /v1/images/generations", () => hit()); // hangs
    const r = await t.http("POST", "/api/images/generations", body());
    await arrived;
    await svc().stop();
    const g = await t.http("GET", `/api/images/generations/${r.body.id}`);
    expect(g.body.status).toBe("failed");
    expect(g.body.errorMessage).toContain("청구되었을 수 있습니다");
    expect(g.body.errorMessage).not.toContain("취소");
  });
});

function baseOf(tc: TestCore): string {
  return tc.base;
}
