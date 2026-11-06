/**
 * Call timeouts: hard cap per provider (llm.provider_call_timeout_seconds → adapter limit → llm.call_timeout_seconds),
 * idle timeout for streaming calls (armed at the first received byte, reset on every chunk), board-ready timeout
 * messages naming provider · model · limit, the timed-out provider_call closed as `unknown`, and a single call-level
 * re-send of a stalled call on subscription lanes only.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ModelCallError, type LlmAdapter, type LlmCredential, type LlmInvokeOptions, type LlmResult } from "../../src/modules/llm/index.js";
import { callTimeoutMs, callWatchdog, createLlmGateway, timeoutMessage } from "../../src/modules/llm/application/gateway.js";
import { OpenAiLlmAdapter } from "../../src/modules/llm/adapters/openai/openai-adapter.js";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { startMockHttp, type MockHttp } from "./mock-http.js";
import { runHandle, seedTaskRun, stubBudget } from "./support.js";

describe("callWatchdog (idle timeout)", () => {
  afterEach(() => vi.useRealTimers());

  it("is not armed before the first progress ping, resets on progress, fires after silence", () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const wd = callWatchdog(parent.signal, 1_000);
    vi.advanceTimersByTime(5_000);
    expect(wd.signal.aborted).toBe(false); // nothing received yet: only the hard cap applies
    wd.progress();
    vi.advanceTimersByTime(900);
    wd.progress(); // bytes arrived → timer reset
    vi.advanceTimersByTime(900);
    expect(wd.signal.aborted).toBe(false);
    vi.advanceTimersByTime(200);
    expect(wd.signal.aborted).toBe(true);
    expect(wd.idleFired()).toBe(true);
    expect(parent.signal.aborted).toBe(false); // the run itself is not stopped
    wd.dispose();
  });

  it("follows the run's signal; idleMs 0 = off; dispose clears the timer", () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const off = callWatchdog(parent.signal, 0);
    off.progress();
    vi.advanceTimersByTime(60_000);
    expect(off.signal.aborted).toBe(false);
    parent.abort();
    expect(off.signal.aborted).toBe(true);
    expect(off.idleFired()).toBe(false);
    const wd = callWatchdog(new AbortController().signal, 1_000);
    wd.progress();
    wd.dispose();
    vi.advanceTimersByTime(5_000);
    expect(wd.signal.aborted).toBe(false);
  });
});

describe("per-provider hard cap and messages", () => {
  const cfg = (llm: Record<string, unknown>) => ({ llm: { call_timeout_seconds: 600, ...llm } }) as never;
  it("provider override → adapter limit (claude_code) → llm.call_timeout_seconds", () => {
    expect(callTimeoutMs(cfg({}), { provider: "openai" })).toBe(600_000);
    expect(callTimeoutMs(cfg({ provider_call_timeout_seconds: { openai: 900 } }), { provider: "openai" })).toBe(900_000);
    expect(callTimeoutMs(cfg({ provider_call_timeout_seconds: { openai: 900 } }), { provider: "google" })).toBe(600_000);
    expect(callTimeoutMs(cfg({}), { provider: "claude_code", limits: { callTimeoutMs: 1_200_000 } })).toBe(1_200_000);
    expect(callTimeoutMs(cfg({ provider_call_timeout_seconds: { claude_code: 1800 } }), { provider: "claude_code", limits: { callTimeoutMs: 1_200_000 } })).toBe(1_800_000);
  });
  it("names provider, model and the limit to change", () => {
    const hard = timeoutMessage("openai", "gpt-6-astra", { idle: false, idleMs: 300_000, timeoutMs: 180_000 });
    expect(hard).toContain("GPT");
    expect(hard).toContain("gpt-6-astra");
    expect(hard).toContain("180초 안에");
    expect(hard).toContain("llm.provider_call_timeout_seconds.openai");
    expect(timeoutMessage("claude_code", "claude-opus-5-5", { idle: false, idleMs: 0, timeoutMs: 1_200_000 })).toContain("llm.claude_code.call_timeout_seconds");
    expect(timeoutMessage("openai", "gpt-6-astra", { idle: true, idleMs: 300_000, timeoutMs: 600_000 })).toMatch(/300초 동안 끊겨.*상한 600초/);
  });
});

describe("gateway: timed-out calls", () => {
  let t: TestCore;
  let novelId: string;
  beforeAll(async () => {
    t = await createTestCore();
    novelId = (await t.modules.novel.service.createNovel({}, t.owner)).id;
  }, 60_000);
  afterAll(() => t.close());

  type Behaviour = (o: LlmInvokeOptions) => Promise<LlmResult>;
  /** scripted adapter posing as "openai" (the profile is the novel's bound one, provider relabelled) */
  function gatewayWith(behaviours: Behaviour[], method: LlmCredential["method"], llm: Record<string, unknown>) {
    const seen: LlmInvokeOptions[] = [];
    const adapter: LlmAdapter = {
      provider: "openai",
      capabilities: () => ({ structuredOutput: "json_schema", maxContextTokens: 200_000, maxOutputTokens: 64_000, promptCaching: false, reportsUsage: true, reportsCost: false, outputLimitCoversReasoning: true }),
      testEnvironment: async () => ({ status: "pass", message: "" }),
      async invoke(_req, o) {
        seen.push(o);
        return behaviours.shift()!(o);
      },
    };
    const svc = t.modules.llm.service;
    const platform = { ...t.platform, config: { ...t.platform.config, llm: { ...t.platform.config.llm, ...llm } } };
    const gateway = createLlmGateway({
      platform,
      budget: stubBudget(t),
      getBinding: async (scope, role) => ({ ...(await svc.getBinding(scope, role)), modelId: "gpt-6-astra" }),
      getProfile: async (id) => ({ ...(await svc.getProviderProfile(id)), provider: "openai" }),
      getAdapter: () => adapter,
      resolveCredential: async () => ({ method, token: "tok-test" }),
      sleep: async () => {},
    });
    return { gateway, seen };
  }
  const stall: Behaviour = (o) =>
    new Promise((resolve) => {
      o.onProgress?.(); // headers / first SSE event arrived, then silence
      o.signal.addEventListener("abort", () => resolve({ ok: false, errorFamily: "timeout", message: "LLM 응답 시간이 초과되었거나 호출이 중단되었습니다.", billed: "unknown" }), { once: true });
    });
  const slow: Behaviour = (o) =>
    new Promise((resolve) => {
      // adapter-side hard cap (linkedSignal) — no progress pings
      setTimeout(() => resolve({ ok: false, errorFamily: "timeout", message: "LLM 응답 시간이 초과되었거나 호출이 중단되었습니다.", billed: "unknown" }), o.timeoutMs);
    });
  const ok: Behaviour = async (o) => {
    o.onProgress?.();
    return { ok: true, text: "완료", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5 }, raw: null };
  };
  const call = async (gateway: ReturnType<typeof createLlmGateway>) => {
    const { taskId, runId } = await seedTaskRun(t, novelId, { role: "planner" });
    const p = gateway.call({ run: runHandle(novelId, taskId, runId, "planner"), purpose: "plan", system: "s", messages: [{ role: "user", content: "기획서" }], output: { kind: "text" } });
    return { p, runId };
  };
  const callsOf = (runId: string) => t.modules.llm.service.listProviderCalls({ novelId }, runId);

  it("hard cap per provider: actionable message (provider · model · limit), provider_call unknown/timeout, no call-level re-send", async () => {
    const { gateway, seen } = gatewayWith([slow], "chatgpt_oauth", { provider_call_timeout_seconds: { openai: 0.3 }, idle_timeout_seconds: 0 });
    const { p, runId } = await call(gateway);
    const err = (await p.catch((e) => e)) as ModelCallError;
    expect(err).toBeInstanceOf(ModelCallError);
    expect(err.errorFamily).toBe("timeout");
    expect(err.message).toMatch(/GPT.*gpt-6-astra.*0초 안에 끝나지 않았습니다/);
    expect(seen.map((o) => o.timeoutMs)).toEqual([300]);
    const rows = await callsOf(runId);
    expect(rows.map((r) => [r.status, r.errorFamily])).toEqual([["unknown", "timeout"]]);
  });

  it("idle timeout: a stalled stream is cut early; subscription lane re-sends it once (retry_of_call_id)", async () => {
    const { gateway, seen } = gatewayWith([stall, ok], "chatgpt_oauth", { call_timeout_seconds: 60, provider_call_timeout_seconds: {}, idle_timeout_seconds: 0.2 });
    const started = Date.now();
    const { p, runId } = await call(gateway);
    const out = await p;
    expect(out.value).toBe("완료");
    expect(Date.now() - started).toBeLessThan(5_000); // not the 60 s hard cap
    expect(seen).toHaveLength(2);
    const rows = await callsOf(runId);
    expect(rows.map((r) => r.status)).toEqual(["unknown", "responded"]);
    expect(rows[0]!.errorFamily).toBe("timeout");
    expect(rows[1]!.retryOfCallId).toBe(rows[0]!.id);
  });

  it("idle timeout on an API-key lane is not re-sent (possible duplicate billing) and says it stalled", async () => {
    const { gateway, seen } = gatewayWith([stall, ok], "api_key", { call_timeout_seconds: 60, provider_call_timeout_seconds: {}, idle_timeout_seconds: 0.2 });
    const { p, runId } = await call(gateway);
    const err = (await p.catch((e) => e)) as ModelCallError;
    expect(err.errorFamily).toBe("timeout");
    expect(err.message).toMatch(/gpt-6-astra.*동안 끊겨/);
    expect(seen).toHaveLength(1);
    expect((await callsOf(runId)).map((r) => r.status)).toEqual(["unknown"]);
  });
});

