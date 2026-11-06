import { describe, expect, it } from "vitest";
import { applyReplyEvent, IDLE_REPLY, showLiveReply, type ReplyStreamState } from "./reply-stream.js";

const start: ReplyStreamState = { ...IDLE_REPLY, taskId: "tsk_1" };

describe("live concept reply state", () => {
  it("appends deltas, resets, ends once (late events ignored)", () => {
    let s = applyReplyEvent(start, { type: "reset" });
    s = applyReplyEvent(s, { type: "delta", text: "안녕" });
    s = applyReplyEvent(s, { type: "delta", text: "하세요" });
    expect(s).toMatchObject({ text: "안녕하세요", phase: "streaming" });
    s = applyReplyEvent(s, { type: "reset" });
    expect(s.text).toBe("");
    s = applyReplyEvent(applyReplyEvent(s, { type: "delta", text: "다시" }), { type: "done", messageId: "cnm_1" });
    expect(s).toMatchObject({ text: "다시", phase: "ended", messageId: "cnm_1" });
    expect(applyReplyEvent(s, { type: "delta", text: "늦음" })).toBe(s);
  });

  it("the live bubble stays until the persisted message is listed (no flicker, no duplicate)", () => {
    const streaming = applyReplyEvent(start, { type: "delta", text: "답" });
    expect(showLiveReply(streaming, new Set(), true)).toBe(true);
    const ended = applyReplyEvent(streaming, { type: "done", messageId: "cnm_1" });
    expect(showLiveReply(ended, new Set(), false)).toBe(true);
    expect(showLiveReply(ended, new Set(["cnm_1"]), false)).toBe(false);
    const stopped = applyReplyEvent(streaming, { type: "done", messageId: null });
    expect(showLiveReply(stopped, new Set(), true)).toBe(true);
    expect(showLiveReply(stopped, new Set(), false)).toBe(false);
    const failed = applyReplyEvent(streaming, { type: "transport_failed" });
    expect(showLiveReply(failed, new Set(), false)).toBe(false);
    expect(showLiveReply(start, new Set(), true)).toBe(false);
  });
});
