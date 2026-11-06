/**
 * 설계 추가 (답변 스트리밍): ModelCallInput.onStream — the real Claude adapter streams the scripted Messages API in
 * chunks; the gateway relays deltas, emits `reset` before a repair/retry attempt and when the call finally fails,
 * and still returns only the zod-validated value.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ModelCallError, type LlmStreamEvent } from "../../src/modules/llm/index.js";
import { createLlmGateway } from "../../src/modules/llm/application/gateway.js";
import { createTestCore, TEST_ANTHROPIC_KEY, type TestCore } from "../support/test-core.js";
import { runHandle, seedTaskRun, stubBudget } from "./support.js";

let t: TestCore;
let novelId: string;
let gateway: ReturnType<typeof createLlmGateway>;

const Reply = z.object({ reply_text: z.string().min(1), n: z.number().int() });
const OK = { reply_text: "안녕하세요! 회귀한 짐꾼 이야기, 좋아요.", n: 1 };

beforeAll(async () => {
  t = await createTestCore();
  novelId = (await t.modules.novel.service.createNovel({}, t.owner)).id;
  const llm = t.modules.llm.service;
  gateway = createLlmGateway({
    platform: t.platform,
    budget: stubBudget(t),
    getBinding: (scope, role) => llm.getBinding(scope, role),
    getProfile: (id) => llm.getProviderProfile(id),
    getAdapter: (p) => llm.getAdapter(p),
    resolveApiKey: async () => TEST_ANTHROPIC_KEY,
    sleep: async () => {},
  });
});
afterAll(() => t.close());
beforeEach(() => t.claude.reset());

async function call(events: LlmStreamEvent[], onStream?: (ev: LlmStreamEvent) => void) {
  const { taskId, runId } = await seedTaskRun(t, novelId);
  return gateway.call({
    run: runHandle(novelId, taskId, runId, "concept_partner"),
    purpose: "concept_turn",
    system: "컨셉 파트너",
    messages: [{ role: "user", content: `스트리밍 ${runId}` }],
    output: { kind: "object", schemaName: "Reply", schema: Reply },
    onStream: onStream ?? ((ev) => events.push(ev)),
  });
}

/** text of the deltas after the last reset */
const lastSegment = (evs: LlmStreamEvent[]) => {
  const i = evs.map((e) => e.type).lastIndexOf("reset");
  return evs
    .slice(i + 1)
    .map((e) => (e.type === "delta" ? e.text : ""))
    .join("");
};

describe("gateway live output (onStream)", () => {
  it("relays the adapter's text deltas in order; the joined text is the validated JSON; no reset on success", async () => {
    t.claude.reply({ json: OK, chunkSize: 5 });
    const evs: LlmStreamEvent[] = [];
    const out = await call(evs);
    expect(out.value).toEqual(OK);
    expect(evs.filter((e) => e.type === "delta").length).toBeGreaterThan(5);
    expect(evs.some((e) => e.type === "reset")).toBe(false);
    expect(JSON.parse(lastSegment(evs))).toEqual(OK);
  });

  it("repair retry: the invalid first attempt is followed by `reset`, then the second attempt streams", async () => {
    t.claude.reply({ json: { reply_text: "", n: "x" }, chunkSize: 4 }, { json: OK, chunkSize: 6 });
    const evs: LlmStreamEvent[] = [];
    const out = await call(evs);
    expect(out.value).toEqual(OK);
    expect(t.claude.requests).toHaveLength(2);
    const types = evs.map((e) => e.type);
    expect(types.filter((x) => x === "reset")).toHaveLength(1);
    expect(types.indexOf("reset")).toBeGreaterThan(0);
    expect(types[types.length - 1]).toBe("delta");
    expect(JSON.parse(lastSegment(evs))).toEqual(OK);
  });

  it("a transient error before any output needs no reset; a final validation failure ends with `reset` and throws", async () => {
    t.claude.reply({ error: { status: 529 } }, { json: OK, chunkSize: 8 });
    const evs: LlmStreamEvent[] = [];
    await call(evs);
    expect(evs.some((e) => e.type === "reset")).toBe(false);

    t.claude.reply({ json: { bad: 1 }, chunkSize: 3, times: Infinity });
    const failed: LlmStreamEvent[] = [];
    await expect(call(failed)).rejects.toBeInstanceOf(ModelCallError);
    expect(failed[failed.length - 1]).toEqual({ type: "reset" });
    // never two resets in a row
    expect(failed.some((e, i) => e.type === "reset" && failed[i - 1]?.type === "reset")).toBe(false);
  });

  it("a throwing stream callback never breaks the call", async () => {
    t.claude.reply({ json: OK, chunkSize: 5 });
    const out = await call([], () => {
      throw new Error("ui gone");
    });
    expect(out.value).toEqual(OK);
  });
});
