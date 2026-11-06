import { describe, expect, it } from "vitest";
import type { ConceptAutoApproveViewDto } from "@ncs/shared";
import { autoMessageText, autoStatusLine, isAutoMessage, sendLocked } from "./auto-approve.js";

const base: ConceptAutoApproveViewDto = {
  enabled: false,
  status: "off",
  steps: 0,
  maxSteps: 20,
  acceptUserFieldProposals: false,
  waitingReason: null,
  stopReason: null,
  canEnable: true,
  updatedAt: null,
};

describe("auto-approve view helpers", () => {
  it("status line: running shows the step, waiting asks the user, completed points to the manual confirmation", () => {
    expect(autoStatusLine(base)).toBeNull();
    expect(autoStatusLine({ ...base, stopReason: "toggled_off" })).toBeNull();
    expect(autoStatusLine({ ...base, enabled: true, status: "running", steps: 3 })).toEqual({ tone: "accent", text: "자동 승인 중 · 3번째 (최대 20번)", stoppable: true });
    expect(autoStatusLine({ ...base, enabled: true, status: "running", steps: 0 })?.text).toBe("자동 승인 중 · 첫 추천을 기다리는 중 (최대 20번)");
    const wait = autoStatusLine({ ...base, enabled: true, status: "waiting_user", waitingReason: "open_question" })!;
    expect(wait).toMatchObject({ tone: "warn", stoppable: true });
    expect(wait.text).toContain("직접 답해 주세요");
    const done = autoStatusLine({ ...base, stopReason: "completed" })!;
    expect(done).toMatchObject({ tone: "ok", stoppable: false });
    expect(done.text).toContain("[승인 요청]");
    expect(autoStatusLine({ ...base, stopReason: "budget" })?.text).toContain("비용 상한");
  });

  it("auto messages are recognised (flag, or the prefix on older payloads) and shown without the prefix", () => {
    expect(isAutoMessage({ autoApproved: true })).toBe(true);
    // the flag decides: a user's own pick/text starting with the prefix is still the user's
    expect(isAutoMessage({ autoApproved: false })).toBe(false);
    expect(autoMessageText("자동 승인: 현판")).toBe("현판");
    expect(autoMessageText("현판")).toBe("현판");
  });

  it("send lock: refused while a turn runs, queued while auto-approve is on", () => {
    expect(sendLocked(true, base)).toBe(true);
    expect(sendLocked(false, base)).toBe(false);
    expect(sendLocked(true, { ...base, enabled: true, status: "running" })).toBe(false);
    expect(sendLocked(true, undefined)).toBe(true);
    // a paste starts its own task: still one at a time while auto-approve runs
    expect(sendLocked(true, { ...base, enabled: true, status: "running" }, true)).toBe(true);
    expect(sendLocked(false, { ...base, enabled: true, status: "running" }, true)).toBe(false);
  });
});
