/**
 * 설계 추가 0011 (인터넷 검색): ModelCallPort `webSearch` — novel setting (default on, per-call cap), search policy in
 * the system prompt, the Anthropic server tool (`web_search_20260209` + `max_uses`), citations stored with the
 * provider call, per-search fee in the ledger, `pause_turn` resume, unsupported lanes, rerun reuse.
 * Real gateway → real Claude adapter → scripted Messages API (no network).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { LlmAdapter } from "../../src/modules/llm/index.js";
import { createLlmGateway } from "../../src/modules/llm/application/gateway.js";
import { webSearchToolFor } from "../../src/modules/llm/adapters/anthropic/anthropic-adapter.js";
import { createTestCore, TEST_ANTHROPIC_KEY, type TestCore } from "../support/test-core.js";
import { runHandle, seedTaskRun, stubBudget, type StubBudget } from "./support.js";

let t: TestCore;
let novelId: string;
let budget: StubBudget;
let gateway: ReturnType<typeof createLlmGateway>;
let adapterOverride: LlmAdapter | null = null;

const Reply = z.object({ reply_text: z.string().min(1) });
const SOURCES = [
  { url: "https://encykorea.aks.ac.kr/Article/E0060135", title: "포도대장 - 한국민족문화대백과사전" },
  { url: "https://en.wikipedia.org/wiki/Podocheong", title: "Podocheong - Wikipedia" },
];

const policy = async (scope: { novelId: string }) => {
  const n = await t.modules.novel.service.getNovel(scope);
  return { enabled: n.webSearchEnabled, maxUses: n.webSearchMaxUses };
};

beforeAll(async () => {
  t = await createTestCore();
  novelId = (await t.modules.novel.service.createNovel({}, t.owner)).id;
  const llm = t.modules.llm.service;
  budget = stubBudget(t);
  gateway = createLlmGateway({
    platform: t.platform,
    budget,
    getBinding: (scope, role) => llm.getBinding(scope, role),
    getProfile: (id) => llm.getProviderProfile(id),
    getAdapter: (p) => adapterOverride ?? llm.getAdapter(p),
    resolveApiKey: async () => TEST_ANTHROPIC_KEY,
    webSearchPolicy: policy,
    sleep: async () => {},
  });
});
afterAll(() => t.close());
beforeEach(async () => {
  t.claude.reset();
  adapterOverride = null;
  await t.modules.novel.service.updateSettings({ novelId }, { webSearchEnabled: true, webSearchMaxUses: 3 }, t.owner);
});

const ask = (runId: string, taskId: string, over: Partial<Parameters<typeof gateway.call>[0]> = {}) =>
  gateway.call({
    run: runHandle(novelId, taskId, runId, "concept_partner"),
    purpose: "concept_turn",
    system: "컨셉 파트너",
    messages: [{ role: "user", content: "조선 포도청 배경의 수사극이요" }],
    output: { kind: "object", schemaName: "Reply", schema: Reply },
    webSearch: true,
    ...over,
  });

describe("web search (ModelCallPort.webSearch)", () => {
  it("default on: server tool + max_uses, policy in the system prompt, citations stored and returned, fee in the ledger", async () => {
    const { taskId, runId } = await seedTaskRun(t, novelId);
    budget.calls.length = 0;
    t.claude.reply({ json: { reply_text: "포도청의 책임자는 포도대장이에요." }, webSearch: { query: "조선 포도청 직책", results: SOURCES } });
    const out = await ask(runId, taskId);
    expect(out.value).toEqual({ reply_text: "포도청의 책임자는 포도대장이에요." });
    const req = t.claude.requests[0]!;
    expect(req.body.tools).toEqual([{ type: "web_search_20260209", name: "web_search", max_uses: 3 }]);
    expect(req.system).toContain("## 인터넷 검색 (이 응답에서 최대 3회)");
    expect(req.system).toMatch(/원고 본문, 브리프·기획서 문장, 사용자 메시지를 그대로 검색어에 넣지 않/);
    expect(req.system).toMatch(/실존 인물/);
    // searching + object output → prompt-described JSON (no strict output_config next to citations), still validated
    expect(req.body.output_config).toBeUndefined();
    expect(req.schema).toMatchObject({ properties: { reply_text: { type: "string" } } });

    expect(out.webSearch).toMatchObject({ status: "used", requests: 1, citations: [{ url: SOURCES[0]!.url, title: SOURCES[0]!.title }] });
    expect(out.webSearch!.citations[0]!.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const [row] = await t.modules.llm.service.listProviderCalls({ novelId }, runId);
    expect(row!.response).toMatchObject({ webSearch: { status: "used", requests: 1, citations: [{ url: SOURCES[0]!.url }], queries: ["조선 포도청 직책"] } });
    expect(row!.usage).toMatchObject({ webSearchRequests: 1 });
    // reservation covers the searches; the settled amount includes the $0.01 search fee
    const reserve = Number(/^reserve:(\d+)$/.exec(budget.calls[0]!)![1]);
    const settle = Number(/^settle:(\d+):/.exec(budget.calls.find((c) => c.startsWith("settle"))!)![1]);
    expect(settle).toBeGreaterThanOrEqual(10_000);
    expect(reserve).toBeGreaterThan(30_000);
  });

  it("the novel setting decides: off → no tool and status disabled; the cap follows the setting and callers can only lower it", async () => {
    await t.modules.novel.service.updateSettings({ novelId }, { webSearchEnabled: false }, t.owner);
    const a = await seedTaskRun(t, novelId);
    t.claude.reply({ json: { reply_text: "검색 없이 답합니다." } });
    const off = await ask(a.runId, a.taskId);
    expect(t.claude.requests[0]!.body.tools).toBeUndefined();
    expect(t.claude.requests[0]!.system).not.toContain("인터넷 검색");
    expect(t.claude.requests[0]!.body.output_config).toBeDefined(); // strict JSON again
    expect(off.webSearch).toEqual({ status: "disabled", requests: 0, citations: [] });

    await t.modules.novel.service.updateSettings({ novelId }, { webSearchEnabled: true, webSearchMaxUses: 2 }, t.owner);
    const b = await seedTaskRun(t, novelId);
    t.claude.reply({ json: { reply_text: "상한 2" } }, { json: { reply_text: "상한 1" } }, { json: { reply_text: "상한 2 유지" } });
    await ask(b.runId, b.taskId, { messages: [{ role: "user", content: "상한 2" }] });
    await ask(b.runId, b.taskId, { messages: [{ role: "user", content: "상한 1" }], webSearch: { maxUses: 1 } });
    await ask(b.runId, b.taskId, { messages: [{ role: "user", content: "상한 9 요청" }], webSearch: { maxUses: 9 } });
    expect(t.claude.requests.slice(1).map((r) => (r.body.tools as Array<{ max_uses: number }>)[0]!.max_uses)).toEqual([2, 1, 2]);
    // no search happened → not_used, nothing to cite
    const c = await seedTaskRun(t, novelId);
    t.claude.reply({ json: { reply_text: "검색이 필요 없었어요." } });
    expect((await ask(c.runId, c.taskId, { messages: [{ role: "user", content: "검색 안 함" }] })).webSearch).toEqual({ status: "not_used", requests: 0, citations: [] });
    // calls without webSearch are unchanged (no tool, no flag)
    t.claude.reply({ json: { reply_text: "검색 요청 없음" } });
    const plain = await ask(c.runId, c.taskId, { messages: [{ role: "user", content: "검색 요청 없음" }], webSearch: undefined });
    expect(plain.webSearch).toBeUndefined();
    expect(t.claude.requests[t.claude.requests.length - 1]!.body.tools).toBeUndefined();
  });

  it("pause_turn: the paused assistant content is sent back and the answer after the last search is the output", async () => {
    const { taskId, runId } = await seedTaskRun(t, novelId);
    t.claude.reply(
      { json: { reply_text: "중간" }, stop: "pause_turn", webSearch: { query: "포도청", results: SOURCES.slice(0, 1) } },
      { json: { reply_text: "이어서 끝낸 답입니다." }, webSearch: { query: "포도대장 품계", results: SOURCES.slice(1), cite: true } },
    );
    const out = await ask(runId, taskId);
    expect(t.claude.requests).toHaveLength(2);
    const resumed = t.claude.requests[1]!;
    expect(resumed.messages[resumed.messages.length - 1]!.role).toBe("assistant");
    expect(out.value).toEqual({ reply_text: "이어서 끝낸 답입니다." });
    expect(out.webSearch).toMatchObject({ status: "used", requests: 2 });
    expect(out.webSearch!.citations.map((c) => c.url)).toEqual([SOURCES[0]!.url, SOURCES[1]!.url]);
  });

  it("an adapter that cannot search: the call runs without search and surfaces `unsupported`", async () => {
    const real = t.modules.llm.service.getAdapter("anthropic")!;
    const seen: unknown[] = [];
    adapterOverride = {
      provider: "anthropic",
      capabilities: (m) => real.capabilities(m),
      testEnvironment: async () => ({ status: "pass", message: "ok" }),
      webSearchSupport: () => "이 연결은 인터넷 검색을 지원하지 않습니다.",
      async invoke(req) {
        seen.push(req.webSearch ?? null);
        return { ok: true, object: { reply_text: "검색 없이" }, finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5 }, raw: null };
      },
    };
    const { taskId, runId } = await seedTaskRun(t, novelId);
    const out = await ask(runId, taskId);
    expect(seen).toEqual([null]);
    expect(out.webSearch).toEqual({ status: "unsupported", requests: 0, citations: [], note: "이 연결은 인터넷 검색을 지원하지 않습니다." });
  });

  it("RU-2: a rerun reuses the stored response with its sources (no new search, no new fee)", async () => {
    const { taskId, runId } = await seedTaskRun(t, novelId);
    t.claude.reply({ json: { reply_text: "출처 있는 답" }, webSearch: { query: "조선 포도청", results: SOURCES } });
    const first = await ask(runId, taskId);
    const rerun = await seedTaskRun(t, novelId, { taskId });
    budget.calls.length = 0;
    const second = await ask(rerun.runId, taskId, { run: runHandle(novelId, taskId, rerun.runId, "concept_partner", { rerunOfRunId: runId, runChain: [runId] }) });
    expect(second.reused).toBe(true);
    expect(second.webSearch).toEqual(first.webSearch);
    expect(budget.calls).toEqual([]);
    expect(t.claude.requests).toHaveLength(1);
  });

  it("tool version per model: dynamic filtering on current Opus / Sonnet / Fable, basic elsewhere", () => {
    expect(webSearchToolFor("claude-opus-5-5", 2)).toEqual({ type: "web_search_20260209", name: "web_search", max_uses: 2 });
    expect(webSearchToolFor("claude-sonnet-5-5", 2).type).toBe("web_search_20260209");
    expect(webSearchToolFor("claude-fable-5-1", 2).type).toBe("web_search_20260209");
    expect(webSearchToolFor("claude-haiku-5-5", 2).type).toBe("web_search_20250305");
  });

  it("PATCH novel validates the search settings (1~10) and the novel DTO carries them", async () => {
    const ok = await t.http("PATCH", `/api/novels/${novelId}`, { webSearchEnabled: false, webSearchMaxUses: 5 });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ webSearchEnabled: false, webSearchMaxUses: 5 });
    expect((await t.http("PATCH", `/api/novels/${novelId}`, { webSearchMaxUses: 11 })).status).toBe(400);
    expect((await t.http("PATCH", `/api/novels/${novelId}`, { webSearchMaxUses: 0 })).status).toBe(400);
    const fresh = await t.modules.novel.service.createNovel({}, t.owner);
    expect(fresh).toMatchObject({ webSearchEnabled: true, webSearchMaxUses: 3 });
  });
});
