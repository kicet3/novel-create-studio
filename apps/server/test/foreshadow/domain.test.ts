import { describe, expect, it } from "vitest";
import { InvalidTransitionError, DomainValidationError } from "../../src/platform/index.js";
import {
  assertBeatTransition,
  assertCanonTransition,
  assertNarrativeTransition,
  narrativeTargetForBeat,
  parseSetupNo,
  formatSetupNo,
} from "../../src/modules/foreshadow/domain/transitions.js";
import { validateSetupPlan, type SetupPlan } from "../../src/modules/foreshadow/domain/plan.js";
import { locateQuote } from "../../src/modules/foreshadow/domain/check.js";
import { buildSetupReport, computeSetupMetrics, type ReportSetup } from "../../src/modules/foreshadow/domain/report.js";

const confirmed = (kind: "plant" | "reinforce" | "payoff") => ({ id: "sbt_1", kind, status: "confirmed" as const });

describe("setup narrative × canon state machine (03 §4.7)", () => {
  it("allows S2–S5 only with their guards", () => {
    expect(assertNarrativeTransition({ from: "planned", to: "planted", canon: "approved", beat: confirmed("plant") }).id).toBe("S2");
    expect(assertNarrativeTransition({ from: "planted", to: "reinforced", canon: "approved", beat: confirmed("reinforce") }).id).toBe("S3");
    expect(assertNarrativeTransition({ from: "reinforced", to: "reinforced", canon: "approved", beat: confirmed("reinforce") }).id).toBe("S3");
    expect(assertNarrativeTransition({ from: "reinforced", to: "paid_off", canon: "published_locked", beat: confirmed("payoff") }).id).toBe("S4");
    // INV-SU-01: confirmed beat of the right kind
    expect(() => assertNarrativeTransition({ from: "planned", to: "planted", canon: "approved", beat: { id: "b", kind: "plant", status: "detected" } })).toThrow(DomainValidationError);
    expect(() => assertNarrativeTransition({ from: "planned", to: "planted", canon: "approved", beat: confirmed("payoff") })).toThrow(DomainValidationError);
    // not in the table
    expect(() => assertNarrativeTransition({ from: "planned", to: "paid_off", canon: "approved", beat: confirmed("payoff") })).toThrow(InvalidTransitionError);
    expect(() => assertNarrativeTransition({ from: "paid_off", to: "abandoned", canon: "approved", abandonApprovalId: "apr", reason: "x" })).toThrow(InvalidTransitionError);
    // INV-SU-02
    expect(() => assertNarrativeTransition({ from: "planted", to: "abandoned", canon: "approved", reason: "x" })).toThrow(/setup_abandon/);
    expect(assertNarrativeTransition({ from: "planted", to: "abandoned", canon: "approved", abandonApprovalId: "apr_1", reason: "더 쓰지 않음" }).id).toBe("S5");
    // combination: planned + candidate cannot be abandoned (reject instead)
    expect(() => assertNarrativeTransition({ from: "planned", to: "abandoned", canon: "candidate", abandonApprovalId: "apr", reason: "x" })).toThrow(/캐논 상태/);
    // planted needs approved canon
    expect(() => assertNarrativeTransition({ from: "planned", to: "planted", canon: "candidate", beat: confirmed("plant") })).toThrow(/캐논 상태/);
  });

  it("canon SC2–SC6 with combination rule", () => {
    expect(assertCanonTransition("planned", "candidate", "approved").id).toBe("SC2");
    expect(assertCanonTransition("planned", "candidate", "rejected").id).toBe("SC3");
    expect(assertCanonTransition("planted", "approved", "published_locked").id).toBe("SC4");
    expect(assertCanonTransition("planted", "published_locked", "approved").id).toBe("SC5");
    expect(() => assertCanonTransition("abandoned", "approved", "retracted")).toThrow(/승인/);
    expect(assertCanonTransition("abandoned", "approved", "retracted", { approvalId: "apr_1" }).id).toBe("SC6");
    expect(() => assertCanonTransition("planted", "approved", "retracted", { approvalId: "apr" })).toThrow(/캐논 상태/);
    expect(() => assertCanonTransition("planned", "approved", "candidate")).toThrow(InvalidTransitionError);
  });

  it("beat status table (07 §5.2) and narrative target", () => {
    expect(assertBeatTransition("planned", "detected").id).toBe("B1");
    expect(assertBeatTransition("planned", "missing").id).toBe("B2");
    expect(assertBeatTransition("missing", "detected").id).toBe("B3");
    expect(assertBeatTransition("detected", "planned").id).toBe("B4");
    expect(assertBeatTransition("detected", "confirmed").id).toBe("B5");
    expect(assertBeatTransition("missing", "cancelled").id).toBe("B6");
    expect(() => assertBeatTransition("confirmed", "planned")).toThrow(InvalidTransitionError);
    expect(() => assertBeatTransition("detected", "missing")).toThrow(InvalidTransitionError);
    expect(narrativeTargetForBeat("plant", "planned")).toBe("planted");
    expect(narrativeTargetForBeat("plant", "planted")).toBeNull();
    expect(narrativeTargetForBeat("reinforce", "reinforced")).toBe("reinforced");
    expect(narrativeTargetForBeat("payoff", "planned")).toBeNull();
    expect(formatSetupNo(3)).toBe("S-03");
    expect([parseSetupNo("S-03"), parseSetupNo("03"), parseSetupNo("12"), parseSetupNo("x")]).toEqual([3, 3, 12, null]);
  });
});

