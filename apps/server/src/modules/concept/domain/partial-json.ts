/**
 * Partial-JSON field extraction for live display (설계 추가: 컨셉 답변 스트리밍).
 *
 * The concept partner's output is a JSON object streamed as text (`{"reply_text": "안녕…`). This reads the value of
 * one top-level string field from a JSON *prefix*: it skips leading noise (a ```json fence), walks the top-level
 * object (nested objects/arrays and other strings are skipped, so a `"reply_text"` inside another value never
 * matches), and decodes the field's string as far as it is complete — escapes (`\n`, `\"`, `\\`, `\/`, `\b`, `\f`,
 * `\r`, `\t`, `\uXXXX` incl. surrogate pairs) are decoded only once whole, so the decoded text only ever grows as the
 * prefix grows (callers can diff by length). Pure; O(prefix length).
 */

export interface PartialStringField {
  /** decoded text so far ("" when the field has not started) */
  text: string;
  /** the field's key and opening quote were seen */
  started: boolean;
  /** the closing quote was seen */
  complete: boolean;
}

const SIMPLE_ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
const NOT_FOUND: PartialStringField = { text: "", started: false, complete: false };

/**
 * Reads a JSON string starting right after its opening quote at `i`.
 * Returns the decoded text, the index after the closing quote (or -1 when the prefix ends first) and, for a
 * truncated string, how much of it is safely decoded.
 */
function readString(s: string, i: number, decode: boolean): { text: string; end: number } {
  let out = "";
  while (i < s.length) {
    const c = s[i]!;
    if (c === '"') return { text: out, end: i + 1 };
    if (c !== "\\") {
      if (decode) out += c;
      i++;
      continue;
    }
    // escape: needs the next char (and 4 hex digits for \u)
    if (i + 1 >= s.length) return { text: out, end: -1 };
    const e = s[i + 1]!;
    if (e === "u") {
      const hex = s.slice(i + 2, i + 6);
      if (hex.length < 4) return { text: out, end: -1 };
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        // malformed escape: keep it literally (the model's JSON is invalid; the final validation decides)
        if (decode) out += "\\u" + hex;
        i += 6;
        continue;
      }
      const code = parseInt(hex, 16);
      if (code >= 0xd800 && code <= 0xdbff) {
        // high surrogate: wait for the low half (`\uDC00`–`\uDFFF`) so a pair is never split
        const next = s.slice(i + 6, i + 12);
        if (next.length < 6 && "\\u".startsWith(next.slice(0, 2))) return { text: out, end: -1 }; // "", "\\", "\\u…" → wait
        const m = /^\\u([dD][c-fC-F][0-9a-fA-F]{2})$/.exec(next);
        if (m) {
          if (decode) out += String.fromCharCode(code, parseInt(m[1]!, 16));
          i += 12;
          continue;
        }
        if (decode) out += String.fromCharCode(code); // lone surrogate
        i += 6;
        continue;
      }
      if (decode) out += String.fromCharCode(code);
      i += 6;
      continue;
    }
    if (decode) out += SIMPLE_ESCAPES[e] ?? e;
    i += 2;
  }
  return { text: out, end: -1 };
}

const isWs = (c: string | undefined) => c === " " || c === "\n" || c === "\r" || c === "\t";

/** value of top-level string field `key` in the JSON prefix `src` */
export function extractPartialStringField(src: string, key: string): PartialStringField {
  const start = src.indexOf("{");
  if (start < 0) return NOT_FOUND;
  let depth = 0;
  /** at depth 1: expecting a key (true) or a value (false) */
  let expectKey = true;
  let pendingKey: string | null = null;
  let i = start;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '"') {
      if (depth === 1 && expectKey) {
        const k = readString(src, i + 1, true);
        if (k.end < 0) return NOT_FOUND;
        pendingKey = k.text;
        i = k.end;
        continue;
      }
      if (depth === 1 && !expectKey && pendingKey === key) {
        const v = readString(src, i + 1, true);
        return v.end < 0 ? { text: v.text, started: true, complete: false } : { text: v.text, started: true, complete: true };
      }
      const skip = readString(src, i + 1, false);
      if (skip.end < 0) return NOT_FOUND;
      i = skip.end;
      continue;
    }
    if (c === "{" || c === "[") {
      if (depth === 1 && !expectKey && pendingKey === key) return NOT_FOUND; // not a string value
      depth++;
    } else if (c === "}" || c === "]") {
      depth--;
      if (depth <= 0) return NOT_FOUND;
    } else if (depth === 1) {
      if (c === ":") expectKey = false;
      else if (c === ",") {
        expectKey = true;
        pendingKey = null;
      } else if (!isWs(c) && !expectKey && pendingKey === key) {
        return NOT_FOUND; // number / literal value
      }
    }
    i++;
  }
  return NOT_FOUND;
}

/**
 * Incremental helper over a growing raw text: `push(chunk)` returns the newly decoded part of the field
 * (empty when nothing new), `reset()` starts over (new attempt).
 */
export function createFieldStreamer(key: string) {
  let raw = "";
  let shown = 0;
  let complete = false;
  return {
    push(chunk: string): string {
      if (complete) return "";
      raw += chunk;
      const f = extractPartialStringField(raw, key);
      complete = f.complete;
      if (f.text.length <= shown) return "";
      const add = f.text.slice(shown);
      shown = f.text.length;
      return add;
    },
    reset() {
      raw = "";
      shown = 0;
      complete = false;
    },
    get text() {
      return extractPartialStringField(raw, key).text;
    },
  };
}
