import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ModelCallError } from "../../src/modules/llm/index.js";
import { createLlmGateway } from "../../src/modules/llm/application/gateway.js";
import { RunStop } from "../../src/modules/orchestration/index.js";
import { createTestCore, TEST_ANTHROPIC_KEY, type TestCore } from "../support/test-core.js";
import { runHandle, seedTaskRun, stubBudget, type StubBudget } from "./support.js";

let t: TestCore;
let novelId: string;
let budget: StubBudget;
let gateway: ReturnType<typeof createLlmGateway>;
let sleeps: number[];

const OUTLINE_OK = { title: "회귀의 시작", beats: [{ ord: 1, description: "짐꾼이 눈을 뜬다" }, { ord: 2, description: "과거를 깨닫는다" }, { ord: 3, description: "첫 선택" }] };
const Outline = z.object({ title: z.string().min(1), beats: z.array(z.object({ ord: z.number().int(), description: z.string() })).min(3) });

beforeAll(async () => {
  t = await createTestCore();
  novelId = (await t.modules.novel.service.createNovel({}, t.owner)).id;
  const llm = t.modules.llm.service;
  budget = stubBudget(t);
  sleeps = [];
  gateway = createLlmGateway({
    platform: t.platform,
    budget,
    getBinding: (scope, role) => llm.getBinding(scope, role),
    getProfile: (id) => llm.getProviderProfile(id),
    // the real Claude adapter against the scripted Messages API mock (t.claude)
    getAdapter: (p) => llm.getAdapter(p),
    resolveApiKey: async () => TEST_ANTHROPIC_KEY,
    sleep: async (ms) => void sleeps.push(ms),
  });
});
afterAll(() => t.close());
beforeEach(() => t.claude.reset());

const calls = (runId: string) => t.modules.llm.service.listProviderCalls({ novelId }, runId);

