/** 설계 추가 0014 — pure rules of the autopilot: approval policy, question sensitivity / eligibility, front steps, publish slots. */
import { describe, expect, it } from "vitest";
import { AUTOPILOT_DEFAULTS, parseAutopilotSettings, startOfLocalDay, nextLocalMidnight, wallParts, type AutopilotSettings } from "@ncs/shared";
import { ALWAYS_HUMAN_TYPES, evaluateApproval, holdsForAuto, questionAutoAnswerable, type ApprovalFacts } from "../../src/modules/autopilot/domain/policy.js";
import { planSteps, type StepFacts } from "../../src/modules/autopilot/domain/steps.js";
import { nextPublishSlots, publishWeekdays } from "../../src/modules/autopilot/domain/publish-slots.js";
import { questionSensitivity } from "../../src/modules/hitl/domain/grading.js";

const S = (over: Partial<AutopilotSettings> = {}): AutopilotSettings => ({ ...parseAutopilotSettings({}), ...over });
const created = new Date("2026-11-05T03:00:00.000Z");
const ap = (approvalType: string, payload: unknown = {}) => ({ approvalType, createdAt: created, payload });
const ep = (over: Partial<Extract<ApprovalFacts, { type: "episode" }>> = {}): ApprovalFacts => ({
  type: "episode",
  episodeStatus: "awaiting_approval",
  episodeNo: 3,
  belowFloor: false,
  openHigh: 0,
  openMedium: 0,
  safetyEver: 0,
  rewriteLimit: false,
  pendingCanon: 0,
  ...over,
});

describe("settings", () => {
  it("empty JSON = defaults; invalid values are dropped key by key", () => {
    expect(parseAutopilotSettings({})).toEqual(AUTOPILOT_DEFAULTS);
    expect(parseAutopilotSettings({ maxEpisodesPerDay: 0, autoAnswerAfterMinutes: 45, bogus: 1 })).toMatchObject({ maxEpisodesPerDay: 3, autoAnswerAfterMinutes: 45 });
    expect(AUTOPILOT_DEFAULTS).toMatchObject({ autoConfirmConcept: false, autoApproveStructure: false, autoAnswerAfterMinutes: 30 });
  });
});

