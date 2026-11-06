/**
 * Relays Anthropic Messages stream events (`message_start`, `content_block_start`, `content_block_delta`, …) to the
 * LLM port's optional `onStream` hook. Used by the Anthropic SDK adapter (raw `streamEvent`s) and the Claude Code CLI
 * adapter (`--output-format stream-json --include-partial-messages` wraps the same events in `stream_event` lines).
 *
 * `source`:
 * - "text": the output is the text blocks (plain text, or JSON text for prompt-described / output_config JSON);
 * - "structured_output_tool": the output is the input JSON of the CLI's `StructuredOutput` tool (`--json-schema`);
 *   text blocks around it (preambles) are not output.
 * A second message (CLI turn after a tool result) or a second StructuredOutput block (the CLI re-asks after a schema
 * error) replaces what was streamed: `reset` first. So does a server-side web search block inside one message.
 */
import type { LlmStreamEvent } from "../../index.js";

export type StreamRelaySource = "text" | "structured_output_tool";

export interface StreamRelay {
  /** feed one Anthropic stream event (unknown shapes are ignored) */
  push(event: unknown): void;
  /** whether any delta was emitted */
  readonly emitted: boolean;
}

const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";

export function createStreamRelay(source: StreamRelaySource, onStream: ((ev: LlmStreamEvent) => void) | undefined): StreamRelay {
  let emitted = false;
  let dirty = false;
  /** content block index → is it output? (per message) */
  let outputBlocks = new Set<number>();
  let toolBlocksSeen = 0;
  const emit = (ev: LlmStreamEvent) => {
    if (!onStream) return;
    try {
      onStream(ev);
    } catch {
      /* display-only hook must never break the call */
    }
  };
  const reset = () => {
    if (!dirty) return;
    dirty = false;
    emit({ type: "reset" });
  };
  return {
    get emitted() {
      return emitted;
    },
    push(event) {
      if (!onStream || !event || typeof event !== "object") return;
      const e = event as { type?: unknown; index?: unknown; content_block?: { type?: unknown; name?: unknown }; delta?: { type?: unknown; text?: unknown; partial_json?: unknown } };
      switch (e.type) {
        case "message_start":
          // a new assistant message: in "text" mode its text replaces the previous message's text
          if (source === "text") reset();
          outputBlocks = new Set();
          return;
        case "content_block_start": {
          const idx = typeof e.index === "number" ? e.index : -1;
          const b = e.content_block;
          if (source === "text" && b?.type === "text") outputBlocks.add(idx);
          // web search inside one message (server tools): text before a search is preamble — the answer follows it
          if (source === "text" && (b?.type === "server_tool_use" || b?.type === "web_search_tool_result")) reset();
          if (source === "structured_output_tool" && b?.type === "tool_use" && b.name === STRUCTURED_OUTPUT_TOOL) {
            if (toolBlocksSeen++ > 0) reset();
            outputBlocks.add(idx);
          }
          return;
        }
        case "content_block_delta": {
          const idx = typeof e.index === "number" ? e.index : -1;
          if (!outputBlocks.has(idx)) return;
          const d = e.delta;
          const text = d?.type === "text_delta" && typeof d.text === "string" ? d.text : d?.type === "input_json_delta" && typeof d.partial_json === "string" ? d.partial_json : "";
          if (!text) return;
          emitted = true;
          dirty = true;
          emit({ type: "delta", text });
          return;
        }
        default:
          return;
      }
    },
  };
}
