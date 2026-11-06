import { describe, expect, it } from "vitest";
import {
  basePriority,
  canTransitionTask,
  coalescedNotBefore,
  decideFailure,
  reassignAllowed,
  runTransition,
  taskTransition,
  wakeClaimable,
} from "../../src/modules/orchestration/domain/transitions.js";
import { InvalidTransitionError } from "../../src/platform/index.js";

const now = new Date("2026-11-05T00:00:00Z");

describe("task / run state tables (03 §4.2–4.3)", () => {
  it("allows only listed transitions", () => {
    expect(taskTransition("T3", "ready").to).toBe("running");
    expect(() => taskTransition("T3", "blocked")).toThrow(InvalidTransitionError);
    expect(canTransitionTask("T11", "running")).toBe(false); // running cancels only at a safe point (T11s)
    expect(canTransitionTask("T11s", "running")).toBe(true);
    expect(canTransitionTask("T12", "done")).toBe(false);
    expect(runTransition("R4", "running", "completed").to).toBe("succeeded");
    expect(() => runTransition("R6", "running", "completed")).toThrow(InvalidTransitionError);
    expect(() => runTransition("R2", "running")).toThrow(InvalidTransitionError);
    expect(runTransition("R7", "running", "lease_lost").to).toBe("interrupted");
  });
});

describe("retry/backoff caps (04 §7.2)", () => {
  const base = { retryable: true, attemptCount: 0, maxAttempts: 3 };
  it("retries with backoff until max_attempts, then fails", () => {
    const d1 = decideFailure({ ...base, errorFamily: "timeout" }, now);
    expect(d1).toMatchObject({ kind: "retry", attemptCount: 1 });
    expect((d1 as { notBefore: Date }).notBefore.getTime() - now.getTime()).toBe(5_000);
    const d2 = decideFailure({ ...base, errorFamily: "timeout", attemptCount: 1 }, now);
    expect((d2 as { notBefore: Date }).notBefore.getTime() - now.getTime()).toBe(30_000);
    expect(decideFailure({ ...base, errorFamily: "timeout", attemptCount: 2 }, now)).toEqual({ kind: "failed", attemptCount: 3 });
  });
  it("honours retryNotBefore (rate_limited) and classifies families", () => {
    const later = new Date(now.getTime() + 90_000);
    expect(decideFailure({ ...base, errorFamily: "rate_limited", retryNotBefore: later }, now)).toMatchObject({ kind: "retry", notBefore: later });
    expect(decideFailure({ ...base, errorFamily: "auth_failed", retryable: false }, now)).toMatchObject({ kind: "blocked", blockReason: "provider_unavailable" });
    expect(decideFailure({ ...base, errorFamily: "provider_unavailable", attemptCount: 2 }, now)).toMatchObject({ kind: "blocked", blockReason: "provider_unavailable" });
    expect(decideFailure({ ...base, errorFamily: "budget_blocked", budgetReason: "reservation_wait" }, now)).toEqual({ kind: "blocked", blockReason: "budget_reservation_wait", attemptCount: 0 });
    expect(decideFailure({ ...base, errorFamily: "budget_blocked", budgetReason: "hard_limit" }, now)).toEqual({ kind: "blocked", blockReason: "budget", attemptCount: 0 });
    expect(decideFailure({ ...base, errorFamily: "internal", previousErrorFamily: "internal" }, now)).toMatchObject({ kind: "failed" });
    expect(decideFailure({ ...base, errorFamily: "content_filtered" }, now)).toMatchObject({ kind: "failed" });
  });
});

describe("wake coalescing rules (04 §4.2)", () => {
  it("WC-2 keeps the later not_before unless user_resume", () => {
    const a = new Date(now.getTime() + 1000);
    const b = new Date(now.getTime() + 5000);
    expect(coalescedNotBefore(a, "retry", b)).toEqual(b);
    expect(coalescedNotBefore(b, "retry", a)).toEqual(b);
    expect(coalescedNotBefore(b, "user_resume", a)).toBeNull();
    expect(coalescedNotBefore(null, "retry", b)).toBeNull();
  });
  it("WC-3 window except for human-wait reasons", () => {
    const fresh = { createdAt: new Date(now.getTime() - 2000), notBeforeAt: null };
    expect(wakeClaimable({ ...fresh, reason: "task_created" }, now, 10_000)).toBe(false);
    expect(wakeClaimable({ ...fresh, reason: "question_answered" }, now, 10_000)).toBe(true);
    expect(wakeClaimable({ ...fresh, reason: "task_created" }, new Date(now.getTime() + 9000), 10_000)).toBe(true);
    expect(wakeClaimable({ reason: "user_resume", createdAt: now, notBeforeAt: new Date(now.getTime() + 1) }, now, 10_000)).toBe(false);
  });
});

describe("priority & reassign tables", () => {
  it("orders human loops first", () => {
    expect(basePriority("concept_turn")).toBeGreaterThan(basePriority("interpret_answer"));
    expect(basePriority("interpret_answer")).toBeGreaterThan(basePriority("revise_episode"));
    expect(basePriority("check_continuity")).toBeGreaterThan(basePriority("draft_episode"));
    expect(basePriority("dedupe_entities")).toBe(100);
  });
  it("MVP-α reassign pairs only", () => {
    expect(reassignAllowed("revise_episode", "line_editor")).toBe(true);
    expect(reassignAllowed("draft_episode", "line_editor")).toBe(false);
  });
});
