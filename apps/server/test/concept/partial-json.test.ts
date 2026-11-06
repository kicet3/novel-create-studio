import { describe, expect, it } from "vitest";
import { createFieldStreamer, extractPartialStringField } from "../../src/modules/concept/domain/partial-json.js";
import { createTurnStreamHub, type TurnStreamEvent } from "../../src/modules/concept/application/turn-stream.js";

const ex = (s: string) => extractPartialStringField(s, "reply_text");

describe("extractPartialStringField (reply_text from a JSON prefix)", () => {
  it("decodes the field as far as it goes; started/complete flags", () => {
    expect(ex("")).toEqual({ text: "", started: false, complete: false });
    expect(ex('{"reply_')).toMatchObject({ started: false });
    expect(ex('{"reply_text"')).toMatchObject({ started: false });
    expect(ex('{"reply_text": ')).toMatchObject({ started: false });
    expect(ex('{"reply_text": "')).toEqual({ text: "", started: true, complete: false });
    expect(ex('{"reply_text": "안녕하')).toEqual({ text: "안녕하", started: true, complete: false });
    expect(ex('{"reply_text": "안녕하세요", "n": 1}')).toEqual({ text: "안녕하세요", started: true, complete: true });
  });

  it("escapes: decoded only when whole (never shows a half escape), incl. \\uXXXX and surrogate pairs", () => {
    expect(ex('{"reply_text": "a\\').text).toBe("a");
    expect(ex('{"reply_text": "a\\n').text).toBe("a\n");
    expect(ex('{"reply_text": "say \\"hi\\" \\\\ \\/ \\t').text).toBe('say "hi" \\ / \t');
    expect(ex('{"reply_text": "\\uAC0').text).toBe("");
    expect(ex('{"reply_text": "\\uAC00').text).toBe("가");
    // 😀 = 😀: wait for the low half
    expect(ex('{"reply_text": "x\\uD83D').text).toBe("x");
    expect(ex('{"reply_text": "x\\uD83D\\').text).toBe("x");
    expect(ex('{"reply_text": "x\\uD83D\\uDE0').text).toBe("x");
    expect(ex('{"reply_text": "x\\uD83D\\uDE00').text).toBe("x😀");
    expect(ex('{"reply_text": "x\\uD83Dy"}')).toMatchObject({ text: "x\uD83Dy", complete: true }); // lone surrogate kept
  });

  it("reply_text need not be first; nested keys / string values that look like it never match; fences are skipped", () => {
    expect(ex('{"questions": [{"reply_text": "no"}], "note": "\\"reply_text\\": \\"no\\"", "reply_text": "yes').text).toBe("yes");
    expect(ex('{"a": {"reply_text": "nested"}, "b": 1}')).toMatchObject({ started: false });
    expect(ex('```json\n{"reply_text": "펜스"}\n```')).toMatchObject({ text: "펜스", complete: true });
    expect(ex('{"reply_text": null}')).toMatchObject({ started: false });
    expect(ex('{"reply_text": 3}')).toMatchObject({ started: false });
  });

  it("monotonic: every prefix's text is a prefix of the final text (char-by-char feed)", () => {
    const final = { reply_text: '좋아요!\n"회귀" 짐꾼 \\ 이야기 😀 \u0001 끝', questions: [{ reply_text: "x" }] };
    const json = JSON.stringify(final).replace("😀", "\\ud83d\\ude00"); // also as an escaped surrogate pair
    const st = createFieldStreamer("reply_text");
    let shown = "";
    let prev = "";
    for (const ch of json) {
      shown += st.push(ch);
      expect(final.reply_text.startsWith(shown)).toBe(true);
      expect(shown.length).toBeGreaterThanOrEqual(prev.length);
      prev = shown;
    }
    expect(shown).toBe(final.reply_text);
    st.reset();
    expect(st.push('{"reply_text":"새')).toBe("새");
  });
});

describe("turn stream hub", () => {
  it("late join snapshot, events of an older task ignored, ended turns remembered briefly", () => {
    let now = 0;
    const hub = createTurnStreamHub({ now: () => now, keepEndedMs: 1000 });
    const got: TurnStreamEvent[] = [];
    const off = hub.subscribe("cns_1", (e) => got.push(e));
    hub.begin("cns_1", "tsk_a");
    hub.delta("cns_1", "tsk_a", "안녕");
    hub.delta("cns_1", "tsk_b", "남의 것");
    expect(hub.snapshot("cns_1")).toEqual({ taskId: "tsk_a", text: "안녕", end: null });
    hub.reset("cns_1", "tsk_a");
    hub.delta("cns_1", "tsk_a", "다시");
    hub.done("cns_1", "tsk_b", "cnm_x"); // not the live task
    hub.done("cns_1", "tsk_a", "cnm_1");
    hub.delta("cns_1", "tsk_a", "늦은 조각");
    expect(got).toEqual([{ type: "delta", text: "안녕" }, { type: "reset" }, { type: "delta", text: "다시" }, { type: "done", messageId: "cnm_1" }]);
    expect(hub.snapshot("cns_1")).toMatchObject({ text: "다시", end: { type: "done", messageId: "cnm_1" } });
    now = 5000;
    expect(hub.snapshot("cns_1")).toBeNull();
    off();
    expect(hub.listeners("cns_1")).toBe(0);
    // a turn that never streamed still ends (stop / deterministic path)
    hub.done("cns_2", null, null);
    expect(hub.snapshot("cns_2")).toMatchObject({ end: { type: "done", messageId: null } });
  });

  it("abandon (run stopped, task lives on) resets and forgets; a second end of the same task is not published", () => {
    const hub = createTurnStreamHub();
    const seen: TurnStreamEvent[] = [];
    hub.subscribe("cns_3", (e) => seen.push(e));
    hub.begin("cns_3", "tsk_a");
    hub.delta("cns_3", "tsk_a", "반쯤");
    hub.abandon("cns_3", "tsk_other"); // not the live task: ignored
    expect(hub.snapshot("cns_3")).toMatchObject({ taskId: "tsk_a", text: "반쯤", end: null });
    hub.abandon("cns_3", "tsk_a");
    expect(hub.snapshot("cns_3")).toBeNull();
    hub.begin("cns_3", "tsk_a"); // the rerun streams again
    hub.delta("cns_3", "tsk_a", "다시");
    hub.done("cns_3", "tsk_a", null); // stopped
    hub.done("cns_3", "tsk_a", null); // its run then finished without commit
    expect(seen).toEqual([{ type: "delta", text: "반쯤" }, { type: "reset" }, { type: "delta", text: "다시" }, { type: "done", messageId: null }]);
  });
});
