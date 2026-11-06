import { describe, expect, it } from "vitest";
import { beatCounts, dueState } from "./api.js";
import { bulkInfo, mergeActivity, summarizeChange } from "../audit/api.js";
import { actionLabelKo, actorLabelKo } from "../audit/labels.js";
import { formatRange, formatRangeLiteral } from "../ontology/api.js";

describe("dueState (08 §9.6)", () => {
  it("classifies overdue / due soon / ok / none", () => {
    expect(dueState({ narrativeStatus: "planted", remainingEpisodes: -2 })).toBe("overdue");
    expect(dueState({ narrativeStatus: "reinforced", remainingEpisodes: 5 })).toBe("due_soon");
    expect(dueState({ narrativeStatus: "planted", remainingEpisodes: 0 })).toBe("due_soon");
    expect(dueState({ narrativeStatus: "planned", remainingEpisodes: 6 })).toBe("ok");
    expect(dueState({ narrativeStatus: "planted", remainingEpisodes: null })).toBe("none");
  });
  it("closed setups have no due state", () => {
    expect(dueState({ narrativeStatus: "paid_off", remainingEpisodes: -10 })).toBe("none");
    expect(dueState({ narrativeStatus: "abandoned", remainingEpisodes: -10 })).toBe("none");
  });
});

describe("beatCounts", () => {
  it("counts planned/done/missing per kind, ignoring cancelled", () => {
    const b = (kind: "plant" | "reinforce" | "payoff", status: string) => ({ kind, status }) as never;
    const c = beatCounts({ beats: [b("plant", "confirmed"), b("reinforce", "missing"), b("reinforce", "detected"), b("payoff", "cancelled")] });
    expect(c.plant).toEqual({ planned: 1, done: 1, missing: 0 });
    expect(c.reinforce).toEqual({ planned: 2, done: 1, missing: 1 });
    expect(c.payoff).toEqual({ planned: 0, done: 0, missing: 0 });
  });
});

describe("audit helpers", () => {
  const act = (seq: number) => ({ seq }) as never;
  it("merges head + pages newest first without duplicates", () => {
    expect(mergeActivity([act(5), act(4)], [act(4), act(3)]).map((a: { seq: number }) => a.seq)).toEqual([5, 4, 3]);
  });
  it("summarizes changed keys only", () => {
    expect(summarizeChange({ status: "drafting", n: 1 }, { status: "checking", n: 1 })).toEqual([{ key: "status", from: "drafting", to: "checking" }]);
    expect(summarizeChange(null, null)).toEqual([]);
  });
  it("reads bulk details", () => {
    expect(bulkInfo({ ids: ["a", "b"], count: 2 })).toEqual({ count: 2, ids: ["a", "b"] });
    expect(bulkInfo({ other: 1 })).toBeNull();
  });
  it("labels actions and actors in Korean", () => {
    expect(actionLabelKo("episode.status_changed")).toBe("화 · 상태 변경");
    expect(actionLabelKo("mention.batch_linked")).toBe("언급 · 일괄 연결");
    expect(actorLabelKo({ actorType: "user", actorId: "usr_1" }, { id: "usr_1", displayName: "민준" })).toBe("사람 · 민준");
  });
});

describe("ontology range formatting", () => {
  it("formats int4range literals and objects", () => {
    expect(formatRangeLiteral("[0,)")).toBe("시점 0~");
    expect(formatRangeLiteral("[3,11)")).toBe("시점 3~10");
    expect(formatRange({ from: 2, to: null })).toBe("시점 2~");
  });
});