describe("setup placement checks SP-1..SP-4 (07 §1.3)", () => {
  const ctx = {
    arc: { id: "arc_A", plannedEpisodeFrom: 1, plannedEpisodeTo: 10 },
    arcEnds: new Map([["arc_A", 10]]),
    existing: new Map([
      ["stp_OLD", { narrativeStatus: "planted" as const, dueKind: "episode" as const, dueEpisodeNo: 8, dueArcId: null, plantConfirmed: true, plantEpisodeNo: null }],
      ["stp_UNPLANTED", { narrativeStatus: "planned" as const, dueKind: "episode" as const, dueEpisodeNo: 8, dueArcId: null, plantConfirmed: false, plantEpisodeNo: null }],
    ]),
  };
  const ok: SetupPlan = {
    new_setups: [
      {
        title: "반지",
        description: "가문의 표식",
        importance: "high",
        due_kind: "arc",
        beats: [
          { kind: "plant", planned_episode_no: 1 },
          { kind: "reinforce", planned_episode_no: 4 },
          { kind: "payoff", planned_episode_no: 9 },
        ],
        entity_ids: ["ent_01JABCDEFGHJKMNPQRSTVWXYZ0"],
        fact_ids: [],
      },
    ],
    existing_setup_beats: [{ setup_id: "stp_OLD", beats: [{ kind: "payoff", planned_episode_no: 7 }] }],
  };
  it("accepts a valid plan", () => {
    expect(validateSetupPlan(ok, ctx)).toEqual([]);
  });
  it("flags each rule", () => {
    const bad: SetupPlan = {
      new_setups: [
        { title: "a", description: "b", importance: "low", due_kind: "episode", due_episode_no: 5, beats: [{ kind: "plant", planned_episode_no: 3 }, { kind: "payoff", planned_episode_no: 6 }], entity_ids: ["윤서"], fact_ids: [] },
        { title: "c", description: "d", importance: "low", due_kind: "arc", beats: [{ kind: "payoff", planned_episode_no: 12 }], entity_ids: [], fact_ids: [] },
        { title: "e", description: "f", importance: "low", due_kind: "arc", beats: [{ kind: "plant", planned_episode_no: 5 }, { kind: "reinforce", planned_episode_no: 5 }], entity_ids: [], fact_ids: [] },
      ],
      existing_setup_beats: [{ setup_id: "stp_UNPLANTED", beats: [{ kind: "payoff", planned_episode_no: 7 }] }, { setup_id: "stp_NONE", beats: [{ kind: "payoff", planned_episode_no: 2 }] }],
    };
    const rules = validateSetupPlan(bad, ctx).map((v) => v.rule);
    expect(rules).toEqual(expect.arrayContaining(["SP-1", "SP-2", "SP-3", "SP-4"]));
    expect(rules.filter((r) => r === "SP-3").length).toBeGreaterThanOrEqual(3); // no plant ×2 + order
  });
});

describe("locateQuote", () => {
  const content = "첫 문장입니다.\n\n  은반지가   빛났다. 끝.";
  const scenes = [
    { id: "scn_1", ord: 1, charStart: 0, charEnd: 9 },
    { id: "scn_2", ord: 2, charStart: 9, charEnd: content.length },
  ];
  it("finds exact, whitespace-insensitive and scene fallback spans", () => {
    expect(locateQuote(content, scenes, "첫 문장")).toEqual({ sceneId: "scn_1", charStart: 0, charEnd: 4 });
    const ws = locateQuote(content, scenes, "은반지가 빛났다.")!;
    expect(ws.sceneId).toBe("scn_2");
    expect(content.slice(ws.charStart, ws.charEnd)).toBe("은반지가   빛났다.");
    expect(locateQuote(content, scenes, "없는 문장", 2)).toEqual({ sceneId: "scn_2", charStart: 9, charEnd: content.length });
    expect(locateQuote(content, scenes, "없는 문장")).toBeNull();
  });
});

