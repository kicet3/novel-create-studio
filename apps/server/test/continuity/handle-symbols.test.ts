/**
 * 설계 추가 0026: entity handles (E1, E2 …) never stay in stored text — continuity slice.
 *  - CR-17 (deterministic): a handle symbol in the manuscript under check is a high issue (the gate blocks);
 *  - P4: the review's own sentences (message / proposed_fix) never carry a handle symbol (repair → drop / fail).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleLeakIssue, storyHandleTokens } from "../../src/modules/agents/index.js";
import { CHECK_INSTRUCTION } from "../../src/modules/continuity/application/check-continuity.js";
import { continuityReviewSchema, dropHandleLeaks, findHandleSymbols, findHandleSymbolsByScene, NEUTRAL_ISSUE_MESSAGE, reviewHandleLeaks, RULES } from "../../src/modules/continuity/domain/rules.js";
import { createHarness, type Harness } from "../foreshadow/harness.js";

const NONE = new Set<string>();

describe("handle symbols: pure rules (설계 추가 0026)", () => {
  it("CR-17 finds non-exempt handle tokens with the first position; real names are the only exemption", () => {
    expect(RULES["CR-17"]).toMatchObject({ kind: "glossary_spelling", severity: "high", llm: false });
    expect(findHandleSymbols("서이온은 검을 들었다. SE6 모델과 E6A는 기호가 아니다.", NONE)).toBeNull();
    const f = findHandleSymbols("그때 E12가 웃었다. E7은 검을 들었고 E12는 물러섰다.", NONE)!;
    expect(f.tokens).toEqual(["E12", "E7"]);
    expect([f.charStart, f.charEnd]).toEqual([3, 6]);
    expect(f.message).toBe("본문에 이름 대신 기호(E12, E7)가 쓰였습니다. 기호를 인물·장소의 실제 이름으로 바꿔야 합니다.");
    // a place really called "E3 구역" keeps its token; an entity literally named "E7" exempts nothing
    const story = storyHandleTokens(["E3 구역", "E7", "서이온"]);
    expect(findHandleSymbols("E3 구역은 조용했다.", story)).toBeNull();
    expect(findHandleSymbols("E3 구역에서 E7이 기다렸다.", story)!.tokens).toEqual(["E7"]);
  });

  it("CR-17 reports every scene that has a symbol, and never text a person typed", () => {
    const content = "E7은 웃었다.\n\n서이온은 걸었다.\n\nE12가 왔다. E7도 왔다.\n\n끝. E5";
    const at = (s: string, from = 0) => content.indexOf(s, from);
    const scenes = [
      { ord: 1, start: 0, end: at("서이온") },
      { ord: 2, start: at("서이온"), end: at("E12") },
      { ord: 3, start: at("E12"), end: at("끝") },
    ];
    const found = findHandleSymbolsByScene(content, NONE, scenes);
    expect(found.map((f) => [f.scene?.ord ?? null, f.tokens, f.charStart])).toEqual([
      [1, ["E7"], 0],
      [3, ["E12", "E7"], at("E12")],
      [null, ["E5"], at("E5")], // text outside every scene is still reported
    ]);
    // no scenes yet → one finding for the whole text
    expect(findHandleSymbolsByScene(content, NONE, []).map((f) => [f.scene, f.tokens])).toEqual([[null, ["E7", "E12", "E5"]]]);
    // the author typed scene 3 ("E12가 왔다. E7도 왔다."): no rewrite touches it, so it is not reported
    const typed = [{ start: scenes[2]!.start, end: scenes[2]!.end }];
    expect(findHandleSymbolsByScene(content, NONE, scenes, typed).map((f) => f.scene?.ord ?? null)).toEqual([1, null]);
    expect(findHandleSymbols("E7 코드를 눌렀다.", NONE, [{ start: 0, end: 5 }])).toBeNull();
    // story tokens stay exempt per scene
    expect(findHandleSymbolsByScene(content, new Set(["E7", "E5"]), scenes).map((f) => [f.scene?.ord, f.tokens])).toEqual([[3, ["E12"]]]);
  });

  it("review sentences are scanned; quotes, fact handles and candidate ids are not", () => {
    const review = continuityReviewSchema.parse({
      verdicts: [{ candidate_id: "C1", verdict: "violation", message: "E7이 죽은 뒤에 등장합니다.", proposed_fix: "서이온으로 고치세요.", quote: "E7은 문을 열었다." }],
      issues: [
        { kind: "plan_deviation", message: "계획과 다릅니다.", proposed_fix: "주인공은 E7로 표기하세요.", quote: "E12가 웃었다.", evidence: ["PLAN"] },
        { kind: "plan_deviation", message: "E12의 등장이 계획에 없습니다.", evidence: ["PLAN"] },
      ],
    });
    expect(reviewHandleLeaks(review, NONE).map((l) => `${l.path}=${l.token}`)).toEqual(["verdicts[0].message=E7", "issues[0].proposed_fix=E7", "issues[1].message=E12"]);
    const dropped = dropHandleLeaks(review, NONE);
    expect(dropped.lostIssues).toBe(1);
    expect(dropped.review.verdicts[0]).toMatchObject({ candidate_id: "C1", verdict: "violation", proposed_fix: "서이온으로 고치세요.", quote: "E7은 문을 열었다." });
    expect(dropped.review.verdicts[0]!.message).toBeUndefined();
    expect(dropped.review.issues).toHaveLength(1);
    expect(dropped.review.issues[0]).toMatchObject({ message: "계획과 다릅니다.", quote: "E12가 웃었다." });
    expect(dropped.review.issues[0]!.proposed_fix).toBeUndefined();
    expect(reviewHandleLeaks(dropped.review, NONE)).toEqual([]);
    // story tokens stay allowed
    expect(dropHandleLeaks(review, new Set(["E7", "E12"])).lostIssues).toBe(0);
    // with a neutral message the open issue is kept (kind / quote / evidence still point at the problem)
    const kept = dropHandleLeaks(review, NONE, NEUTRAL_ISSUE_MESSAGE);
    expect(kept).toMatchObject({ lostIssues: 0, neutralized: 1 });
    expect(kept.review.issues.map((i) => i.message)).toEqual(["계획과 다릅니다.", NEUTRAL_ISSUE_MESSAGE]);
    expect(reviewHandleLeaks(kept.review, NONE)).toEqual([]);
  });

  it("the review prompt forbids symbols in its own sentences (P7)", () => {
    expect(CHECK_INSTRUCTION).toContain("E와 숫자로 된 기호를 쓰지 마세요");
  });
});

describe("check_continuity: handle symbols (설계 추가 0026)", () => {
  let h: Harness;
  let arcId: string;
  let seq = 0;
  beforeAll(async () => {
    h = await createHarness();
    arcId = await h.createArc(1, 9, "active");
  }, 60_000);
  afterAll(() => h.close());

  const CLEAN = "서이온은 검을 들었다. 차경혁은 물러섰다.";
  const leaking = { verdicts: [], issues: [{ kind: "plan_deviation", message: "주인공은 E7로 표기해야 합니다.", proposed_fix: "E7로 통일하세요.", evidence: ["PLAN"] }] };
  const fixed = { verdicts: [], issues: [{ kind: "plan_deviation", message: "주인공의 행동이 계획과 다릅니다.", proposed_fix: "서이온이 먼저 움직이게 고치세요.", evidence: ["PLAN"] }] };

  async function check(content: string, responder: Parameters<Harness["llm"]>[0], labels?: string[], scenes?: Array<[number, number]>, typedSpans?: Array<[number, number]>) {
    const ep = await h.createEpisode(arcId, ++seq);
    const v = await h.createVersion(ep, content, { ...(scenes ? { scenes } : {}), ...(typedSpans ? { typedSpans } : {}) });
    const handler = h.reg.taskHandlers.get("check_continuity");
    const run = await h.createRun("check_continuity", "continuity_editor", "episode", ep);
    const input = { episode_id: ep, manuscript_version_id: v.versionId };
    const llm = h.llm(responder);
    const context = { ...h.context, handles: { ...h.context.handles, labels } };
    const execute = () => handler.execute(run, input, context, llm);
    const commit = async (proposal: unknown) => h.tx((tx) => handler.commit(tx, run, input, proposal, run.task));
    return { ep, v, llm, execute, commit };
  }

  it("a handle symbol in the manuscript is a high issue that blocks the gate; a rerun re-links it", async () => {
    // a label of the run's pack exempts nothing ("E12 일행" may be a name an agent derived from leaked prose);
    // "E3" is a story token because a person named an entity "E3 구역"
    h.ontology.storyTokens = ["E3"];
    const c = await check("비가 왔다. E7은 검을 들었다. E3 구역은 조용했다.", () => ({ verdicts: [], issues: [] }), ["E7 일행", "서이온"]);
    const proposal = await c.execute().finally(() => (h.ontology.storyTokens = []));
    expect(proposal.drafts).toHaveLength(1);
    expect(proposal.drafts[0]).toMatchObject({ kind: "glossary_spelling", severity: "high", ruleId: "CR-17", charStart: 7, charEnd: 9, fixScope: "span", sceneId: c.v.sceneIds[0] });
    await c.commit(proposal);
    let issues = await h.continuity.listIssues(h.scope, { episodeId: c.ep });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: "glossary_spelling", severity: "high", status: "open" });
    expect(issues[0]!.message).toContain("본문에 이름 대신 기호(E7)가 쓰였습니다");
    const gate = h.reg.contributors.find((x) => x.name === "continuity")!;
    const verdict = await gate.evaluate(h.scope, { id: c.ep, episodeNo: seq } as any, c.v.versionId);
    expect(verdict.pass).toBe(false);
    expect(verdict.blockers).toHaveLength(1);
    h.ontology.storyTokens = ["E3"];
    await c.commit(await c.execute().finally(() => (h.ontology.storyTokens = [])));
    issues = await h.continuity.listIssues(h.scope, { episodeId: c.ep });
    expect(issues).toHaveLength(1);
  });

  it("symbols in several scenes: one blocking issue per scene, so the rewrite is aimed at all of them", async () => {
    const content = "E7은 검을 들었다.\n\n서이온은 물러섰다.\n\nE12가 웃었다.";
    const s2 = content.indexOf("서이온");
    const s3 = content.indexOf("E12");
    const c = await check(content, () => ({ verdicts: [], issues: [] }), undefined, [[0, s2], [s2, s3], [s3, content.length]]);
    const proposal = await c.execute();
    expect(proposal.drafts.map((d: { ruleId: string; sceneId: string; charStart: number }) => [d.ruleId, d.sceneId, d.charStart])).toEqual([
      ["CR-17", c.v.sceneIds[0], 0],
      ["CR-17", c.v.sceneIds[2], s3],
    ]);
    await c.commit(proposal);
    const gate = h.reg.contributors.find((x) => x.name === "continuity")!;
    const verdict = await gate.evaluate(h.scope, { id: c.ep, episodeNo: seq } as any, c.v.versionId);
    expect(verdict.blockers.map((b) => b.sceneId ?? null).sort()).toEqual([c.v.sceneIds[0], c.v.sceneIds[2]].sort());
  });

  it("a symbol the author typed is not a CR-17 issue, and the review may quote it", async () => {
    const content = "문 옆 패드에 E7 코드를 눌렀다.";
    const c = await check(content, () => ({ verdicts: [], issues: [{ kind: "plan_deviation", message: "'E7 코드'는 계획에 없는 장치입니다.", evidence: ["PLAN"] }] }), undefined, undefined, [[0, content.length]]);
    const proposal = await c.execute();
    expect(c.llm.inputs).toHaveLength(1); // no repair round: the quoted symbol is the author's own
    expect(proposal.drafts.map((d: { ruleId: string; message: string }) => [d.ruleId, d.message])).toEqual([["LLM:plan_deviation", "'E7 코드'는 계획에 없는 장치입니다."]]);
  });

  it("clean prose raises nothing", async () => {
    const c = await check(CLEAN, () => ({ verdicts: [], issues: [] }));
    expect((await c.execute()).drafts).toEqual([]);
    expect(c.llm.inputs).toHaveLength(1);
  });

  it("a symbol in the review's sentences is sent back for correction; the corrected review is what is stored", async () => {
    let n = 0;
    const c = await check(CLEAN, () => (n++ === 0 ? leaking : fixed));
    const proposal = await c.execute();
    expect(c.llm.inputs).toHaveLength(2);
    const critique = c.llm.inputs[1]!.messages.at(-1)!.content;
    expect(critique).toContain(handleLeakIssue(["E7"]));
    expect(critique).toContain("issues[0].message");
    expect(c.llm.inputs[1]!.purpose).toBe("check_repair");
    expect(proposal.drafts).toHaveLength(1);
    expect(proposal.drafts[0]).toMatchObject({ kind: "plan_deviation", message: "주인공의 행동이 계획과 다릅니다.", suggestion: "서이온이 먼저 움직이게 고치세요." });
  });

  it("a proposed_fix that still carries a symbol after the repair rounds is dropped, the issue stays", async () => {
    const c = await check(CLEAN, () => ({ verdicts: [], issues: [{ ...fixed.issues[0]!, proposed_fix: "E7로 통일하세요." }] }));
    const proposal = await c.execute();
    expect(c.llm.inputs.length).toBeGreaterThan(1);
    expect(proposal.drafts).toHaveLength(1);
    expect(proposal.drafts[0]).toMatchObject({ kind: "plan_deviation", message: "주인공의 행동이 계획과 다릅니다.", suggestion: null });
  });

  it("an issue message that keeps the symbol is never stored — and the check never fails over it: the issue stays under a neutral message", async () => {
    const c = await check(CLEAN, () => leaking);
    const proposal = await c.execute();
    expect(c.llm.inputs.length).toBeGreaterThan(1); // the producer was asked to repair it first
    expect(proposal.drafts).toHaveLength(1);
    expect(proposal.drafts[0]).toMatchObject({ kind: "plan_deviation", ruleId: "LLM:plan_deviation", message: NEUTRAL_ISSUE_MESSAGE, suggestion: null });
    await c.commit(proposal);
    const issues = await h.continuity.listIssues(h.scope, { episodeId: c.ep });
    expect(issues.map((i) => i.message)).toEqual([NEUTRAL_ISSUE_MESSAGE]);
    expect(JSON.stringify(issues)).not.toMatch(/E7/);
  });

  it("with the symbol in the prose itself CR-17 holds the gate; the leaking review issue is kept under the neutral message", async () => {
    const c = await check("E7은 검을 들었다.", () => leaking);
    const proposal = await c.execute();
    expect(proposal.drafts.map((d: { ruleId: string }) => d.ruleId)).toEqual(["CR-17", "LLM:plan_deviation"]);
    await c.commit(proposal);
    const issues = await h.continuity.listIssues(h.scope, { episodeId: c.ep });
    expect(issues.map((i) => i.kind).sort()).toEqual(["glossary_spelling", "plan_deviation"]);
    expect(issues.find((i) => i.kind === "plan_deviation")!.message).toBe(NEUTRAL_ISSUE_MESSAGE);
  });
});
