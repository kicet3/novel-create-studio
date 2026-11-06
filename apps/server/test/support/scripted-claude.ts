/**
 * Scripted Claude: a local mock of the Claude Messages API (`POST /v1/messages`, SSE stream) that the REAL
 * AnthropicLlmAdapter talks to in tests. There is no fake model: every response a test needs is stated
 * explicitly by that test (`claude.reply(...)`). A request no script matches is answered with HTTP 400
 * (non-retryable `invalid_request`) and recorded in `unmatched`, so a missing script fails loudly.
 *
 *   t.claude.reply({ when: { schemaHas: ["episodes"] }, json: { title: "1부", ... } });
 *   t.claude.reply({ when: { system: /초고/ }, text: "본문…" });
 *   t.claude.reply({ error: { status: 529 } });             // next request (any) fails once
 *   t.claude.reply({ json: {...}, chunkSize: 8, chunkDelayMs: 20 }); // streamed in several text deltas
 *
 * Matching: scripts are tried in the order they were added; the first unexhausted one whose `when`
 * matches is used (`times` defaults to 1; `Infinity` = sticky).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** what the mock saw (already decoded from the Anthropic request body) */
export interface ClaudeRequest {
  model: string;
  maxTokens: number;
  /** system prompt text (incl. the prompt-described JSON schema when strict output was not possible) */
  system: string;
  /** all message contents joined with blank lines */
  prompt: string;
  messages: Array<{ role: string; content: string }>;
  /** JSON Schema of an object output (output_config.format or the schema in the system prompt); null = text */
  schema: Record<string, unknown> | null;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
}

export type ClaudeMatcher =
  | ((r: ClaudeRequest) => boolean)
  | {
      /** substring / regex of the system prompt */
      system?: string | RegExp;
      /** substring / regex of the joined messages */
      prompt?: string | RegExp;
      /** the output schema's top-level properties include all of these keys */
      schemaHas?: string[];
      /** text output (no schema) */
      text?: boolean;
    };

export interface ClaudeScript {
  when?: ClaudeMatcher;
  /** how many requests this script answers (default 1; Infinity = every matching request) */
  times?: number;
  /** object output: sent as the JSON text of the assistant message (or a factory over the request) */
  json?: unknown | ((r: ClaudeRequest) => unknown);
  /** text output (or a factory) */
  text?: string | ((r: ClaudeRequest) => string);
  /** stop_reason (default end_turn; "max_tokens" → length, "refusal" → content filter) */
  stop?: string;
  /** HTTP error instead of a message (e.g. 429 rate limit, 529 overloaded, 401 auth) */
  error?: { status: number; type?: string; message?: string; retryAfterSeconds?: number };
  /** never answer until the client aborts (timeout / stop drills) */
  hang?: boolean;
  /** delay before answering (ms) */
  delayMs?: number;
  /** stream the text as several `text_delta` events of this many characters (default: one delta) */
  chunkSize?: number;
  /** pause between streamed chunks (ms) */
  chunkDelayMs?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface ScriptedClaude {
  /** base URL for `llm.endpoints.anthropic_api_base_url` */
  readonly base: string;
  /** every /v1/messages request answered or not (oldest first) */
  readonly requests: ClaudeRequest[];
  /** requests no script matched */
  readonly unmatched: ClaudeRequest[];
  reply(...scripts: ClaudeScript[]): void;
  /** scripts not yet exhausted (finite `times` only) */
  pending(): ClaudeScript[];
  /** drop scripts and recorded requests */
  reset(): void;
  close(): Promise<void>;
}

function test(m: string | RegExp | undefined, s: string): boolean {
  if (m === undefined) return true;
  return typeof m === "string" ? s.includes(m) : m.test(s);
}

export function matches(when: ClaudeMatcher | undefined, r: ClaudeRequest): boolean {
  if (!when) return true;
  if (typeof when === "function") return when(r);
  if (!test(when.system, r.system) || !test(when.prompt, r.prompt)) return false;
  if (when.text !== undefined && when.text !== (r.schema === null)) return false;
  if (when.schemaHas) {
    const props = (r.schema?.properties ?? {}) as Record<string, unknown>;
    if (!when.schemaHas.every((k) => k in props)) return false;
  }
  return true;
}

function contentText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : "")).join("");
  return "";
}

function decode(body: Record<string, unknown>, headers: IncomingMessage["headers"]): ClaudeRequest {
  const system = contentText(body.system);
  const messages = ((body.messages ?? []) as Array<{ role: string; content: unknown }>).map((m) => ({ role: m.role, content: contentText(m.content) }));
  let schema: Record<string, unknown> | null = null;
  const fmt = (body.output_config as { format?: { schema?: Record<string, unknown> } } | undefined)?.format;
  if (fmt?.schema) schema = fmt.schema;
  else {
    // prompt-described JSON (non-strict schemas): the schema is the last line of the system prompt
    const at = system.lastIndexOf("## 출력 형식");
    if (at >= 0) {
      const line = system.slice(at).split("\n").pop() ?? "";
      try {
        schema = JSON.parse(line) as Record<string, unknown>;
      } catch {
        schema = {};
      }
    }
  }
  return {
    model: String(body.model ?? ""),
    maxTokens: Number(body.max_tokens ?? 0),
    system,
    prompt: messages.map((m) => m.content).join("\n\n"),
    messages,
    schema,
    headers,
    body,
  };
}