describe("approval policy", () => {
  it("episode: auto when clean; short / safety / rewrite limit / open high → human; canon change pending → wait", () => {
    expect(evaluateApproval(ap("episode"), ep(), S())).toEqual({ kind: "auto", at: created });
    expect(evaluateApproval(ap("episode"), ep(), S({ approveDelayMinutes: 15 }))).toEqual({ kind: "auto", at: new Date(created.getTime() + 15 * 60_000) });
    expect(evaluateApproval(ap("episode"), ep({ belowFloor: true }), S())).toMatchObject({ kind: "human", gate: "length_below_floor" });
    expect(evaluateApproval(ap("episode"), ep({ safetyEver: 1 }), S())).toMatchObject({ kind: "human", gate: "safety" });
    expect(evaluateApproval(ap("episode"), ep({ rewriteLimit: true }), S())).toMatchObject({ kind: "human", gate: "rewrite_limit" });
    expect(evaluateApproval(ap("episode"), ep({ openHigh: 1 }), S())).toMatchObject({ kind: "human", gate: "open_high_issue" });
    expect(evaluateApproval(ap("episode"), ep({ openMedium: 2 }), S())).toMatchObject({ kind: "auto" });
    expect(evaluateApproval(ap("episode"), ep({ openMedium: 2 }), S({ holdOnMediumIssues: true }))).toMatchObject({ kind: "human", gate: "open_medium_issue" });
    expect(evaluateApproval(ap("episode"), ep({ pendingCanon: 1 }), S())).toMatchObject({ kind: "wait" });
    expect(evaluateApproval(ap("episode"), ep(), S({ autoApproveEpisodes: false }))).toMatchObject({ kind: "human", gate: "setting_off" });
    expect(evaluateApproval(ap("episode", { autopilot: { heldReason: "분량 미달" } }), ep(), S())).toMatchObject({ kind: "human", gate: "held" });
  });

  it("arc_plan: plot characters filled → accepted then approved; missing fields → fill (wait) → human after the attempts", () => {
    const f = (over: Partial<Extract<ApprovalFacts, { type: "arc_plan" }>> = {}): ApprovalFacts => ({ type: "arc_plan", arcStatus: "plan_awaiting_approval", arcTitle: "흉터의 기억", replan: false, structureApproved: true, castMissing: 0, castUnaccepted: 0, fillAttempts: 0, fillRunning: false, ...over });
    expect(evaluateApproval(ap("arc_plan"), f(), S())).toMatchObject({ kind: "auto" });
    expect(evaluateApproval(ap("arc_plan"), f({ castUnaccepted: 1 }), S())).toMatchObject({ kind: "auto", prepare: "accept_plot_cast" });
    expect(evaluateApproval(ap("arc_plan"), f({ castMissing: 1 }), S())).toMatchObject({ kind: "wait", action: "fill_plot_cast" });
    expect(evaluateApproval(ap("arc_plan"), f({ castMissing: 1, fillRunning: true }), S())).toMatchObject({ kind: "wait" });
    expect(evaluateApproval(ap("arc_plan"), f({ castMissing: 1, fillAttempts: 2 }), S())).toMatchObject({ kind: "human", gate: "plot_cast_incomplete" });
    expect(evaluateApproval(ap("arc_plan", { replan: {} }), f({ replan: true, arcStatus: "active" }), S())).toMatchObject({ kind: "auto" });
    expect(evaluateApproval(ap("arc_plan"), f(), S({ autoApprovePlots: false }))).toMatchObject({ kind: "human" });
  });

  it("structure and concept need the opt-in; a changed ending or a policy / copyright signal is always human", () => {
    const st = (over: Partial<Extract<ApprovalFacts, { type: "story_structure" }>> = {}): ApprovalFacts => ({ type: "story_structure", status: "awaiting_approval", reasons: [], endingChanged: false, castComplete: true, revisionMatches: true, fillAttempts: 0, fillRunning: false, ...over });
    expect(evaluateApproval(ap("story_structure"), st(), S())).toMatchObject({ kind: "human", gate: "setting_off" });
    expect(evaluateApproval(ap("story_structure"), st(), S({ autoApproveStructure: true }))).toMatchObject({ kind: "auto" });
    expect(evaluateApproval(ap("story_structure"), st({ endingChanged: true }), S({ autoApproveStructure: true }))).toMatchObject({ kind: "human", gate: "ending_changed" });
    expect(evaluateApproval(ap("story_structure"), st({ reasons: ["1부 목표가 비었습니다."] }), S({ autoApproveStructure: true }))).toMatchObject({ kind: "human", gate: "structure_incomplete" });
    const cb = (over: Partial<Extract<ApprovalFacts, { type: "concept_brief" }>> = {}): ApprovalFacts => ({ type: "concept_brief", briefStatus: "awaiting_approval", initial: true, safetyHits: 0, similarityHits: 0, llmChecked: true, ...over });
    expect(evaluateApproval(ap("concept_brief"), cb(), S())).toMatchObject({ kind: "human" });
    expect(evaluateApproval(ap("concept_brief"), cb(), S({ autoConfirmConcept: true }))).toMatchObject({ kind: "auto" });
    expect(evaluateApproval(ap("concept_brief"), cb({ similarityHits: 1 }), S({ autoConfirmConcept: true }))).toMatchObject({ kind: "human", gate: "policy_copyright" });
    expect(evaluateApproval(ap("concept_brief"), cb({ initial: false }), S({ autoConfirmConcept: true }))).toMatchObject({ kind: "human", gate: "concept_revision" });
    // the LLM similarity / safety check did not answer (no provider / unparsable): "unchecked", never "clean"
    expect(evaluateApproval(ap("concept_brief"), cb({ llmChecked: false }), S({ autoConfirmConcept: true }))).toMatchObject({ kind: "human", gate: "concept_unchecked" });
    // structure with an incomplete main cast: fill first (planning has no cast step), then hand over
    expect(evaluateApproval(ap("story_structure"), st({ castComplete: false }), S({ autoApproveStructure: true }))).toMatchObject({ kind: "wait", action: "fill_cast" });
    expect(evaluateApproval(ap("story_structure"), st({ castComplete: false, fillRunning: true }), S({ autoApproveStructure: true }))).toMatchObject({ kind: "wait" });
    expect(evaluateApproval(ap("story_structure"), st({ castComplete: false, fillAttempts: 2 }), S({ autoApproveStructure: true }))).toMatchObject({ kind: "human", gate: "cast_incomplete" });
  });

  it("always-human types never become auto (and the dispatcher never holds them)", () => {
    for (const t of ALWAYS_HUMAN_TYPES) {
      expect(evaluateApproval(ap(t), { type: "other", approvalType: t }, S({ autoApproveStructure: true, autoConfirmConcept: true })), t).toMatchObject({ kind: "human", gate: "always_human" });
      expect(holdsForAuto(t, {}, S()), t).toBe(false);
    }
    expect(holdsForAuto("episode", {}, S())).toBe(true);
    expect(holdsForAuto("episode", { lengthBelowFloor: true }, S())).toBe(false);
    expect(holdsForAuto("episode", { autopilot: { heldReason: "x" } }, S())).toBe(false);
    expect(holdsForAuto("story_structure", {}, S())).toBe(false);
    expect(holdsForAuto("story_structure", {}, S({ autoApproveStructure: true }))).toBe(true);
    expect(holdsForAuto("story_structure", { pendingChanges: { goalEndingChanged: true } }, S({ autoApproveStructure: true }))).toBe(false);
  });
});