describe("OpenAiLlmAdapter reports stream progress (Codex / Responses SSE)", () => {
  let m: MockHttp;
  beforeAll(async () => {
    m = await startMockHttp();
  });
  afterAll(() => m.close());

  it("pings onProgress per chunk; a stall is aborted by the watchdog signal and returns timeout", async () => {
    m.on("POST /v1/responses", (_c, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_1" } })}\n\n`);
      res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "가" })}\n\n`);
      // …then silence (the connection stays open)
    });
    const adapter = new OpenAiLlmAdapter({ apiBaseUrl: m.base, codexBaseUrl: `${m.base}/codex` });
    const wd = callWatchdog(new AbortController().signal, 300);
    let pings = 0;
    const r = await adapter.invoke(
      { modelId: "gpt-6-astra", system: "s", messages: [{ role: "user", content: "x" }], output: { kind: "text" }, maxOutputTokens: 100 },
      {
        apiKey: "sk-test",
        signal: wd.signal,
        timeoutMs: 30_000,
        onProgress: () => {
          pings++;
          wd.progress();
        },
      },
    );
    wd.dispose();
    expect(pings).toBeGreaterThanOrEqual(2);
    expect(wd.idleFired()).toBe(true);
    expect(r).toMatchObject({ ok: false, errorFamily: "timeout", billed: "unknown" });
  });
});