describe("SetupReport / metrics (06 §8.1–8.2)", () => {
  const d = (h: number) => new Date(Date.UTC(2026, 10, 1) + h * 3_600_000);
  const beat = (kind: "plant" | "reinforce" | "payoff", status: "confirmed" | "planned", at: Date | null) => ({ id: `b_${kind}_${Math.random()}`, kind, status, plannedEpisodeNo: 1, episodeId: "epi", sceneId: "scn", charStart: 0, charEnd: 1, confirmedAt: at });
  const base = (over: Partial<ReportSetup>): ReportSetup => ({
    id: "stp_x",
    displayNo: 1,
    title: "t",
    importance: "medium",
    narrativeStatus: "planted",
    canonStatus: "approved",
    dueKind: "episode",
    dueEpisodeNo: 3,
    dueArcId: null,
    createdAt: d(0),
    abandonedAt: null,
    beats: [],
    dueChanges: [],
    ...over,
  });
  // episodes 1..8 approved at hour n
  const approvedAt = new Map(Array.from({ length: 8 }, (_, i) => [i + 1, d(i + 1)] as [number, Date]));
  const setups: ReportSetup[] = [
    base({ id: "A", displayNo: 1, narrativeStatus: "paid_off", beats: [beat("plant", "confirmed", d(1)), beat("payoff", "confirmed", d(3))] }), // paid in time, no reinforce → R3
    base({ id: "B", displayNo: 2, narrativeStatus: "planted", beats: [beat("plant", "confirmed", d(1))] }), // overdue, unhandled → R2
    base({
      id: "C",
      displayNo: 3,
      narrativeStatus: "reinforced",
      dueEpisodeNo: 9,
      beats: [beat("plant", "confirmed", d(1)), beat("reinforce", "confirmed", d(2))],
      dueChanges: [{ fromDueKind: "episode", fromDueEpisodeNo: 3, fromDueArcId: null, toDueKind: "episode", toDueEpisodeNo: 9, toDueArcId: null, createdAt: d(4.5) }],
    }), // overdue at ep 4 (hour 4), extended at 4.5 → handled
    base({ id: "D", displayNo: 4, narrativeStatus: "abandoned", abandonedAt: d(5), beats: [beat("plant", "confirmed", d(1))] }),
    base({ id: "E", displayNo: 5, narrativeStatus: "planned", canonStatus: "candidate" }),
  ];
  it("computes R1–R3 and the three metrics", () => {
    const r = buildSetupReport({ setups, approvedAt, arcEnds: new Map(), asOfEpisodeNo: 8, overdueWindowEpisodes: 3, dueQuestions: new Map([["B", { questionId: "qst_1", status: "open" }]]), contradictions: [] });
    expect(r.r1Unresolved.map((x) => x.setupId).sort()).toEqual(["B", "C"]);
    expect(r.r2Overdue.map((x) => [x.setupId, x.overdueEpisodes, x.openQuestionId])).toEqual([["B", 5, "qst_1"]]);
    expect(r.r3PaidOffWithoutReinforce.map((x) => x.setupId)).toEqual(["A"]);
    // due reached (≤ 8): A, B, D (C now due 9; E never planted)
    expect(r.r5Metrics.payoffRate).toEqual({ value: 1 / 3, numerator: 1, denominator: 3 });
    expect(r.r5Metrics.abandonRate).toEqual({ value: 1 / 3, numerator: 1, denominator: 3 });
    // overdue events: B (unhandled, window ended at ep 6), C (handled by due change), D (abandoned at 5 < window end 6)
    expect(r.r5Metrics.overdueHandledRate).toEqual({ value: 2 / 3, numerator: 2, denominator: 3 });
  });
  it("returns null metrics without denominators", () => {
    const m = computeSetupMetrics({ setups: [], approvedAt: new Map(), arcEnds: new Map(), asOfEpisodeNo: null, overdueWindowEpisodes: 3 });
    expect(m.payoffRate.value).toBeNull();
    expect(m.overdueHandledRate.denominator).toBe(0);
  });
});
