import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestCore, TEST_ANTHROPIC_KEY, type TestCore } from "../support/test-core.js";
import { seedTaskRun, runHandle } from "./support.js";

let t: TestCore;
let novelId: string;
beforeAll(async () => {
  t = await createTestCore();
  novelId = (await t.modules.novel.service.createNovel({}, t.owner)).id;
});
afterAll(() => t.close());

describe("llm HTTP: provider profiles, bindings, connection test", () => {
  it("default anthropic profile has list-priced models, no other LLM provider is unknown, and every role is bound (INV-NOV-06)", async () => {
    const r = await t.http("GET", "/api/llm/provider-profiles");
    expect(r.status).toBe(200);
    const claude = r.body.items.find((p: { provider: string; isActive: boolean }) => p.provider === "anthropic" && p.isActive);
    expect(claude.models.map((m: { id: string }) => m.id)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"]);
    expect(claude.models[0].input_price_micros_per_mtok).toBe(4_000_000);
    const llmProviders = new Set(r.body.items.filter((p: { providerKind?: string }) => (p.providerKind ?? "llm") === "llm").map((p: { provider: string }) => p.provider));
    expect([...llmProviders].sort()).toEqual(["anthropic", "claude_code", "google", "openai", "xai"]);

    const b = await t.http("GET", `/api/novels/${novelId}/model-bindings`);
    expect(b.body.items).toHaveLength(10);
    const writer = b.body.items.find((x: { agentRole: string }) => x.agentRole === "writer");
    expect(writer).toMatchObject({ modelId: "claude-opus-5-5", maxOutputTokens: 16000 });
  });

  it("PATCH binding validates against the profile and audits model_binding.changed", async () => {
    const ok = await t.http("PATCH", `/api/novels/${novelId}/model-bindings/writer`, { modelId: "claude-sonnet-5-5", maxOutputTokens: 12000 });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ agentRole: "writer", modelId: "claude-sonnet-5-5", maxOutputTokens: 12000 });
    const act = await t.http("GET", `/api/novels/${novelId}/activity?actionPrefix=model_binding.`);
    expect(act.body.items[0]).toMatchObject({ action: "model_binding.changed" });
    expect(act.body.items[0].before.modelId).toBe("claude-opus-5-5");
    expect(act.body.items[0].after.modelId).toBe("claude-sonnet-5-5");

    const bad = await t.http("PATCH", `/api/novels/${novelId}/model-bindings/writer`, { modelId: "gpt-4" });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("model_not_in_profile");
    const tooBig = await t.http("PATCH", `/api/novels/${novelId}/model-bindings/writer`, { maxOutputTokens: 128_001 });
    expect(tooBig.status).toBe(400);
    const fb = await t.http("PATCH", `/api/novels/${novelId}/model-bindings/writer`, { fallbackEnabled: true });
    expect(fb.status).toBe(422);
    const empty = await t.http("PATCH", `/api/novels/${novelId}/model-bindings/writer`, {});
    expect(empty.status).toBe(400);
    const role = await t.http("PATCH", `/api/novels/${novelId}/model-bindings/nobody`, { modelId: "x" });
    expect(role.status).toBe(400);
  });

  it("PATCH provider profile updates prices and audits provider_profile.changed (install level)", async () => {
    const list = await t.http("GET", "/api/llm/provider-profiles");
    const prof = list.body.items.find((p: { provider: string; isActive: boolean }) => p.provider === "anthropic" && p.isActive);
    const models = prof.models.map((m: Record<string, unknown>) => ({ ...m, input_price_micros_per_mtok: 1, output_price_micros_per_mtok: 2 }));
    const r = await t.http("PATCH", `/api/llm/provider-profiles/${prof.id}`, { models, priceSourceUrl: "https://example.invalid/prices" });
    expect(r.status).toBe(200);
    expect(r.body.models[0].output_price_micros_per_mtok).toBe(2);
    // INV-PP-01: a price change is a new version row; the old one is deactivated and bindings follow
    expect(r.body).toMatchObject({ versionNo: prof.versionNo + 1, isActive: true });
    expect(r.body.id).not.toBe(prof.id);
    const after = (await t.http("GET", "/api/llm/provider-profiles")).body.items as Array<{ id: string; isActive: boolean }>;
    expect(after.find((p) => p.id === prof.id)!.isActive).toBe(false);
    const bindings = (await t.http("GET", `/api/novels/${novelId}/model-bindings`)).body.items as Array<{ providerProfileId: string }>;
    expect(new Set(bindings.map((b) => b.providerProfileId))).toEqual(new Set([r.body.id]));
    const act = await t.http("GET", "/api/activity?actionPrefix=provider_profile.");
    expect(act.body.items[0]).toMatchObject({ action: "provider_profile.changed" });
  });

  it("POST /api/llm/test and the llm_key health check pass against the (mock) Claude API with a key; without a key they fail", async () => {
    const r = await t.http("POST", "/api/llm/test", {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ provider: "anthropic", status: "pass", errorFamily: null });
    const h = await t.modules.system.service.runHealthChecks({ kinds: ["llm_key"] });
    expect(h.map((x) => [x.name, x.status])).toEqual([["llm.anthropic", "pass"]]);
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await t.modules.system.service.secrets.delete("llm.anthropic.api_key");
      const a = await t.http("POST", "/api/llm/test", { provider: "anthropic" });
      expect(a.body).toMatchObject({ provider: "anthropic", status: "fail", errorFamily: "auth_failed" });
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
      await t.modules.system.service.secrets.set("llm.anthropic.api_key", TEST_ANTHROPIC_KEY, "test key");
    }
  });

  it("GET …/runs/:runId/provider-calls lists the run's calls", async () => {
    const { taskId, runId } = await seedTaskRun(t, novelId);
    t.claude.reply({ when: { prompt: "안녕" }, text: "안녕하세요." });
    await t.modules.llm.service.modelCalls.call({ run: runHandle(novelId, taskId, runId), purpose: "x", system: "s", messages: [{ role: "user", content: "안녕" }], output: { kind: "text" } });
    const r = await t.http("GET", `/api/novels/${novelId}/runs/${runId}/provider-calls`);
    expect(r.status).toBe(200);
    // journaled only when the budget module is implemented (otherwise calls run unrecorded)
    expect(r.body.items.length).toBe(t.modules.budget.implemented ? 1 : 0);
    const usage = await t.modules.llm.service.runUsage({ novelId }, runId);
    expect(usage.calls).toBe(r.body.items.length);
  });
});
