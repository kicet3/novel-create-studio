import { describe, expect, it } from "vitest";
import { isId } from "@ncs/shared";
import { FakeClock, SeqIdFactory, buildTask } from "../src/index.js";

describe("FakeClock", () => {
  it("advances and fires timers in order", () => {
    const c = new FakeClock("2026-11-01T00:00:00Z");
    const fired: string[] = [];
    c.setTimeout(() => fired.push("b"), 2000);
    c.setTimeout(() => fired.push("a"), 1000);
    const iv = c.setInterval(() => fired.push("i"), 1500);
    c.advance(3000);
    expect(fired).toEqual(["a", "i", "b", "i"]);
    c.clear(iv);
    c.advanceSeconds(10);
    expect(fired).toHaveLength(4);
    expect(c.date().toISOString()).toBe("2026-11-01T00:00:13.000Z");
    expect(() => c.set(0)).toThrow(RangeError);
  });
});

describe("fixtures", () => {
  it("SeqIdFactory produces deterministic valid ids", () => {
    const a = new SeqIdFactory();
    const b = new SeqIdFactory();
    const x = a.next("nov");
    expect(x).toBe(b.next("nov"));
    expect(isId(x, "nov")).toBe(true);
    expect(a.next("nov")).not.toBe(x);
  });
  it("buildTask fills required fields", () => {
    const t = buildTask("nov_01JCXZ8Q4M7R2V5K9T3B6N1H0D", { kind: "draft_episode" });
    expect(t.kind).toBe("draft_episode");
    expect(isId(t.id, "tsk")).toBe(true);
  });
});
