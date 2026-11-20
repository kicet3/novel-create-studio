/**
 * 설계 추가 0026 — the sentences of an answer interpretation never keep an entity handle ("E7"): what the repair round
 * left is dropped before the interpretation row / confirmation question is written. Tokens the person typed in the
 * answer may be quoted (P4).
 */
import { describe, expect, it } from "vitest";
import { humanHandleTokens } from "../../src/modules/agents/index.js";
import { scrubInterpretation } from "../../src/modules/hitl/application/tasks.js";
import { interpretAnswerOutputSchema, interpretationConfirmBody } from "../../src/modules/hitl/domain/questions.js";

describe("interpret_answer: handle symbols (설계 추가 0026)", () => {
  const out = interpretAnswerOutputSchema.parse({
    status: "proposed",
    summary_ko: "E7의 스승을 바꿉니다.",
    changes: [
      { kind: "fact", description_ko: "E7의 스승은 백무겸이다.", subject_entity_id: "E7", entity_ids: ["E7"] },
      { kind: "constraint", description_ko: "서이온은 3화까지 검을 쓰지 않는다.", entity_ids: ["ent_1"] },
    ],
    followup_question_ko: "E12도 같은 스승입니까?",
  });

  it("a clean interpretation is returned as it is; id reference fields are not sentences", () => {
    const clean = interpretAnswerOutputSchema.parse({ status: "proposed", summary_ko: "스승을 바꿉니다.", changes: [{ kind: "fact", description_ko: "서이온의 스승은 백무겸이다.", subject_entity_id: "E7", entity_ids: ["E7"], predicate: "E7" }] });
    expect(scrubInterpretation(clean, new Set())).toBe(clean);
  });

  it("leaking changes are dropped, a leaking follow-up is removed, a leaking summary becomes a neutral line", () => {
    const r = scrubInterpretation(out, new Set());
    expect(r.changes.map((c) => c.description_ko)).toEqual(["서이온은 3화까지 검을 쓰지 않는다."]);
    expect(r.followup_question_ko).toBeUndefined();
    expect(r.summary_ko).not.toMatch(/E\d/);
    expect(interpretationConfirmBody(r)).not.toMatch(/E\d/);
  });

  it("P4: a symbol the person typed in the answer may be quoted; a story token too", () => {
    const allow = new Set([...humanHandleTokens("E7의 스승을 백무겸으로 바꿔 주세요."), "E12"]);
    expect(scrubInterpretation(out, allow)).toBe(out);
    // only what was typed: E12 is still a leak without the story token
    const r = scrubInterpretation(out, humanHandleTokens("E7의 스승을 백무겸으로 바꿔 주세요."));
    expect(r.summary_ko).toBe("E7의 스승을 바꿉니다.");
    expect(r.changes).toHaveLength(2);
    expect(r.followup_question_ko).toBeUndefined();
  });
});
