/**
 * 설계 변경: the concept chat is driven by brief completeness — once every required field is confirmed the partner
 * closes with a summary and points to [승인 요청] (no new question); the turn cap is only a hidden safety ceiling.
 */
import { describe, expect, it } from "vitest";
import { DEFAULTS } from "@ncs/shared";
import { emptyWorkingBrief, type WorkingBrief } from "../../src/modules/concept/domain/brief.js";
import { DEFAULT_SAFETY_LISTS } from "../../src/modules/concept/domain/checks.js";
import { briefComplete, CONTROL, READY_TEXT, selectNext, turnCapText } from "../../src/modules/concept/domain/next-question.js";
import { planFieldEdit, planTurn, type TurnLimits, type TurnMessage } from "../../src/modules/concept/domain/turn.js";

let n = 0;
const newId = () => `cpr_${++n}`;
const ceiling = DEFAULTS["concept.max_turns"];
const limits = (agentTurnCount: number): TurnLimits => ({
  flipLimit: 3,
  softWarning: ceiling - DEFAULTS["concept.turn_soft_warning_remaining"],
  agentTurnCount,
  turnLimit: ceiling,
  messenger: false,
  replyMaxChars: 1200,
});
const userMsg = (body: string): TurnMessage => ({ id: "cnm_u", seq: 2, authorKind: "user", kind: "text", body, channelId: "chn_web", pickedIdx: null, options: null, askedFieldPaths: null });

function brief(skip: string[] = []): WorkingBrief {
  const b = emptyWorkingBrief({ web_channel_id: "chn_web" });
  const values: Array<[string, string]> = [
    ["category.genre_label", "SF"],
    ["age_rating", "age_12"],
    ["protagonist.starting_condition", "화성 기지의 정비공"],
    ["protagonist.desire", "지구로 돌아가기"],
    ["opposition", "기지를 봉쇄한 회사"],
    ["core_hook", "정비공만 기지의 AI와 대화할 수 있다"],
    ["ending_direction", "귀환에 성공하지만 AI를 남겨 둔다"],
    ["logline", "화성 정비공이 회사의 봉쇄를 뚫고 지구로 돌아간다"],
  ];
  for (const [path, v] of values) {
    if (skip.includes(path)) continue;
    Object.assign(b, planFieldEdit({ brief: b, stage: "confirming", entryMode: "conversation", messageId: `cnm_${path}`, path, value: v, lists: DEFAULT_SAFETY_LISTS, flipLimit: 3, newId }).brief);
  }
  return b;
}

const turn = (b: WorkingBrief, used: number) =>
  planTurn({ brief: b, stage: "confirming", entryMode: "conversation", messages: [userMsg("좋아요")], prompt: null, proposal: null, runId: "run_1", lists: DEFAULT_SAFETY_LISTS, limits: limits(used), newId });

describe("brief completeness drives the concept chat", () => {
  it("defaults: the turn cap is a high safety ceiling, not a 40-turn conversation length", () => {
    expect(ceiling).toBeGreaterThanOrEqual(200);
    expect(DEFAULTS["concept.turn_extension"]).toBeGreaterThan(0);
    expect(CONTROL.extendTurns.label).toBe(`${DEFAULTS["concept.turn_extension"]}턴 더`);
  });

  it("complete brief → closing summary + [승인 요청] guidance, no new question", () => {
    const b = brief();
    expect(briefComplete(b)).toBe(true);
    expect(selectNext(b, "confirming").kind).toBe("ready");
    const out = turn(b, 3);
    expect(out.reply.body).toContain("지금까지:");
    expect(out.reply.body).toContain("화성 기지의 정비공");
    expect(out.reply.body).toContain(READY_TEXT);
    expect(out.reply.body).not.toContain("[질문]");
    expect(out.reply.body.match(/필수 항목이 모두 확정/g)).toHaveLength(1);
    expect(out.reply.options.map((o) => o.value)).toEqual([CONTROL.submit.value]);
    expect(out.reply.askedFieldPaths).toEqual([]);
  });

  it("a brief completed before the confirming stage (e.g. through the form) is ready — no extra stage-move prompt (review fix)", () => {
    const b = brief();
    for (const stage of ["diverging", "converging"] as const) expect(selectNext(b, stage).kind).toBe("ready");
    // still incomplete → the stage move is proposed as before
    expect(selectNext(brief(["logline"]), "converging").kind).toBe("propose_stage");
  });

  it("incomplete brief keeps asking past 40 turns, with no turn-count warning far from the ceiling", () => {
    const b = brief(["ending_direction"]);
    expect(briefComplete(b)).toBe(false);
    const out = turn(b, 45);
    expect(out.reply.askedFieldPaths).toEqual(["ending_direction"]);
    expect(out.reply.body).not.toContain("안전 상한");
    expect(out.reply.body).not.toMatch(/\d+\/\d+턴/);
  });

  it("near the ceiling the reply warns with the remaining field names; a complete brief is never warned", () => {
    const near = ceiling - 5;
    const out = turn(brief(["ending_direction"]), near);
    expect(out.reply.body).toContain(`대화 안전 상한까지 ${ceiling - near - 1}턴 남았습니다`);
    expect(out.reply.body).toContain("결말");
    expect(turn(brief(), near).reply.body).not.toContain("안전 상한");
  });

  it("turn cap notice names the remaining fields and how to continue", () => {
    const text = turnCapText({ turnLimit: ceiling }, brief(["ending_direction", "core_hook"]), false, true);
    expect(text).toContain(`안전 상한(${ceiling}턴)`);
    expect(text).toContain("필수 항목 2개");
    expect(text).toContain("진행 방식 바꾸기");
    expect(text).toContain(`[${CONTROL.extendTurns.label}]`);
    expect(turnCapText({ turnLimit: ceiling }, brief(), true, false)).toContain("[승인 요청]");
    expect(turnCapText({ turnLimit: ceiling }, brief(["core_hook"]), false, false)).toContain("더 올릴 수 없습니다");
    // past the [전부 맡기기] grace turn the notice points only to the form
    const noDelegate = turnCapText({ turnLimit: ceiling }, brief(["core_hook"]), false, false, false);
    expect(noDelegate).not.toContain("[전부 맡기기]");
    expect(noDelegate).toContain("[폼으로 마저 입력]");
  });
});