describe("questions", () => {
  it("sensitivity: hold topics, always-human topics and bases, canon / fate / ending hints and agent-raised → high", () => {
    expect(questionSensitivity({ topic: "creative_choice", basis: "none" })).toBe("normal");
    expect(questionSensitivity({ topic: "creative_choice", basis: "arc_goal" })).toBe("normal");
    expect(questionSensitivity({ topic: "duplicate_entity", basis: "none" })).toBe("high");
    expect(questionSensitivity({ topic: "retcon", basis: "published_canon" })).toBe("high");
    expect(questionSensitivity({ topic: "character_fate", basis: "major_character_fate" })).toBe("high");
    expect(questionSensitivity({ topic: "creative_choice", basis: "none", hints: { touchesApprovedCanon: true } })).toBe("high");
    expect(questionSensitivity({ topic: "creative_choice", basis: "none", proposed: "high" })).toBe("high");
  });

  it("eligibility: choice questions after the timeout; blocking only arc goal / setup due with the opt-in", () => {
    const q = (over: Record<string, unknown> = {}) => ({ approvalId: null, grade: "non_blocking", blockingBasis: "none", sensitivity: "normal", questionType: "single_choice", createdAt: created, status: "open", ...over });
    const at = (m: number) => new Date(created.getTime() + m * 60_000);
    expect(questionAutoAnswerable(q(), S(), at(29))).toMatchObject({ ok: false, reason: "not_yet" });
    expect(questionAutoAnswerable(q(), S(), at(30))).toEqual({ ok: true });
    expect(questionAutoAnswerable(q({ questionType: "free_text" }), S(), at(60))).toMatchObject({ ok: false, reason: "not_choice" });
    expect(questionAutoAnswerable(q({ sensitivity: "high" }), S(), at(60))).toMatchObject({ ok: false, reason: "high_sensitivity" });
    expect(questionAutoAnswerable(q({ approvalId: "apr_x" }), S(), at(60))).toMatchObject({ ok: false, reason: "approval" });
    expect(questionAutoAnswerable(q({ grade: "blocking", blockingBasis: "arc_goal" }), S(), at(60))).toMatchObject({ ok: false, reason: "blocking" });
    expect(questionAutoAnswerable(q({ grade: "blocking", blockingBasis: "arc_goal" }), S({ autoAnswerImportant: true }), at(60))).toEqual({ ok: true });
    expect(questionAutoAnswerable(q({ grade: "blocking", blockingBasis: "approval_gate" }), S({ autoAnswerImportant: true }), at(60))).toMatchObject({ ok: false });
    expect(questionAutoAnswerable(q(), S({ autoAnswerQuestions: false }), at(60))).toMatchObject({ ok: false, reason: "setting_off" });
  });
});

