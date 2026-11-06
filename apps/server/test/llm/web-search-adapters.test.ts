/**
 * 설계 추가 0011 (인터넷 검색) per provider lane, scripted (no network, the real CLI never starts):
 * - claude_code: only the CLI's built-in WebSearch tool (WebFetch off), permission mode dontAsk, stream-json parsed for
 *   queries and the "Links:" list of each WebSearch result;
 * - openai: API-key lane `tools:[{type:"web_search"}]` + `max_tool_calls`, url_citation annotations; ChatGPT lane unsupported;
 * - google: grounding with Google Search, groundingMetadata → sources;
 * - xai: unsupported (call runs without search).
 */
import { describe, expect, it } from "vitest";
import type { LlmRequest } from "../../src/modules/llm/index.js";
import { CLI_WEB_TOOLS, cliArgs, webSearchOfStream } from "../../src/modules/llm/adapters/claude-cli/claude-cli-adapter.js";
import { OpenAiLlmAdapter, buildResponsesBody, collectResponsesStream } from "../../src/modules/llm/adapters/openai/openai-adapter.js";
import { GeminiLlmAdapter, buildGenerateBody, collectGeminiStream } from "../../src/modules/llm/adapters/google/gemini-adapter.js";
import { XaiLlmAdapter } from "../../src/modules/llm/adapters/xai/xai-adapter.js";
import { cliResult, scriptedClaudeCli } from "../support/scripted-claude-cli.js";

const req = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  modelId: "claude-opus-5-5",
  system: "컨셉 파트너",
  messages: [{ role: "user", content: "조선 포도청 수사극" }],
  output: { kind: "object", schemaName: "Reply", jsonSchema: { type: "object", properties: { reply_text: { type: "string" } }, required: ["reply_text"], additionalProperties: false } },
  maxOutputTokens: 2000,
  ...over,
});

const line = (o: unknown) => JSON.stringify(o) + "\n";
/** stream-json of a CLI turn that ran WebSearch once (shape recorded from claude 2.1.319, 2026-11-06) */
const searchingStream = (result: unknown) =>
  [
    line({ type: "system", subtype: "init", tools: ["WebFetch", "WebSearch"], permissionMode: "dontAsk" }),
    line({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "toolu_1", name: "WebSearch", input: { query: "조선시대 포도청 직책" } }] } }),
    line({
      type: "user",
      parent_tool_use_id: null,
      message: {
        content: [
          {
            tool_use_id: "toolu_1",
            type: "tool_result",
            content:
              'Web search results for query: "조선시대 포도청 직책"\n\nLinks: [{"title":"encykorea.aks.ac.kr","url":"https://encykorea.aks.ac.kr/Article/E0060135"},{"title":"Podocheong","url":"https://en.wikipedia.org/wiki/Podocheong"},{"title":"bad","url":"javascript:alert(1)"}]\n\n요약...',
          },
        ],
      },
    }),
    line({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "toolu_2", name: "WebFetch", input: { url: "https://encykorea.aks.ac.kr/Article/E0060135", prompt: "직책" } }] } }),
    line({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "답" }] } }),
    cliResult({ result: JSON.stringify(result), structured_output: result }) + "\n",
  ].join("");

