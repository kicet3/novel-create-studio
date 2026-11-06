import { describe, expect, it } from "vitest";
import { ENUMS } from "@ncs/shared";
import { applyLlmGrade, gradeQuestion, HOLD_TOPICS, TOPIC_RULES } from "../../src/modules/hitl/domain/grading.js";
import { buildRecommendation, isDuplicateOf, normalizeAnswer, questionDraftSchema } from "../../src/modules/hitl/domain/questions.js";
import { APPROVAL_TRANSITIONS, QUESTION_TRANSITIONS, defaultResolution, findRule } from "../../src/modules/hitl/domain/transitions.js";
import { inQuietHours, nextReminderAt, recomputeDeadline, wallClock } from "../../src/modules/hitl/domain/schedule.js";

const link = [{ type: "episode" as const, id: "epi_x" }];

describe("question state machine (03 §4.4)", () => {
  it("allows only tabled transitions", () => {
    expect(findRule(QUESTION_TRANSITIONS, "question", "pending", "open").id).toBe("Q2");
    expect(findRule(QUESTION_TRANSITIONS, "question", "open", "answered").id).toBe("Q3");
    expect(findRule(QUESTION_TRANSITIONS, "question", "defaulted", "resolved").id).toBe("Q6");
    expect(() => findRule(QUESTION_TRANSITIONS, "question", "pending", "answered")).toThrow();
    expect(() => findRule(QUESTION_TRANSITIONS, "question", "resolved", "cancelled")).toThrow();
    expect(() => findRule(APPROVAL_TRANSITIONS, "approval", "approved", "rejected")).toThrow();
  });

  it("is fail-closed: blocking never defaults; hold topics never auto-apply (INV-Q-02/04/06)", () => {
    expect(() => defaultResolution("blocking", "apply", false)).toThrow(/자동으로 결정하지 않습니다/);
    expect(defaultResolution("non_blocking", "apply", false)).toBe("default_applied");
    expect(defaultResolution("non_blocking", "apply", true)).toBe("deadline_hold");
    expect(HOLD_TOPICS.has("setup_abandon")).toBe(true);
  });
});

describe("grading (05 §4)", () => {
  it("G1 topic defaults", () => {
    expect(gradeQuestion({ topic: "creative_choice", questionType: "single_choice", links: link })).toMatchObject({ grade: "non_blocking", basis: "none", needsLlm: true });
    expect(gradeQuestion({ topic: "direction", questionType: "single_choice", links: [{ type: "arc", id: "arc_1" }] })).toMatchObject({ grade: "blocking", basis: "arc_goal" });
    expect(gradeQuestion({ topic: "budget", questionType: "approve_reject", links: link })).toMatchObject({ grade: "blocking", basis: "budget" });
    expect(gradeQuestion({ topic: "creative_choice", questionType: "single_choice", links: link, notice: true }).grade).toBe("informational");
  });

  it("FR-HIL-07 golden: each of the five criteria forces blocking even when drafted non-blocking", () => {
    const base = { topic: "creative_choice" as const, questionType: "single_choice" as const, links: link };
    expect(gradeQuestion({ ...base, hints: { endingDirection: true } }).basis).toBe("ending_direction");
    expect(gradeQuestion({ ...base, hints: { arcGoal: true } }).basis).toBe("arc_goal");
    expect(gradeQuestion({ ...base, hints: { touchesApprovedCanon: true } }).basis).toBe("canon_change");
    expect(gradeQuestion({ ...base, topic: "character_fate", hints: { majorCharacterFate: true } }).basis).toBe("major_character_fate");
    expect(gradeQuestion({ ...base, hints: { budgetChange: true } }).basis).toBe("budget");
    expect(gradeQuestion({ ...base, links: [{ type: "goal", id: "gol_1" }] }).grade).toBe("blocking");
    for (const h of [{ endingDirection: true }, { arcGoal: true }, { touchesApprovedCanon: true }, { majorCharacterFate: true }, { budgetChange: true }]) {
      expect(gradeQuestion({ ...base, hints: h }).grade).toBe("blocking");
    }
  });

  it("only upgrades (G4 agent proposal, G3 LLM) and inherits parent grade", () => {
    const g = gradeQuestion({ topic: "setup_due", questionType: "single_choice", links: link, proposedBlockingBasis: "setup_due_high" });
    expect(g).toMatchObject({ grade: "blocking", basis: "setup_due_high" });
    expect(g.reason).toContain("G4");
    expect(gradeQuestion({ topic: "interpretation_confirm", questionType: "single_choice", links: link, parent: { grade: "blocking", basis: "canon_change" } })).toMatchObject({ grade: "blocking", basis: "canon_change" });
    expect(applyLlmGrade({ grade: "blocking", basis: "budget" }, { blocking: false, basis: "none", reason_ko: "" })).toMatchObject({ grade: "blocking", changed: false });
    expect(applyLlmGrade({ grade: "non_blocking", basis: "none" }, { blocking: true, basis: "major_character_fate", reason_ko: "" })).toMatchObject({ grade: "blocking", changed: true });
    expect(Object.keys(TOPIC_RULES).sort()).toEqual([...ENUMS.question_topic].sort());
  });
});