let msgSeq = 0;

async function writeMessage(res: ServerResponse, r: ClaudeRequest, text: string, s: ClaudeScript) {
  const id = `msg_scripted_${++msgSeq}`;
  res.writeHead(200, { "content-type": "text/event-stream", "request-id": `req_scripted_${msgSeq}` });
  const ev = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  const inputTokens = s.usage?.input_tokens ?? Math.ceil((r.system.length + r.prompt.length) / 4);
  const outputTokens = s.usage?.output_tokens ?? Math.max(1, Math.ceil(text.length / 4));
  ev("message_start", {
    type: "message_start",
    message: { id, type: "message", role: "assistant", model: r.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 1 } },
  });
  ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  const size = s.chunkSize && s.chunkSize > 0 ? s.chunkSize : Math.max(1, text.length);
  const chars = [...text]; // never split a surrogate pair
  for (let i = 0; i < chars.length; i += size) {
    if (i > 0 && s.chunkDelayMs) await new Promise((ok) => setTimeout(ok, s.chunkDelayMs));
    if (res.destroyed) return;
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chars.slice(i, i + size).join("") } });
  }
  ev("content_block_stop", { type: "content_block_stop", index: 0 });
  ev("message_delta", { type: "message_delta", delta: { stop_reason: s.stop ?? "end_turn", stop_sequence: null }, usage: { output_tokens: outputTokens } });
  ev("message_stop", { type: "message_stop" });
  res.end();
}

function writeError(res: ServerResponse, status: number, type: string, message: string, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", "request-id": `req_scripted_err_${++msgSeq}`, ...headers });
  res.end(JSON.stringify({ type: "error", error: { type, message } }));
}

export async function startScriptedClaude(): Promise<ScriptedClaude> {
  let scripts: Array<ClaudeScript & { left: number }> = [];
  const requests: ClaudeRequest[] = [];
  const unmatched: ClaudeRequest[] = [];
  const open = new Set<ServerResponse>();

  const handle = async (req: IncomingMessage, raw: string, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    if (req.method === "POST" && path === "/v1/messages/count_tokens") {
      const r = decode(body, req.headers);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: Math.ceil((r.system.length + r.prompt.length) / 4) }));
      return;
    }
    if (req.method === "GET" && path.startsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [], has_more: false, first_id: null, last_id: null }));
      return;
    }
    if (req.method !== "POST" || path !== "/v1/messages") return writeError(res, 404, "not_found_error", `no route ${req.method} ${path}`);
    const r = decode(body, req.headers);
    requests.push(r);
    const s = scripts.find((x) => x.left > 0 && matches(x.when, r));
    if (!s) {
      unmatched.push(r);
      return writeError(res, 400, "invalid_request_error", "scripted-claude: no scripted response matches this request");
    }
    s.left -= 1;
    if (s.delayMs) await new Promise((ok) => setTimeout(ok, s.delayMs));
    if (s.hang) return; // left open until the client aborts / close()
    if (s.error) {
      const e = s.error;
      return writeError(res, e.status, e.type ?? (e.status === 429 ? "rate_limit_error" : e.status === 401 ? "authentication_error" : e.status >= 500 ? "overloaded_error" : "invalid_request_error"), e.message ?? `scripted error ${e.status}`, e.retryAfterSeconds !== undefined ? { "retry-after": String(e.retryAfterSeconds) } : {});
    }
    const json = typeof s.json === "function" ? (s.json as (r: ClaudeRequest) => unknown)(r) : s.json;
    const text = s.text !== undefined ? (typeof s.text === "function" ? s.text(r) : s.text) : json !== undefined ? JSON.stringify(json) : "";
    await writeMessage(res, r, text, s);
  };

  const server: Server = createServer((req, res) => {
    open.add(res);
    res.on("close", () => open.delete(res));
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      handle(req, raw, res).catch((err) => writeError(res, 500, "api_error", String(err)));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    base,
    requests,
    unmatched,
    reply(...add) {
      for (const s of add) scripts.push({ ...s, left: s.times ?? 1 });
    },
    pending() {
      return scripts.filter((s) => s.left > 0 && Number.isFinite(s.left));
    },
    reset() {
      scripts = [];
      requests.length = 0;
      unmatched.length = 0;
    },
    close: () =>
      new Promise<void>((ok) => {
        for (const res of open) res.destroy();
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}
