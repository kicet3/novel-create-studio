/** 설계 추가 0026 (P4): handle symbols (E7 …) in a revision-chat turn — pure checks of the structured output. */
import { describe, expect, it } from "vitest";
import { handleLeakIssue, humanHandleTokens, storyHandleTokens } from "../../src/modules/agents/index.js";
import { applyPatches, locatePatches } from "../../src/modules/revision/domain/patch.js";
import { checkTurnHandles, dropLeakingSourceQuotes, revisionTurnOutputSchema, TURN_HANDLE_RULE } from "../../src/modules/revision/domain/turn.js";

const NONE = new Set<string>();
const turn = (over: Record<string, unknown>) => revisionTurnOutputSchema.parse({ reply_text: "고쳤습니다.", diagnosis_kind: "style", ...over });
const patch = (quote: string, replacement: string, reason = "") => ({ kind: "text_patch", patches: [{ quote, replacement, reason }] });

describe("revision chat turn: handle symbols", () => {
  it("a clean turn has no issues", () => {
    const r = checkTurnHandles(turn({ question: { text: "그대로 둘까요?", options: ["둔다", "고친다"] }, proposals: [patch("서이온은 웃었다.", "서이온은 웃지 않았다.")] }), NONE, NONE);
    expect(r).toMatchObject({ issues: [], blocking: false });
    expect(r.patches.size + r.proposals.size).toBe(0);
  });

  it("the reply body may quote a symbol the author typed; nothing else may", () => {
    const human = humanHandleTokens("E7이 누구야?", "그럼 고쳐 줘");
    expect([...human]).toEqual(["E7"]);
    const out = turn({
      reply_text: "E7은 서이온을 가리킵니다.",
      question: { text: "E7을 서이온으로 바꿀까요?", options: ["E7 그대로", "서이온으로"] },
      proposals: [patch("서이온은 웃었다.", "E7은 웃었다.", "E7로 통일")],
    });
    const r = checkTurnHandles(out, NONE, human);
    expect(r.blocking).toBe(true); // the question is not the reply body
    expect(r.issues.map((i) => i.item)).toEqual(["답변 question.text", "답변 question.options[0]", "proposals[0].patches[0] replacement", "proposals[0].patches[0] reason"]);
    expect(r.issues[0]!.problem).toBe(handleLeakIssue(["E7"]));
    expect([...r.patches.get(0)!]).toEqual([0]);
    // a symbol the author did not type is not allowed in the reply either (being in the run's input is no exemption)
    const other = checkTurnHandles(turn({ reply_text: "E12는 차경혁입니다." }), NONE, human);
    expect(other).toMatchObject({ blocking: true });
    expect(other.issues.map((i) => i.item)).toEqual(["답변 reply_text"]);
    expect(checkTurnHandles(turn({ reply_text: "E7은 서이온을 가리킵니다." }), NONE, human)).toMatchObject({ issues: [], blocking: false });
  });

  it("a patch quote stays byte-for-byte the base text (symbols included); only the replacement must be clean", () => {
    const base = "그때 E7은 검을 들었다. E12가 물러섰다.";
    const out = turn({
      proposals: [
        { kind: "text_patch", patches: [{ quote: "그때 E7은 검을 들었다.", replacement: "그때 서이온은 검을 들었다.", reason: "기호를 이름으로" }, { quote: "E12가 물러섰다.", replacement: "E11이 물러섰다.", reason: "" }] },
      ],
    });
    const r = checkTurnHandles(out, NONE, NONE);
    expect(r.blocking).toBe(false);
    expect(r.issues.map((i) => i.item)).toEqual(["proposals[0].patches[1] replacement"]);
    expect([...r.patches.get(0)!]).toEqual([1]);
    expect(out.proposals[0]!.patches[0]!.quote).toBe("그때 E7은 검을 들었다."); // untouched
    const kept = out.proposals[0]!.patches.filter((_x, i) => !r.patches.get(0)!.has(i));
    const located = locatePatches(base, kept, { maxRatio: 1 });
    expect(located.issues).toEqual([]);
    expect(applyPatches(base, located.located)).toBe("그때 서이온은 검을 들었다. E12가 물러섰다.");
  });

  it("story tokens (a real name like 'E3 구역') are allowed everywhere; a name that is itself a symbol exempts nothing", () => {
    const story = storyHandleTokens(["E3 구역", "E7"]);
    const out = turn({ reply_text: "E3 구역 묘사를 고쳤습니다.", proposals: [patch("구역은 조용했다.", "E3 구역은 조용했다."), patch("그는 웃었다.", "E7은 웃었다.")] });
    const r = checkTurnHandles(out, story, NONE);
    expect(r.blocking).toBe(false);
    expect([...r.patches.keys()]).toEqual([1]);
  });

  it("setting_change: new_value / reason with a symbol drop the proposal; fact ids are not scanned", () => {
    const out = turn({
      proposals: [
        { kind: "setting_change", fact_id: "fct_01E7", new_value: "E7의 스승", reason: "작가 요청" },
        { kind: "setting_change", fact_id: "fct_02", new_value: "서이온의 스승", reason: "작가 요청" },
        { kind: "impact_note", fact_id: "fct_02", reason: "E7 관련" },
      ],
    });
    const r = checkTurnHandles(out, NONE, NONE);
    expect([...r.proposals]).toEqual([0]);
    expect(r.issues.map((i) => i.item)).toEqual(["proposals[0] new_value"]);
  });

  it("a source quote that carries a symbol is not stored; the source stays", () => {
    const out = turn({ sources: [{ kind: "plan", ref_id: null, quote: "E7이 E12를 막는다" }, { kind: "outline", ref_id: null, quote: "서이온이 눈을 뜬다" }, { kind: "none" }] });
    expect(dropLeakingSourceQuotes(out, new Set(["E7"])).sources).toEqual([
      { kind: "plan", ref_id: null, quote: null },
      { kind: "outline", ref_id: null, quote: "서이온이 눈을 뜬다" },
      { kind: "none", ref_id: null, quote: null },
    ]);
    expect(dropLeakingSourceQuotes(out, new Set(["E7", "E12"]))).toBe(out);
  });

  it("the turn prompt carries the rule (P7)", () => {
    expect(TURN_HANDLE_RULE).toContain("E와 숫자로 된 기호는 이름이 아닙니다");
  });
});