describe("front steps", () => {
  const base = (over: Partial<StepFacts> = {}): StepFacts => ({
    novelStatus: "onboarding",
    concept: { approved: true, awaiting: false, sessionActive: false, autoRunning: false, attempts: 0 },
    world: { state: "done", taskId: "tsk_w", pending: 5, approvedTaskId: null },
    cast: { confirmed: false, pendingChanges: 0, blockers: [], missing: 1, draftRunning: false, fillAttempts: 0 },
    goal: { saved: false, endingDirection: "결말" },
    bible: "none",
    structure: { status: "none", taskActive: false, canGenerate: true, gateReasons: [], attempts: 0, lastError: null },
    plots: { total: 0, active: 0, planned: 0, completed: 0 },
    episodes: { approvedOrPublished: 0, awaiting: 0, inFlight: 0, targetMin: 12, nextTitle: null },
    sinceLastAttempt: {},
    ...over,
  });
  it("onboarding: world candidates + cast fill, then confirm, then goal (after the world settled)", () => {
    expect(planSteps(base(), S()).run).toEqual(["world_approve", "cast_fill"]);
    const filled = base({ world: { state: "done", taskId: "tsk_w", pending: 0, approvedTaskId: "tsk_w" }, cast: { confirmed: false, pendingChanges: 1, blockers: [], missing: 0, draftRunning: false, fillAttempts: 1 } });
    expect(planSteps(filled, S()).run).toEqual(["cast_confirm"]);
    const confirmed = base({ world: { state: "running", taskId: "tsk_w", pending: 0, approvedTaskId: null }, cast: { confirmed: true, pendingChanges: 0, blockers: [], missing: 0, draftRunning: false, fillAttempts: 1 } });
    expect(planSteps(confirmed, S()).run).toEqual([]); // waits for the world generation
    expect(planSteps({ ...confirmed, world: { ...confirmed.world, state: "done" } }, S()).run).toEqual(["goal_save"]);
    expect(planSteps({ ...confirmed, world: { ...confirmed.world, state: "failed" }, goal: { saved: false, endingDirection: "" } }, S()).gates.map((g) => g.code)).toEqual(["goal_ending"]);
    expect(planSteps(base({ cast: { confirmed: false, pendingChanges: 0, blockers: [], missing: 1, draftRunning: false, fillAttempts: 2 } }), S()).gates.map((g) => g.code)).toEqual(["cast_incomplete"]);
    expect(planSteps(base(), S({ autoAcceptWorld: false, autoCompleteCast: false })).gates.map((g) => g.code)).toEqual(["cast_confirm"]);
    // retry spacing
    expect(planSteps(base({ sinceLastAttempt: { cast_fill: 5 } }), S()).run).toEqual(["world_approve"]);
  });
  it("concept: human unless the opt-in; structure: request once the bible is approved; completion", () => {
    const concept = base({ novelStatus: "concept", concept: { approved: false, awaiting: false, sessionActive: true, autoRunning: false, attempts: 0 } });
    expect(planSteps(concept, S()).gates.map((g) => g.code)).toEqual(["concept_confirm"]);
    expect(planSteps(concept, S({ autoConfirmConcept: true })).run).toEqual(["concept_submit"]);
    expect(planSteps({ ...concept, concept: { ...concept.concept, autoRunning: true } }, S({ autoConfirmConcept: true })).run).toEqual([]);
    const planning = base({ novelStatus: "planning", bible: "approved" });
    expect(planSteps(planning, S()).run).toEqual(["structure_request"]);
    expect(planSteps({ ...planning, structure: { ...planning.structure, status: "draft" } }, S()).gates.map((g) => g.code)).toEqual(["structure_review"]);
    const done = base({ novelStatus: "serializing", bible: "approved", structure: { ...planning.structure, status: "approved" }, plots: { total: 4, active: 0, planned: 0, completed: 4 }, episodes: { approvedOrPublished: 12, awaiting: 0, inFlight: 0, targetMin: 12, nextTitle: null } });
    expect(planSteps(done, S())).toMatchObject({ phase: "completed", completed: true });
  });
});

describe("publish slots", () => {
  it("spreads the weekly cadence (7 → daily, 5 → Mon–Fri, 3 → Mon/Wed/Fri) at the local publish time", () => {
    expect(publishWeekdays(7)).toHaveLength(7);
    expect(publishWeekdays(5)).toEqual([1, 2, 3, 4, 5]);
    expect(publishWeekdays(3)).toEqual([1, 3, 5]);
    // Thu 2026-11-05 12:00 KST
    const after = new Date("2026-11-05T03:00:00.000Z");
    const three = nextPublishSlots({ after, count: 3, perWeek: 3, timeLocal: "18:00", timeZone: "Asia/Seoul", taken: [] });
    expect(three.map((d) => d.toISOString())).toEqual(["2026-11-06T09:00:00.000Z", "2026-11-09T09:00:00.000Z", "2026-11-11T09:00:00.000Z"]); // Fri, Mon, Wed
    const daily = nextPublishSlots({ after, count: 2, perWeek: 7, timeLocal: "18:00", timeZone: "Asia/Seoul", taken: [new Date("2026-11-05T09:00:00.000Z")] });
    expect(daily.map((d) => d.toISOString())).toEqual(["2026-11-06T09:00:00.000Z", "2026-11-07T09:00:00.000Z"]); // today's slot is taken
    const ny = nextPublishSlots({ after, count: 1, perWeek: 7, timeLocal: "07:30", timeZone: "America/New_York", taken: [] });
    expect(wallParts(ny[0]!, "America/New_York")).toMatchObject({ hour: 7, minute: 30 });
  });
  it("local day boundaries", () => {
    const at = new Date("2026-11-05T16:30:00.000Z"); // 01:30 KST on the 6th
    expect(startOfLocalDay(at, "Asia/Seoul").toISOString()).toBe("2026-11-05T15:00:00.000Z");
    expect(nextLocalMidnight(at, "Asia/Seoul").toISOString()).toBe("2026-11-06T15:00:00.000Z");
  });
});