/** value(s) right after a flag */
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe("claude_code (claude -p) web search", () => {
  it("enables ONLY WebSearch (no WebFetch), auto-denies everything else, and reads stream-json for sources", async () => {
    const cli = scriptedClaudeCli(() => ({ stdout: searchingStream({ reply_text: "포도대장이에요." }) }));
    const r = await cli.adapter.invoke(req({ webSearch: { maxUses: 2 } }), { apiKey: "claude-cli", signal: new AbortController().signal, timeoutMs: 10_000 });
    const args = cli.spawn.calls[0]!.args;
    expect(after(args, "--tools")).toBe("WebSearch");
    expect(after(args, "--allowedTools")).toBe("WebSearch");
    expect(after(args, "--permission-mode")).toBe("dontAsk");
    expect(after(args, "--output-format")).toBe("stream-json"); // tool results are only visible in stream-json
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(r).toMatchObject({ ok: true, object: { reply_text: "포도대장이에요." }, usage: { webSearchRequests: 2 } });
    if (!r.ok) throw new Error("expected ok");
    // search result lists only: the gateway keeps the ones the model names in its "출처:" trailer
    expect(r.webSearch).toMatchObject({ status: "used", requests: 2, queries: ["조선시대 포도청 직책"], citationsKind: "results" });
    expect(r.webSearch!.citations.map((c) => c.url)).toEqual(["https://encykorea.aks.ac.kr/Article/E0060135", "https://en.wikipedia.org/wiki/Podocheong"]);
  });

  it("without webSearch every tool stays disabled (--tools \"\") and no permission flags are added", () => {
    const { args } = cliArgs(req());
    expect(after(args, "--tools")).toBe("");
    expect(args).not.toContain("--allowedTools");
    expect(args).not.toContain("--permission-mode");
    expect(after(args, "--output-format")).toBe("json");
    expect(CLI_WEB_TOOLS).toEqual(["WebSearch"]);
  });

  it("subagent (parent_tool_use_id) lines and non-search tool results are ignored", () => {
    const out = webSearchOfStream(
      [
        line({ type: "assistant", parent_tool_use_id: "toolu_x", message: { content: [{ type: "tool_use", id: "t9", name: "WebSearch", input: { query: "숨은 검색" } }] } }),
        line({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "t9", content: 'Links: [{"title":"x","url":"https://x.example"}]\n' }] } }),
      ].join(""),
      "2026-11-06T00:00:00.000Z",
    );
    expect(out).toEqual({ status: "not_used", requests: 0, citations: [], citationsKind: "results" });
  });
});

const sse = (events: unknown[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      c.close();
    },
  });

describe("openai / google / xai web search", () => {
  it("openai API-key lane: web_search tool + max_tool_calls; url_citation annotations and web_search_call items are read", async () => {
    const body = buildResponsesBody(req({ modelId: "gpt-6.1-sol", webSearch: { maxUses: 3 } }), "api", "schema");
    expect(body).toMatchObject({ tools: [{ type: "web_search" }], max_tool_calls: 3 });
    expect(buildResponsesBody(req({ modelId: "gpt-6.1-sol" }), "api", "schema").tools).toBeUndefined();
    const c = await collectResponsesStream(
      sse([
        { type: "response.output_item.done", item: { type: "web_search_call", action: { type: "search", query: "조선 포도청" } } },
        { type: "response.output_text.delta", delta: '{"reply_text":"답"}' },
        { type: "response.output_text.annotation.added", annotation: { type: "url_citation", url: "https://a.example/1", title: "A" } },
        { type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "", annotations: [{ type: "url_citation", url: "https://b.example/2", title: "B" }, { type: "url_citation", url: "https://a.example/1", title: "A" }] }] } },
        { type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 10, output_tokens: 5 } } },
      ]),
    );
    expect(c.searches).toBe(1);
    expect(c.queries).toEqual(["조선 포도청"]);
    expect(c.citations).toEqual([
      { url: "https://a.example/1", title: "A" },
      { url: "https://b.example/2", title: "B" },
    ]);
    const a = new OpenAiLlmAdapter();
    expect(a.webSearchSupport("gpt-6.1-sol", "api_key")).toBe(true);
    expect(a.webSearchSupport("gpt-6-sol", "chatgpt_oauth")).toMatch(/ChatGPT 로그인 연결은 인터넷 검색을 아직 지원하지 않아/);
  });

  it("google: google_search grounding tool; groundingMetadata queries and chunks become sources", async () => {
    expect(buildGenerateBody(req({ modelId: "gemini-4-argon", webSearch: { maxUses: 2 } }), true)).toMatchObject({ tools: [{ google_search: {} }] });
    expect(buildGenerateBody(req({ modelId: "gemini-4-argon" }), true).tools).toBeUndefined();
    const g = await collectGeminiStream(
      sse([
        {
          candidates: [
            {
              content: { parts: [{ text: '{"reply_text":"답"}' }] },
              finishReason: "STOP",
              groundingMetadata: { webSearchQueries: ["조선 포도청 직책"], groundingChunks: [{ web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc", title: "encykorea.aks.ac.kr" } }] },
            },
          ],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        },
      ]),
    );
    expect(g.queries).toEqual(["조선 포도청 직책"]);
    expect(g.sources).toEqual([{ url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc", title: "encykorea.aks.ac.kr" }]);
    expect(new GeminiLlmAdapter().webSearchSupport()).toBe(true);
  });

  it("xai: unsupported with a reason (the gateway runs the call without search)", () => {
    expect(new XaiLlmAdapter().webSearchSupport()).toMatch(/Grok\(xAI\) 연결은 인터넷 검색을 아직 지원하지 않아/);
  });
});
