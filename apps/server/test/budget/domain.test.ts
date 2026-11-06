import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  autoStatusTransition,
  decideReservation,
  overrunMicros,
  resumeTransition,
  statusForSpent,
  windowElapsed,
  windowStartFor,
} from "../../src/modules/budget/domain/policy.js";

const p = { hardLimitMicros: 1_000, hardStopEnabled: true, status: "ok" as const, spentMicros: 0, reservedMicros: 0 };

describe("budget admission (03 §7.4 step 1)", () => {
  it("distinguishes (a) hard_limit from (b) reservation_wait", () => {
    expect(decideReservation({ ...p, spentMicros: 500, reservedMicros: 200 }, 300)).toEqual({ ok: true });
    expect(decideReservation({ ...p, spentMicros: 500, reservedMicros: 300 }, 300)).toEqual({ ok: false, reason: "reservation_wait" });
    expect(decideReservation({ ...p, spentMicros: 800 }, 300)).toEqual({ ok: false, reason: "hard_limit" });
    expect(decideReservation({ ...p, status: "hard_stopped" }, 1)).toEqual({ ok: false, reason: "hard_limit" });
    expect(decideReservation({ ...p, hardLimitMicros: 0 }, 1)).toEqual({ ok: false, reason: "hard_limit" });
    expect(decideReservation({ ...p, hardStopEnabled: false, spentMicros: 5000 }, 1)).toEqual({ ok: true });
  });
  it("INV-COST-02 property: admitted reservations never exceed the limit", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000 }), fc.array(fc.integer({ min: 0, max: 3_000 }), { maxLength: 30 }), (limit, amounts) => {
        let reserved = 0;
        for (const a of amounts) {
          const d = decideReservation({ hardLimitMicros: limit, hardStopEnabled: true, status: "ok", spentMicros: 0, reservedMicros: reserved }, a);
          if (d.ok) reserved += a;
        }
        return reserved <= limit;
      }),
    );
  });
});

describe("policy status & windows", () => {
  it("computes ledger-implied status and allowed auto transitions", () => {
    expect(statusForSpent({ hardLimitMicros: 1000, softWarnRatio: 0.8, hardStopEnabled: true, spentMicros: 799 })).toBe("ok");
    expect(statusForSpent({ hardLimitMicros: 1000, softWarnRatio: 0.8, hardStopEnabled: true, spentMicros: 800 })).toBe("warning");
    expect(statusForSpent({ hardLimitMicros: 1000, softWarnRatio: 0.8, hardStopEnabled: true, spentMicros: 1000 })).toBe("hard_stopped");
    expect(autoStatusTransition("ok", "warning")?.action).toBe("budget.warning_reached");
    expect(autoStatusTransition("hard_stopped", "ok")).toBeNull(); // only resume (approval) leaves hard_stopped
    expect(resumeTransition("hard_stopped", "ok").action).toBe("budget.resumed");
    expect(() => resumeTransition("ok", "ok")).toThrow();
    expect(overrunMicros(120, 100)).toBe(20);
    expect(overrunMicros(80, 100)).toBe(0);
  });
  it("calendar_month windows roll at UTC month start", () => {
    const start = windowStartFor("calendar_month", new Date("2026-11-15T10:00:00Z"));
    expect(start.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(windowElapsed("calendar_month", start, new Date("2026-11-30T23:59:59Z"))).toBe(false);
    expect(windowElapsed("calendar_month", start, new Date("2026-12-01T00:00:00Z"))).toBe(true);
    expect(windowElapsed("lifetime", new Date(0), new Date())).toBe(false);
  });
});