describe("drafts, recommendations and answers", () => {
  it("validates drafts (INV-Q-05 links, option schemas)", () => {
    const ok = questionDraftSchema.safeParse({ topic: "creative_choice", questionType: "single_choice", title: "t", body: "", options: [{ label: "a", value: { kind: "choice", key: "a" } }, { label: "b", value: { kind: "choice", key: "b" } }], links: link });
    expect(ok.success).toBe(true);
    expect(questionDraftSchema.safeParse({ topic: "creative_choice", questionType: "single_choice", title: "t", body: "", options: [], links: [] }).success).toBe(false);
    const badValue = questionDraftSchema.safeParse({ topic: "setup_due", questionType: "single_choice", title: "t", body: "", options: [{ label: "a", value: { kind: "extend" } }, { label: "b", value: { kind: "abandon" } }], links: link });
    expect(badValue.success).toBe(false);
  });

  it("recommendation never auto-applies for hold topics or blocking", () => {
    const d = questionDraftSchema.parse({ topic: "duplicate_entity", questionType: "single_choice", title: "t", body: "", options: [{ label: "a", value: { kind: "same" }, isRecommended: true }, { label: "b", value: { kind: "distinct" } }], links: link, recommendation: { optionValue: { kind: "same" }, defaultAction: "apply", rationale: "r" } });
    expect(buildRecommendation(d, "non_blocking", { originTaskId: null })).toMatchObject({ option_idx: 0, default_action: "hold" });
  });

  it("normalizes answers and detects duplicates", () => {
    const base = { optionCount: 2, optionValues: [null, null], isEpisodeApproval: true, sourceKey: "k1" };
    expect(normalizeAnswer({ ...base, questionType: "single_choice", optionIds: ["1"] })).toEqual({ selected_idx: [1], source_key: "k1" });
    expect(() => normalizeAnswer({ ...base, questionType: "single_choice", optionIds: ["5"] })).toThrow(/없는 선택지/);
    expect(() => normalizeAnswer({ ...base, questionType: "approve_reject", approval: { decision: "rejected", decisionNote: "별로" } })).toThrow(/단계/);
    const rej = normalizeAnswer({ ...base, questionType: "approve_reject", approval: { decision: "rejected", decisionNote: "별로", reworkFrom: "draft" } });
    expect(rej).toMatchObject({ selected_idx: [1], decision: "rejected", rework_from: "draft" });
    expect(isDuplicateOf({ ...rej, source_key: "k2" }, rej)).toBe(true);
    expect(isDuplicateOf({ selected_idx: [0], source_key: "x" }, rej)).toBe(false);
  });
});

describe("schedule (05 §5)", () => {
  it("quiet hours in the novel timezone, wrapping midnight", () => {
    // 2026-11-05T15:00Z = 00:00 KST
    expect(inQuietHours(new Date("2026-11-05T15:00:00Z"), "Asia/Seoul", "23:00:00", "08:00:00")).toBe(true);
    expect(inQuietHours(new Date("2026-11-05T03:00:00Z"), "Asia/Seoul", "23:00:00", "08:00:00")).toBe(false);
    expect(inQuietHours(new Date("2026-11-05T03:00:00Z"), "Asia/Seoul", null, null)).toBe(false);
    expect(wallClock(new Date("2026-11-05T12:00:00Z"), "Asia/Seoul")).toBe("11/05 21:00");
  });
  it("deadline recompute keeps the longer window; reminders follow offsets", () => {
    const sent = new Date("2026-11-05T00:00:00Z");
    expect(recomputeDeadline(new Date("2026-11-05T01:00:00Z"), sent, 12)!.toISOString()).toBe("2026-11-05T12:00:00.000Z");
    const dl = new Date("2026-11-05T12:00:00Z");
    expect(nextReminderAt(dl, [0, 1440], 0)!.toISOString()).toBe(dl.toISOString());
    expect(nextReminderAt(dl, [0, 1440], 1)!.toISOString()).toBe("2026-11-06T12:00:00.000Z");
    expect(nextReminderAt(dl, [0, 1440], 2)).toBeNull();
  });
});
