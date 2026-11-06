/**
 * Install settings → 모델: model-list edits as new profile versions, in-use guard, 새 작품 기본 모델 at novel creation,
 * binding validation (disabled / unknown model, unconnected provider), provider model catalogs, and the concept-page
 * picker path (PATCH …/model-bindings/concept_partner → the next concept-partner call uses that model).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { json, startMockHttp, type MockHttp } from "./mock-http.js";
import { runHandle, seedTaskRun } from "./support.js";

let t: TestCore;
let m: MockHttp;
let novelId: string;

interface Profile {
  id: string;
  provider: string;
  providerKind: string;
  versionNo: number;
  isActive: boolean;
  models: Array<{ id: string; label?: string; input_price_micros_per_mtok: number | null; output_price_micros_per_mtok: number | null; disabled?: boolean }>;
}

const profiles = async (): Promise<Profile[]> => (await t.http("GET", "/api/llm/provider-profiles")).body.items;
const active = async (provider: string) => (await profiles()).find((p) => p.provider === provider && p.providerKind === "llm" && p.isActive)!;
const bindings = async (id = novelId) =>
  (await t.http("GET", `/api/novels/${id}/model-bindings`)).body.items as Array<{ agentRole: string; providerProfileId: string; modelId: string; maxOutputTokens: number }>;

beforeAll(async () => {
  m = await startMockHttp();
  t = await createTestCore({ config: { llm: { endpoints: { openai_api_base_url: m.base, xai_api_base_url: m.base, google_api_base_url: m.base } } } as never });
  novelId = (await t.modules.novel.service.createNovel({ title: "모델 테스트" }, t.owner)).id;
});
afterAll(async () => {
  await t.close();
  await m.close();
});

describe("install settings → 모델: profile model edits", () => {
  it("add / edit / remove each create a new profile version; the old version stays unchanged and inactive; bindings follow", async () => {
    const v1 = await active("anthropic");
    const add = await t.http("POST", `/api/llm/provider-profiles/${v1.id}/models`, { id: "claude-fable-5", label: "Claude Fable 5", input_price_micros_per_mtok: 3_000_000, output_price_micros_per_mtok: 15_000_000, max_output_tokens: 64_000 });
    expect(add.status).toBe(201);
    expect(add.body).toMatchObject({ provider: "anthropic", versionNo: v1.versionNo + 1, isActive: true });
    expect(add.body.models.map((x: { id: string }) => x.id)).toContain("claude-fable-5");
    const old = (await profiles()).find((p) => p.id === v1.id)!;
    expect(old.isActive).toBe(false);
    expect(old.models).toEqual(v1.models); // history is never edited (cost events keep their version)
    expect(new Set((await bindings()).map((b) => b.providerProfileId))).toEqual(new Set([add.body.id]));

    // a stale profile id (already replaced) → 409, nothing changes
    const stale = await t.http("POST", `/api/llm/provider-profiles/${v1.id}/models`, { id: "x-model" });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("profile_outdated");
    const dup = await t.http("POST", `/api/llm/provider-profiles/${add.body.id}/models`, { id: "claude-fable-5" });
    expect(dup.status).toBe(422);
    expect(dup.body.error.code).toBe("model_exists");
    const badId = await t.http("POST", `/api/llm/provider-profiles/${add.body.id}/models`, { id: "bad id with spaces" });
    expect(badId.status).toBe(400);

    // edit label + make it unpriced → new version; the budget treats null prices as unpriced (asks before calls)
    const edit = await t.http("PATCH", `/api/llm/provider-profiles/${add.body.id}/models/claude-fable-5`, { label: "Fable", input_price_micros_per_mtok: null, output_price_micros_per_mtok: null });
    expect(edit.status).toBe(200);
    expect(edit.body.versionNo).toBe(add.body.versionNo + 1);
    expect(edit.body.models.find((x: { id: string }) => x.id === "claude-fable-5")).toMatchObject({ label: "Fable", input_price_micros_per_mtok: null, output_price_micros_per_mtok: null });

    const rm = await t.http("DELETE", `/api/llm/provider-profiles/${edit.body.id}/models/claude-fable-5`);
    expect(rm.status).toBe(200);
    expect(rm.body.versionNo).toBe(edit.body.versionNo + 1);
    expect(rm.body.models.map((x: { id: string }) => x.id)).not.toContain("claude-fable-5");

    const act = await t.http("GET", "/api/activity?actionPrefix=provider_profile.");
    expect(act.body.items.slice(0, 3).map((e: { details: { op: string } }) => e.details.op)).toEqual(["remove", "edit", "add"]);
  });

  it("removing or switching off a model a binding / 새 작품 기본 모델 uses is refused with who uses it (409 model_in_use)", async () => {
    const p = await active("anthropic");
    const rm = await t.http("DELETE", `/api/llm/provider-profiles/${p.id}/models/claude-opus-5-5`);
    expect(rm.status).toBe(409);
    expect(rm.body.error.code).toBe("model_in_use");
    expect(rm.body.error.message).toContain("모델 테스트");
    const usage = rm.body.error.details.usage[0];
    expect(usage.modelId).toBe("claude-opus-5-5");
    expect(usage.bindings).toContainEqual({ novelId, novelTitle: "모델 테스트", agentRole: "writer", asFallback: false });
    const off = await t.http("PATCH", `/api/llm/provider-profiles/${p.id}/models/claude-opus-5-5`, { disabled: true });
    expect(off.status).toBe(409);
    // the whole-list PATCH has the same guard
    const whole = await t.http("PATCH", `/api/llm/provider-profiles/${p.id}`, { models: p.models.filter((x) => x.id !== "claude-opus-5-5") });
    expect(whole.status).toBe(409);
    expect((await active("anthropic")).id).toBe(p.id);

    // an unused model can be switched off; then it cannot be bound (422 model_disabled) and on again
    const hk = await t.http("PATCH", `/api/llm/provider-profiles/${p.id}/models/claude-haiku-5-5`, { disabled: true });
    expect(hk.status).toBe(200);
    expect(hk.body.models.find((x: { id: string }) => x.id === "claude-haiku-5-5").disabled).toBe(true);
    const bind = await t.http("PATCH", `/api/novels/${novelId}/model-bindings/line_editor`, { modelId: "claude-haiku-5-5" });
    expect(bind.status).toBe(422);
    expect(bind.body.error.code).toBe("model_disabled");
    const on = await t.http("PATCH", `/api/llm/provider-profiles/${hk.body.id}/models/claude-haiku-5-5`, { disabled: false });
    expect(on.body.models.find((x: { id: string }) => x.id === "claude-haiku-5-5").disabled).toBeUndefined();
  });

  it("reset restores the built-in list (new version) unless a bound model would disappear", async () => {
    const p = await active("anthropic");
    const add = await t.http("POST", `/api/llm/provider-profiles/${p.id}/models`, { id: "claude-extra" });
    expect(add.status).toBe(201);
    const bind = await t.http("PATCH", `/api/novels/${novelId}/model-bindings/scene_director`, { modelId: "claude-extra" });
    expect(bind.status).toBe(200);
    const refused = await t.http("POST", `/api/llm/provider-profiles/${add.body.id}/reset-models`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.details.usage[0].bindings[0]).toMatchObject({ agentRole: "scene_director" });
    await t.http("PATCH", `/api/novels/${novelId}/model-bindings/scene_director`, { modelId: "claude-sonnet-5-5" });
    const reset = await t.http("POST", `/api/llm/provider-profiles/${add.body.id}/reset-models`);
    expect(reset.status).toBe(200);
    expect(reset.body.models.map((x: { id: string }) => x.id)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
    expect(reset.body.versionNo).toBe(add.body.versionNo + 1);
  });
});

describe("새 작품 기본 모델 (role_model_defaults)", () => {
  it("builtin until set; a set default is used by new novels; reset goes back; invalid targets are refused", async () => {
    const before = await t.http("GET", "/api/llm/role-defaults");
    expect(before.status).toBe(200);
    expect(before.body.items).toHaveLength(10);
    expect(before.body.items.every((d: { source: string; provider: string; modelId: string }) => d.source === "builtin" && d.provider === "anthropic" && d.modelId === "claude-opus-5-5")).toBe(true);

    const set = await t.http("PUT", "/api/llm/role-defaults", {
      items: [
        { agentRole: "concept_partner", provider: "anthropic", modelId: "claude-sonnet-5-5" },
        { agentRole: "line_editor", provider: "anthropic", modelId: "claude-haiku-5-5" },
      ],
    });
    expect(set.status).toBe(200);
    expect(set.body.items.find((d: { agentRole: string }) => d.agentRole === "concept_partner")).toMatchObject({ source: "custom", modelId: "claude-sonnet-5-5", usable: true });

    const created = (await t.http("POST", "/api/novels", { title: "새 작품" })).body;
    const b = await bindings(created.id);
    expect(b.find((x) => x.agentRole === "concept_partner")!.modelId).toBe("claude-sonnet-5-5");
    expect(b.find((x) => x.agentRole === "line_editor")!.modelId).toBe("claude-haiku-5-5");
    expect(b.find((x) => x.agentRole === "writer")!.modelId).toBe("claude-opus-5-5");

    // a default counts as "in use": its model cannot be removed
    const p = await active("anthropic");
    await t.http("PATCH", `/api/novels/${created.id}/model-bindings/line_editor`, { modelId: "claude-sonnet-5-5" });
    const rm = await t.http("DELETE", `/api/llm/provider-profiles/${p.id}/models/claude-haiku-5-5`);
    expect(rm.status).toBe(409);
    expect(rm.body.error.details.usage[0].defaults).toEqual(["line_editor"]);

    const unknown = await t.http("PUT", "/api/llm/role-defaults", { items: [{ agentRole: "writer", provider: "anthropic", modelId: "claude-nope" }] });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe("model_not_in_profile");
    const unconnected = await t.http("PUT", "/api/llm/role-defaults", { items: [{ agentRole: "writer", provider: "openai", modelId: "gpt-6.1-sol" }] });
    expect(unconnected.status).toBe(422);
    expect(unconnected.body.error.code).toBe("provider_not_connected");
    const devOnly = await t.http("PUT", "/api/llm/role-defaults", { items: [{ agentRole: "writer", provider: "claude_code", modelId: "claude-opus-5-5" }] });
    expect(devOnly.status).toBe(422);

    const one = await t.http("DELETE", "/api/llm/role-defaults?role=line_editor");
    expect(one.body.items.find((d: { agentRole: string }) => d.agentRole === "line_editor").source).toBe("builtin");
    const all = await t.http("DELETE", "/api/llm/role-defaults");
    expect(all.body.items.every((d: { source: string }) => d.source === "builtin")).toBe(true);
    const act = await t.http("GET", "/api/activity?actionPrefix=settings.");
    expect(act.body.items[0]).toMatchObject({ action: "settings.changed", details: { setting: "role_model_defaults", reset: "all" } });
  });

  it("a default whose model was later switched off falls back to the built-in model at creation", async () => {
    await t.http("PUT", "/api/llm/role-defaults", { items: [{ agentRole: "planner", provider: "anthropic", modelId: "claude-sonnet-5-5" }] });
    // simulate an out-of-band change (e.g. an older row): the default stays stored but is no longer usable
    await t.testDb.query("UPDATE role_model_defaults SET model_id = 'claude-gone' WHERE agent_role = 'planner'");
    const d = (await t.http("GET", "/api/llm/role-defaults")).body.items.find((x: { agentRole: string }) => x.agentRole === "planner");
    expect(d).toMatchObject({ source: "custom", usable: false });
    const created = (await t.http("POST", "/api/novels", { title: "대체" })).body;
    expect((await bindings(created.id)).find((x) => x.agentRole === "planner")!.modelId).toBe("claude-opus-5-5");
    await t.http("DELETE", "/api/llm/role-defaults");
  });
});

describe("binding validation + model catalogs", () => {
  it("unknown model → 422; unconnected provider → 422 provider_not_connected; connected → ok", async () => {
    const unknown = await t.http("PATCH", `/api/novels/${novelId}/model-bindings/writer`, { modelId: "claude-nope" });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe("model_not_in_profile");
    const openai = await active("openai");
    const refused = await t.http("PATCH", `/api/novels/${novelId}/model-bindings/writer`, { providerProfileId: openai.id, modelId: "gpt-6.1-sol" });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe("provider_not_connected");

    m.on("GET /v1/models", (c, res) => {
      if (c.headers.authorization !== "Bearer sk-test-openai-key-123") return json(res, 401, { error: { message: "bad key" } });
      json(res, 200, { data: [{ id: "gpt-6.1-sol" }, { id: "gpt-7-preview" }, { id: "gpt-6.1-sol" }] });
    });
    const key = await t.http("PUT", "/api/providers/openai/api-key", { apiKey: "sk-test-openai-key-123" });
    expect(key.status).toBe(200);
    const ok = await t.http("PATCH", `/api/novels/${novelId}/model-bindings/writer`, { providerProfileId: openai.id, modelId: "gpt-6.1-sol" });
    expect(ok.status).toBe(200);

    // catalog: listed with the connected key, marked when already in the profile; the key never comes back
    const cat = await t.http("GET", "/api/llm/providers/openai/available-models");
    expect(cat.status).toBe(200);
    expect(cat.body).toMatchObject({ provider: "openai", source: "api" });
    expect(cat.body.items.map((x: { id: string; inProfile: boolean }) => [x.id, x.inProfile])).toEqual([
      ["gpt-6.1-sol", true],
      ["gpt-7-preview", false],
    ]);
    expect(JSON.stringify(cat.body)).not.toContain("sk-test-openai-key-123");
    // no key → 422; the subscription CLI gets a fixed list (no `claude` spawn)
    const none = await t.http("GET", "/api/llm/providers/google/available-models");
    expect(none.status).toBe(422);
    expect(none.body.error.code).toBe("model_list_unavailable");
    const cc = await t.http("GET", "/api/llm/providers/claude_code/available-models");
    expect(cc.body.source).toBe("fixed");
    expect(cc.body.items.map((x: { id: string }) => x.id)).toEqual(expect.arrayContaining(["claude-opus-5-5", "opus", "sonnet"]));
    const badProvider = await t.http("GET", "/api/llm/providers/nobody/available-models");
    expect(badProvider.status).toBe(400);

    await t.http("PATCH", `/api/novels/${novelId}/model-bindings/writer`, { providerProfileId: (await active("anthropic")).id, modelId: "claude-opus-5-5" });
  });

  it("a 새 작품 기본 모델 of a provider that lost its connection is not used for new novels (and shows as unusable)", async () => {
    // openai is connected (API key) from the previous test
    const set = await t.http("PUT", "/api/llm/role-defaults", { items: [{ agentRole: "writer", provider: "openai", modelId: "gpt-6.1-sol" }] });
    expect(set.status).toBe(200);
    const first = (await t.http("POST", "/api/novels", { title: "연결됨" })).body;
    expect((await bindings(first.id)).find((x) => x.agentRole === "writer")!.modelId).toBe("gpt-6.1-sol");
    expect((await t.http("DELETE", "/api/providers/openai/connection?method=api_key")).status).toBe(200);
    const d = (await t.http("GET", "/api/llm/role-defaults")).body.items.find((x: { agentRole: string }) => x.agentRole === "writer");
    expect(d).toMatchObject({ source: "custom", provider: "openai", usable: false });
    const second = (await t.http("POST", "/api/novels", { title: "연결 끊김" })).body;
    const w = (await bindings(second.id)).find((x) => x.agentRole === "writer")!;
    expect(w.modelId).toBe("claude-opus-5-5");
    expect(w.providerProfileId).toBe((await active("anthropic")).id);
    await t.http("DELETE", "/api/llm/role-defaults");
  });

  it("profile PATCH: switching off a profile in use → 409; old versions are never edited nor re-activated beside the active one", async () => {
    const cur = await active("anthropic");
    const off = await t.http("PATCH", `/api/llm/provider-profiles/${cur.id}`, { isActive: false });
    expect(off.status).toBe(409);
    expect(off.body.error.code).toBe("model_in_use");
    expect((await active("anthropic")).id).toBe(cur.id);

    const old = (await profiles()).find((p) => p.provider === "anthropic" && p.providerKind === "llm" && !p.isActive)!;
    const editOld = await t.http("PATCH", `/api/llm/provider-profiles/${old.id}`, { models: cur.models });
    expect(editOld.status).toBe(409);
    expect(editOld.body.error.code).toBe("profile_outdated");
    expect((await profiles()).find((p) => p.id === old.id)!.models).toEqual(old.models);
    const reactivate = await t.http("PATCH", `/api/llm/provider-profiles/${old.id}`, { isActive: true });
    expect(reactivate.status).toBe(409);
    expect((await profiles()).filter((p) => p.provider === "anthropic" && p.providerKind === "llm" && p.isActive)).toHaveLength(1);
  });

  it("a model switch without maxOutputTokens clamps the role's limit to the new model's cap (no 422)", async () => {
    const p = await active("anthropic");
    const add = await t.http("POST", `/api/llm/provider-profiles/${p.id}/models`, { id: "claude-small-cap", input_price_micros_per_mtok: 1_000_000, output_price_micros_per_mtok: 2_000_000, max_output_tokens: 2_000 });
    expect(add.status).toBe(201);
    const before = (await bindings()).find((b) => b.agentRole === "writer")!;
    expect(before.maxOutputTokens).toBeGreaterThan(2_000);
    const sw = await t.http("PATCH", `/api/novels/${novelId}/model-bindings/writer`, { modelId: "claude-small-cap" });
    expect(sw.status).toBe(200);
    expect(sw.body.maxOutputTokens).toBe(2_000);
    // an explicit limit over the cap is still refused
    const over = await t.http("PATCH", `/api/novels/${novelId}/model-bindings/writer`, { maxOutputTokens: 4_000 });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe("max_output_tokens_exceeded");
    // only the limit (same profile + model): no re-validation of the target → ok
    expect((await t.http("PATCH", `/api/novels/${novelId}/model-bindings/writer`, { maxOutputTokens: 1_500 })).status).toBe(200);
    await t.http("PATCH", `/api/novels/${novelId}/model-bindings/writer`, { modelId: "claude-opus-5-5", maxOutputTokens: before.maxOutputTokens });
  });

  it("concept picker path: PATCH concept_partner binding → the next concept-partner call uses that model", async () => {
    const r = await t.http("PATCH", `/api/novels/${novelId}/model-bindings/concept_partner`, { modelId: "claude-sonnet-5-5" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ agentRole: "concept_partner", modelId: "claude-sonnet-5-5" });
    t.claude.reset();
    t.claude.reply({ when: { prompt: "컨셉 피커" }, text: "좋아요." });
    const { taskId, runId } = await seedTaskRun(t, novelId, { role: "concept_partner" });
    const out = await t.modules.llm.service.modelCalls.call({
      run: runHandle(novelId, taskId, runId, "concept_partner"),
      purpose: "concept_turn",
      system: "s",
      messages: [{ role: "user", content: "컨셉 피커" }],
      output: { kind: "text" },
    });
    expect(out.modelId).toBe("claude-sonnet-5-5");
    expect(t.claude.requests.at(-1)!.model).toBe("claude-sonnet-5-5");
  });
});
