/**
 * 설계 추가 (답변 스트리밍): ClaudeCliLlmAdapter with `onStream` runs `claude -p --output-format stream-json
 * --include-partial-messages --verbose` (scripted spawn, the real CLI never starts), relays the partial message
 * events and maps the final `result` line exactly like `--output-format json`.
 */
import { describe, expect, it } from "vitest";
import type { LlmRequest, LlmResult, LlmStreamEvent } from "../../src/modules/llm/index.js";
import { resultOfStream } from "../../src/modules/llm/adapters/claude-cli/claude-cli-adapter.js";
import { cliResult, scriptedClaudeCli } from "../support/scripted-claude-cli.js";

const line = (o: unknown) => JSON.stringify(o) + "\n";
const ev = (event: unknown) => line({ type: "stream_event", event, session_id: "sess_test", parent_tool_use_id: null });
const textMsg = (chunks: string[]) =>
  [
    line({ type: "system", subtype: "init", session_id: "sess_test", tools: [] }),
    ev({ type: "message_start", message: { id: "msg_1", role: "assistant", content: [] } }),
    ev({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
    ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "생각" } }),
    ev({ type: "content_block_stop", index: 0 }),
    ev({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
    ...chunks.map((text) => ev({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text } })),
    ev({ type: "content_block_stop", index: 1 }),
    ev({ type: "message_stop" }),
  ].join("");

const objectReq = (jsonSchema: Record<string, unknown>): LlmRequest => ({
  modelId: "claude-opus-5-5",
  system: "컨셉 파트너",
  messages: [{ role: "user", content: "안녕" }],
  output: { kind: "object", schemaName: "Reply", jsonSchema },
  maxOutputTokens: 2000,
});
// `{}` (z.unknown) is not strict-representable → prompt-described JSON → text blocks
const LOOSE = { type: "object", properties: { reply_text: { type: "string" }, extra: {} }, required: ["reply_text"] };
const STRICT = { type: "object", properties: { reply_text: { type: "string" }, n: { type: "number" } }, required: ["reply_text", "n"], additionalProperties: false };

const run = (adapter: ReturnType<typeof scriptedClaudeCli>["adapter"], req: LlmRequest, events?: LlmStreamEvent[]) =>
  adapter.invoke(req, { apiKey: "claude-cli", signal: new AbortController().signal, timeoutMs: 10_000, ...(events ? { onStream: (e) => events.push(e) } : {}) });