describe("ModelCallPort (LlmGateway)", () => {
  it("P1→P2→P3: reserves, journals, settles and returns a zod-validated object", async () => {
    const { taskId, runId } = await seedTaskRun(t, novelId);
    budget.calls.length = 0;
    t.claude.reply({ when: { prompt: "제1화 아웃라인", schemaHas: ["title", "beats"] }, json: OUTLINE_OK });
    const out = await gateway.call({
      run: runHandle(novelId, taskId, runId, "planner"),
      purpose: "outline",
      system: "기획자",
      messages: [{ role: "user", content: "제1화 아웃라인" }],
      output: { kind: "object", schemaName: "outline_episode", schema: Outline },
    });
    expect(out.reused).toBe(false);
    expect(out.value).toEqual(OUTLINE_OK);
    expect(t.claude.requests).toHaveLength(1);
    expect(out.modelId).toBe("claude-opus-5-5"); // planner default binding
    const rows = await calls(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "responded", seq: 1, provider: "anthropic", idempotencyKey: `${taskId}:${runId}:1`, maxOutputTokens: 6000 });
    expect(rows[0]!.response).toMatchObject({ object: OUTLINE_OK });
    expect(budget.calls).toEqual([expect.stringMatching(/^reserve:\d+$/), "attach", expect.stringMatching(/^settle:[1-9]\d*:measured:false$/)]);
  });

  it("RU-2: a rerun of the same task reuses the stored response without a new call or reservation", async () => {
    const { taskId, runId } = await seedTaskRun(t, novelId);
    const input = { purpose: "outline", system: "기획자", messages: [{ role: "user" as const, content: "제9화 아웃라인" }], output: { kind: "object" as const, schemaName: "outline_episode", schema: Outline } };
    t.claude.reply({ json: OUTLINE_OK }, { json: { ...OUTLINE_OK, title: "두 번째 표본" } });
    const first = await gateway.call({ ...input, run: runHandle(novelId, taskId, runId, "planner") });
    const rerun = await seedTaskRun(t, novelId, { taskId });
    budget.calls.length = 0;
    const second = await gateway.call({ ...input, run: runHandle(novelId, taskId, rerun.runId, "planner", { rerunOfRunId: runId, runChain: [runId] }) });
    expect(second.reused).toBe(true);
    expect(second.providerCallId).toBe(first.providerCallId);
    expect(second.costMicros).toBe(0);
    expect(second.value).toEqual(first.value);
    expect(budget.calls).toEqual([]);
    expect(await calls(rerun.runId)).toHaveLength(0);
    expect(t.claude.requests).toHaveLength(1);
    // a different sample index is a different request (RU-4)
    const third = await gateway.call({ ...input, sampleIndex: 1, run: runHandle(novelId, taskId, rerun.runId, "planner", { rerunOfRunId: runId, runChain: [runId] }) });
    expect(third.reused).toBe(false);
    expect((third.value as z.infer<typeof Outline>).title).toBe("두 번째 표본");
  });

  it("RU-2 scope (review regression): an ordinary retry run outside the rerun chain gets a fresh sample", async () => {
    const { taskId, runId } = await seedTaskRun(t, novelId);
    const input = { purpose: "outline", system: "기획자", messages: [{ role: "user" as const, content: "제10화 아웃라인" }], output: { kind: "object" as const, schemaName: "outline_episode", schema: Outline } };
    t.claude.reply({ times: 4, json: { nope: 1 } });
    const e1 = await gateway.call({ ...input, run: runHandle(novelId, taskId, runId, "planner") }).catch((e) => e);
    expect(e1.errorFamily).toBe("invalid_output");
    t.claude.reply({ json: OUTLINE_OK });
    const before = t.claude.requests.length;
    const retry = await seedTaskRun(t, novelId, { taskId });
    const out = await gateway.call({ ...input, run: runHandle(novelId, taskId, retry.runId, "planner", { attempt: 2, rerunOfRunId: null, runChain: [] }) });
    expect(out.reused).toBe(false);
    expect(out.value).toEqual(OUTLINE_OK);
    expect(t.claude.requests.length - before).toBe(1);
  });

  it("invalid output → repair retry with zod errors appended (new call row, retry_of_call_id)", async () => {
    const { taskId, runId } = await seedTaskRun(t, novelId);
    t.claude.reply({ json: { title: "" } }, { when: { prompt: "스키마 검증 실패" }, json: OUTLINE_OK });
    const out = await gateway.call({
      run: runHandle(novelId, taskId, runId, "planner"),
      purpose: "outline",
      system: "s",
      messages: [{ role: "user", content: "제2화" }],
      output: { kind: "object", schemaName: "outline_episode", schema: Outline },
    });
    expect(out.value).toEqual(OUTLINE_OK);
    const rows = await calls(runId);
    expect(rows.map((r) => r.status)).toEqual(["responded", "responded"]);
    expect(rows[1]!.retryOfCallId).toBe(rows[0]!.id);
    expect(rows[0]!.requestHash).not.toBe(rows[1]!.requestHash);
    const repairMsg = t.claude.requests.at(-1)!.messages.at(-1)!.content;
    expect(repairMsg).toMatch(/스키마 검증 실패/);
  });

  it("gives up with ModelCallError(invalid_output) after max retries", async () => {
    const { taskId, runId } = await seedTaskRun(t, novelId);
    t.claude.reply({ times: 10, json: { nope: 1 } });
    const err = await gateway
      .call({ run: runHandle(novelId, taskId, runId, "planner"), purpose: "outline", system: "s", messages: [{ role: "user", content: "x" }], output: { kind: "object", schemaName: "o", schema: Outline } })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ModelCallError);
    expect(err.errorFamily).toBe("invalid_output");
    expect(err.retryable).toBe(true);
    expect(await calls(runId)).toHaveLength(4); // 1 + llm.max_retries_per_call(3)
  });

  it("rate_limited → backoff retry (P4 failed + release, then success)", async () => {
    const { taskId, runId } = await seedTaskRun(t, novelId);
    sleeps.length = 0;
    budget.calls.length = 0;
    t.claude.reply({ error: { status: 429 } }, { text: "비가 그친 골목에서 그는 걸음을 멈췄다." });
    const out = await gateway.call({ run: runHandle(novelId, taskId, runId), purpose: "draft", system: "s", messages: [{ role: "user", content: "목표 분량: 500자" }], output: { kind: "text" } });
    expect(out.value).toBe("비가 그친 골목에서 그는 걸음을 멈췄다.");
    expect(sleeps).toEqual([5000]);
    expect((await calls(runId)).map((r) => [r.status, r.errorFamily])).toEqual([
      ["failed", "rate_limited"],
      ["responded", null],
    ]);
    expect(budget.calls).toContain("release");
  });

  it("auth_failed is terminal (not retryable)", async () => {
    const { taskId, runId } = await seedTaskRun(t, novelId);
    t.claude.reply({ error: { status: 401 } });
    const err = await gateway.call({ run: runHandle(novelId, taskId, runId), purpose: "x", system: "s", messages: [{ role: "user", content: "x" }], output: { kind: "text" } }).catch((e) => e);
    expect(err).toBeInstanceOf(ModelCallError);
    expect(err.errorFamily).toBe("auth_failed");
    expect(err.retryable).toBe(false);
    expect(t.claude.requests).toHaveLength(1);
  });

  it("P5: an interrupted/timed-out call is closed as unknown with closeUnknown (FR-AGT-02 (3))", async () => {
    const { taskId, runId } = await seedTaskRun(t, novelId);
    budget.calls.length = 0;
    const ac = new AbortController();
    t.claude.reply({ hang: true });
    const p = gateway.call({ run: runHandle(novelId, taskId, runId, "writer", { signal: ac.signal }), purpose: "draft", system: "s", messages: [{ role: "user", content: "x" }], output: { kind: "text" } });
    await expect.poll(() => t.claude.requests.length).toBe(1);
    ac.abort();
    const err = await p.catch((e) => e);
    // an aborted run signal is a stop (engine: paused/lease_lost path, no attempt used), not a model failure
    expect(err).toBeInstanceOf(RunStop);
    const rows = await calls(runId);
    expect(rows.map((r) => r.status)).toEqual(["unknown"]);
    expect(budget.calls).toContain("closeUnknown");
  });

  it("P6: stop at the checkpoint after prepare → abandoned + released, RunStop propagates", async () => {
    const { taskId, runId } = await seedTaskRun(t, novelId);
    budget.calls.length = 0;
    let n = 0;
    const run = runHandle(novelId, taskId, runId, "writer", {
      checkpoint: async () => {
        if (++n === 2) throw new RunStop("paused");
      },
    });
    const err = await gateway.call({ run, purpose: "draft", system: "s", messages: [{ role: "user", content: "x" }], output: { kind: "text" } }).catch((e) => e);
    expect(err).toBeInstanceOf(RunStop);
    expect((await calls(runId)).map((r) => r.status)).toEqual(["abandoned"]);
    expect(budget.calls).toEqual([expect.stringMatching(/^reserve:\d+$/), "attach", "release"]);
    expect(t.claude.requests).toHaveLength(0);
  });

  it("budget denial → ModelCallError(budget_blocked), no provider call row", async () => {
    const { taskId, runId } = await seedTaskRun(t, novelId);
    budget.denyNext = "hard_limit";
    const err = await gateway.call({ run: runHandle(novelId, taskId, runId), purpose: "x", system: "s", messages: [{ role: "user", content: "x" }], output: { kind: "text" } }).catch((e) => e);
    expect(err.errorFamily).toBe("budget_blocked");
    expect(err.retryable).toBe(false);
    expect(await calls(runId)).toHaveLength(0);
  });

  it("content_filtered → one retry with reinforced safety instructions", async () => {
    const { taskId, runId } = await seedTaskRun(t, novelId);
    t.claude.reply({ stop: "refusal", text: "" }, { when: { system: "안전 지시 강화" }, text: "수위를 낮춘 장면." });
    const out = await gateway.call({ run: runHandle(novelId, taskId, runId), purpose: "draft", system: "원래 시스템", messages: [{ role: "user", content: "x" }], output: { kind: "text" } });
    expect(out.value).toBe("수위를 낮춘 장면.");
    expect(t.claude.requests[0]!.system).not.toMatch(/안전 지시 강화/);
    expect(t.claude.requests.at(-1)!.system).toMatch(/안전 지시 강화/);
  });

  it("clamps maxOutputTokens to the binding and records it (FR-AGT-08)", async () => {
    const { taskId, runId } = await seedTaskRun(t, novelId);
    t.claude.reply({ text: "짧은 답." });
    await gateway.call({ run: runHandle(novelId, taskId, runId, "writer"), purpose: "x", system: "s", messages: [{ role: "user", content: "x" }], output: { kind: "text" }, maxOutputTokens: 999_999 });
    expect((await calls(runId))[0]!.maxOutputTokens).toBe(16000);
    expect(t.claude.requests[0]!.maxTokens).toBe(16000);
  });

  it("module service path works end-to-end with the default provider (Claude adapter → scripted API)", async () => {
    const { taskId, runId } = await seedTaskRun(t, novelId);
    const body = "그날 밤, 짐꾼은 다시 눈을 떴다.";
    t.claude.reply({ when: { text: true, prompt: "제1화 본문" }, text: body });
    const out = await t.modules.llm.service.modelCalls.call({
      run: runHandle(novelId, taskId, runId, "writer"),
      purpose: "draft",
      system: "작가",
      messages: [{ role: "user", content: "제1화 본문\n목표 분량: 5000~5500자" }],
      output: { kind: "text" },
    });
    expect(out.value).toBe(body);
    expect(out.modelId).toBe("claude-opus-5-5");
  });
});