describe("claude_code stream-json", () => {
  it("text output: args, text deltas (thinking skipped), final result mapped like --output-format json", async () => {
    const final = { reply_text: "반가워요\n\"짐꾼\" 이야기", extra: 1 };
    const json = JSON.stringify(final);
    const chunks = [json.slice(0, 7), json.slice(7, 19), json.slice(19)];
    const resultLine = cliResult({ result: json, total_cost_usd: 0.0123, usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 50, output_tokens_details: { thinking_tokens: 9 } } });
    const streamed = scriptedClaudeCli(() => ({ stdout: textMsg(chunks) + resultLine + "\n" }));
    const events: LlmStreamEvent[] = [];
    const r = await run(streamed.adapter, objectReq(LOOSE), events);
    const args = streamed.spawn.calls[0]!.args;
    expect(args.slice(0, 6)).toEqual(["-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose", "--model"]);
    expect(args).not.toContain("--json-schema");
    expect(events).toEqual(chunks.map((text) => ({ type: "delta", text })));

    // the same result through the classic JSON path maps identically
    const classic = scriptedClaudeCli(() => ({ stdout: resultLine }));
    const c = await run(classic.adapter, objectReq(LOOSE));
    expect(classic.spawn.calls[0]!.args.slice(0, 3)).toEqual(["-p", "--output-format", "json"]);
    const strip = (x: LlmResult) => ({ ...x, raw: null });
    expect(strip(r)).toEqual(strip(c));
    expect(r).toMatchObject({ ok: true, object: final, usage: { inputTokens: 120, outputTokens: 50, cachedInputTokens: 20, reasoningTokens: 9, reportedCostMicros: 12_300 } });
  });

  it("--json-schema: relays the StructuredOutput tool's input_json_delta; a second tool block resets; structured_output wins", async () => {
    const tool = (index: number, parts: string[]) => [
      ev({ type: "content_block_start", index, content_block: { type: "tool_use", id: `toolu_${index}`, name: "StructuredOutput", input: {} } }),
      ...parts.map((partial_json) => ev({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json } })),
      ev({ type: "content_block_stop", index }),
    ];
    const stdout = [
      ev({ type: "message_start", message: { id: "m1", content: [] } }),
      ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "preamble" } }),
      ...tool(1, ['{"reply_text": "첫', '번"']),
      // a sub-agent's event (parent_tool_use_id set) is not ours
      line({ type: "stream_event", parent_tool_use_id: "toolu_x", event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "XX" } } }),
      ...tool(2, ['{"reply_text": "둘', '째", "n": 2}']),
      cliResult({ stop_reason: "tool_use", result: "", structured_output: { reply_text: "둘째", n: 2 } }),
    ].join("");
    const { adapter, spawn } = scriptedClaudeCli(() => ({ stdout }));
    const events: LlmStreamEvent[] = [];
    const r = await run(adapter, objectReq(STRICT), events);
    expect(spawn.calls[0]!.args).toContain("--json-schema");
    expect(events).toEqual([
      { type: "delta", text: '{"reply_text": "첫' },
      { type: "delta", text: '번"' },
      { type: "reset" },
      { type: "delta", text: '{"reply_text": "둘' },
      { type: "delta", text: '째", "n": 2}' },
    ]);
    expect(r).toMatchObject({ ok: true, object: { reply_text: "둘째", n: 2 }, finishReason: "stop" });
  });

  it("lines split across stdout chunks and errors: no result line → provider_unavailable; is_error result → mapped family", async () => {
    expect(resultOfStream('{"type":"system"}\n' + cliResult({ result: "x" }) + "\n\n")).toMatchObject({ type: "result", result: "x" });
    // stdout pieces that cut lines (and a Korean character's UTF-8 bytes) in the middle still yield whole events
    const all = Buffer.from(textMsg(['{"reply_text": "가나', '다"}']) + cliResult({ result: '{"reply_text": "가나다"}' }), "utf8");
    const cut = all.indexOf(Buffer.from("가나", "utf8")) + 1; // inside the 3-byte "가"
    const pieces = [all.subarray(0, 40), all.subarray(40, cut), all.subarray(cut)].map((b) => b as unknown as string);
    const split = scriptedClaudeCli(() => ({ stdoutChunks: pieces }));
    const got: LlmStreamEvent[] = [];
    expect(await run(split.adapter, objectReq(LOOSE), got)).toMatchObject({ ok: true, object: { reply_text: "가나다" } });
    expect(got).toEqual([{ type: "delta", text: '{"reply_text": "가나' }, { type: "delta", text: '다"}' }]);
    expect(() => resultOfStream('{"type":"system"}\n')).toThrow();
    const none = scriptedClaudeCli(() => ({ stdout: line({ type: "system", subtype: "init" }), code: 1 }));
    expect(await run(none.adapter, objectReq(LOOSE), [])).toMatchObject({ ok: false, errorFamily: "provider_unavailable" });
    const limited = scriptedClaudeCli(() => ({ stdout: cliResult({ is_error: true, result: "Claude usage limit reached", api_error_status: 429 }) }));
    expect(await run(limited.adapter, objectReq(LOOSE), [])).toMatchObject({ ok: false, errorFamily: "rate_limited", billed: "no" });
  });

  it("a CLI that dies mid-stream is not mistaken for a login problem because the reply text says 'author' / 'login'", async () => {
    const died = scriptedClaudeCli(() => ({ stdout: textMsg(['{"reply_text": "the author must login to the auth', " credential"]), stderr: "", code: 1 }));
    expect(await run(died.adapter, objectReq(LOOSE), [])).toMatchObject({ ok: false, errorFamily: "provider_unavailable" });
    const loggedOut = scriptedClaudeCli(() => ({ stdout: "", stderr: "Invalid API key · Please run /login", code: 1 }));
    expect(await run(loggedOut.adapter, objectReq(LOOSE), [])).toMatchObject({ ok: false, errorFamily: "auth_failed" });
  });
});
