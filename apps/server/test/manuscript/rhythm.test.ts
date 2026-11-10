/**
 * 설계 추가 0024 — 문장 리듬: runs of short declaratives ("~였다. ~다.") read stiff. A pure metric (dialogue kept out
 * of the narration stats) flags paragraphs under the novel's 문장 리듬 setting (간결 / 보통 / 유려); polishing points the
 * flagged paragraphs out and one targeted rhythm pass rewrites only them (±5% length, facts and dialogue kept, human
 * text never sent); [문체 다듬기] makes a candidate version of an awaiting / approved episode the author keeps (E16)
 * or discards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyBlocks, hasSeparatorLine, measureRhythm, rhythmBlocks, rhythmParagraphs, splitSentences, withinLengthBound } from "../../src/modules/manuscript/domain/rhythm.js";
import { createTestCore, type TestCore } from "../support/test-core.js";
import type { ClaudeRequest } from "../support/scripted-claude.js";
import { padScene, scriptPipeline } from "../support/pipeline-script.js";
import { approveStructure, bibleApproved, decideApproval, drain, planningNovel, type Scope } from "../structure/harness.js";

const POLISH_SYS = "문장 교정자(line_editor)입니다. 주어진 씬의 문장만";
const DRAFT_SYS = "아웃라인의 씬을 순서대로 본문으로 씁니다";

const run = (n: number, len: "short" | "long" = "short") =>
  Array.from({ length: n }, (_, i) => (len === "short" ? `그는 ${i + 1}번 문을 열었다.` : `그는 오래전 이 복도를 지나며 들었던 발소리를 ${i + 1}번이나 떠올렸다.`)).join(" ");

describe("rhythm metric (pure)", () => {
  it("splits sentences: inline quotes never split, a quoted sentence is dialogue, ellipsis / closing marks end a sentence", () => {
    const s = splitSentences('그는 문을 열었다. "가자. 늦었어." 그가 말했다. 그녀는 웃었다… 그리고 돌아섰다.');
    expect(s.map((x) => x.text)).toEqual(["그는 문을 열었다.", '"가자. 늦었어." 그가 말했다.', "그녀는 웃었다…", "그리고 돌아섰다."]);
    expect(s.map((x) => x.dialogue)).toEqual([false, true, false, false]);
    expect(s.map((x) => x.declarative)).toEqual([true, true, false, true]);
    // a paragraph that opens with a quote is a dialogue line
    expect(splitSentences("“정말? 거짓말이지.”").every((x) => x.dialogue)).toBe(true);
    // 3.5 / no space after a terminator does not split
    expect(splitSentences("값은 3.5배였다.그리고 끝났다.")).toHaveLength(1);
  });

  it("dialogue lines are excluded from the narration stats and break a run of short declaratives", () => {
    const text = ["그는 문을 열었다. 복도는 어두웠다.", '"누구야?"', "바람이 차가웠다. 그는 숨을 삼켰다."].join("\n\n");
    const m = measureRhythm(text, "normal");
    expect(m).toMatchObject({ narrationSentences: 4, dialogueSentences: 1, longestShortRun: 2, flaggedParagraphs: [] });
    expect(m.shortRatio).toBe(1);
    // without the dialogue line the four short declaratives are one run
    expect(measureRhythm(text.replace('"누구야?"', ""), "normal")).toMatchObject({ longestShortRun: 4, flaggedParagraphs: [0, 1] });
  });

  it("thresholds per setting: 유려 flags 3 in a row, 보통 4, 간결 7; long sentences never", () => {
    const flagged = (n: number, s: "concise" | "normal" | "flowing") => measureRhythm(run(n), s).flaggedParagraphs.length > 0;
    expect([flagged(3, "flowing"), flagged(3, "normal"), flagged(3, "concise")]).toEqual([true, false, false]);
    expect([flagged(4, "normal"), flagged(4, "concise")]).toEqual([true, false]);
    expect([flagged(6, "concise"), flagged(7, "concise")]).toEqual([false, true]);
    // long sentences with varied endings are never flagged; the same ending over and over is (ending run)
    const varied = ["그는 오래전 이 복도를 지나며 들었던 발소리를 하나하나 떠올렸다.", "창문 너머로 스며든 새벽빛이 낡은 마룻바닥 위에 길게 번져 있었다.", "그때 놓친 것이 무엇이었는지 이번에는 반드시 알아내야만 한다.", "멀리서 종소리가 울릴 때마다 그의 손등에 새겨진 흉터가 욱신거렸다."];
    expect(measureRhythm([...varied, ...varied].join(" "), "flowing").flaggedParagraphs).toEqual([]);
    expect(measureRhythm(run(5, "long"), "flowing")).toMatchObject({ longestEndingRun: 5, flaggedParagraphs: [0] });
    expect(measureRhythm(run(5, "long"), "normal").flaggedParagraphs).toEqual([]);
    const m = measureRhythm(`${run(4)}\n\n${run(2, "long")}`, "normal");
    expect(m).toMatchObject({ setting: "normal", narrationSentences: 6, longestShortRun: 4, flaggedParagraphs: [0] });
    expect(m.shortRatio).toBeCloseTo(4 / 6, 2);
    // a run of one-sentence lines (web-novel layout) is a run across paragraphs
    const lines = ["그는 문을 열었다.", "복도는 어두웠다.", "바람이 차가웠다.", "그는 숨을 삼켰다."].join("\n\n");
    expect(measureRhythm(lines, "normal").flaggedParagraphs).toEqual([0, 1, 2, 3]);
  });

  it("blocks group consecutive flagged paragraphs and never include human-written ones; length bound ±5%", () => {
    const text = ["그는 문을 열었다.", "복도는 어두웠다.", "바람이 차가웠다.", "그는 숨을 삼켰다.", "* * *", "그녀가 왔다."].join("\n\n");
    const ps = rhythmParagraphs(text);
    expect(ps.map((p) => p.text)).toEqual(["그는 문을 열었다.", "복도는 어두웠다.", "바람이 차가웠다.", "그는 숨을 삼켰다.", "그녀가 왔다."]);
    expect(rhythmBlocks(text, [0, 1, 2, 3]).map((b) => b.paragraphs)).toEqual([[0, 1, 2, 3]]);
    // paragraph 1 is the author's text: the block splits around it
    const human = [{ start: ps[1]!.start, end: ps[1]!.end }];
    const blocks = rhythmBlocks(text, [0, 1, 2, 3], human);
    expect(blocks.map((b) => b.paragraphs)).toEqual([[0], [2, 3]]);
    const out = applyBlocks(text, [{ start: blocks[1]!.start, end: blocks[1]!.end, text: "바람이 차가워 그는 숨을 삼켰다." }]);
    expect(out.startsWith("그는 문을 열었다.\n\n복도는 어두웠다.\n\n바람이 차가워")).toBe(true);
    expect(withinLengthBound("가".repeat(200), "가".repeat(210))).toBe(true);
    expect(withinLengthBound("가".repeat(200), "가".repeat(211))).toBe(false);
    expect(withinLengthBound("가".repeat(40), "가".repeat(46))).toBe(true); // min slack on short blocks
  });
});

describe("rhythm metric edge cases", () => {
  it("an ellipsis inside a sentence does not split it; after a final ending or at the end it does", () => {
    expect(splitSentences("그는... 아무 말도 하지 않았다.").map((x) => x.text)).toEqual(["그는... 아무 말도 하지 않았다."]);
    expect(splitSentences("그는… 아무 말도 하지 않았다.").map((x) => x.text)).toEqual(["그는… 아무 말도 하지 않았다."]);
    expect(splitSentences("그랬다... 그리고 돌아섰다.").map((x) => x.text)).toEqual(["그랬다...", "그리고 돌아섰다."]);
    expect(splitSentences("정말 그런가요… 그는 고개를 저었다.").map((x) => x.text)).toEqual(["정말 그런가요…", "그는 고개를 저었다."]);
    expect(splitSentences("그는 문을 열었다. 그리고...").map((x) => x.text)).toEqual(["그는 문을 열었다.", "그리고..."]);
    // a lone period still ends a sentence after any syllable
    expect(splitSentences("문이 열렸다. 그. 그는 웃었다.")).toHaveLength(3);
  });

  it("a scene break closes runs and blocks: no block spans two scenes", () => {
    for (const sep of ["---", "===", "◇", "* * *"]) {
      const text = ["그는 문을 열었다.", "복도는 어두웠다.", sep, "바람이 차가웠다.", "그는 숨을 삼켰다."].join("\n\n");
      const ps = rhythmParagraphs(text);
      expect(ps.map((p) => p.sceneBreakBefore)).toEqual([false, false, true, false]);
      // 2 + 2 short declaratives, not one run of 4
      expect(measureRhythm(text, "normal")).toMatchObject({ longestShortRun: 2, flaggedParagraphs: [] });
      const blocks = rhythmBlocks(text, [0, 1, 2, 3]);
      expect(blocks.map((b) => b.paragraphs)).toEqual([[0, 1], [2, 3]]);
      expect(blocks.every((b) => !hasSeparatorLine(b.text))).toBe(true);
    }
    expect(hasSeparatorLine("바람이 불었다.\n---\n그는 웃었다.")).toBe(true);
    expect(hasSeparatorLine("그는 웃었다 --- 아니, 울었다.")).toBe(false);
  });

  it("the length bound ignores the line breaks a merge removes", () => {
    const lines = ["그는 문을 열었다.", "복도는 어두웠다.", "바람이 차가웠다.", "그는 숨을 삼켰다."].join("\n\n");
    const merged = "그가 문을 열자 복도는 어두웠고, 바람이 차가워 그는 숨을 삼켰다.";
    expect(withinLengthBound(lines, merged)).toBe(true);
    expect(withinLengthBound(lines, `${merged} 그리고 아주 오랫동안 그 자리에 서 있었다.`)).toBe(false);
  });
});

// ── pipeline ──
const H1 = "한결은 새벽 안개가 스며드는 여관 방에서 눈을 떴다. 창밖으로 들리는 종소리는 십 년 전 그날과 똑같았다.";
const H2 = "거울 앞에 선 한결은 손등에 새겨진 흉터를 내려다보았다. 흉터는 희미하게 빛나다가 이내 사그라들었다.";
const CHOPPY_A = "그는 문을 열었다. 복도는 어두웠다. 바람이 차가웠다. 그는 숨을 삼켰다.";
const GOOD_A = "그가 문을 열자 어두운 복도에서 차가운 바람이 밀려왔고, 그는 숨을 삼켰다.";
const LONG_P = "그는 오래전 이 복도를 지나며 들었던 발소리와 웃음소리를 하나하나 떠올리면서, 그때 놓친 것이 무엇이었는지 끝내 알아내야 한다고 생각했다.";
const CHOPPY_B = "칼날이 번뜩였다. 피가 튀었다. 그는 물러섰다. 상대가 웃었다.";
const GOOD_B = "칼날이 번뜩이며 피가 튀자 그는 물러섰고, 상대는 웃었다.";
const BAD_B = "칼날이 달빛 아래에서 번뜩이는 순간 붉은 피가 사방으로 튀었고, 그는 두어 걸음 물러서며 숨을 골랐지만 상대는 그 모습을 보고 비웃듯 웃었다.";
const SCENE_1 = padScene(`${H1}\n\n${CHOPPY_A}\n\n${LONG_P}\n\n${CHOPPY_B}`, 2700);
const DRAFT = `${SCENE_1}\n\n* * *\n\n${padScene(H2, 2700)}`;

/** the scene text of a per-scene rewrite request (last line of the prompt is the JSON payload) */
const sceneOf = (r: ClaudeRequest) => (JSON.parse(r.prompt.slice(r.prompt.lastIndexOf("\n{") + 1)) as { text: string }).text.trim().replace(/\n[ \t]*\*[ \t]*\*[ \t]*\*[ \t]*$/u, "").trim();
const blocksOf = (r: ClaudeRequest) => (JSON.parse(r.prompt.slice(r.prompt.lastIndexOf("\n{") + 1)) as { blocks: Array<{ block: number; text: string }> }).blocks;
const rewrite = (r: ClaudeRequest, map: Record<string, string>) => ({ rewrites: blocksOf(r).flatMap((b) => (map[b.text] ? [{ block: b.block, text: map[b.text]! }] : [])) });
const isRhythm = (r: ClaudeRequest) => Object.keys((r.schema?.properties ?? {}) as object).includes("rewrites");

async function toFirstApproval(t: TestCore, title: string): Promise<Scope> {
  const { scope } = await planningNovel(t, { title });
  await bibleApproved(t, scope);
  await approveStructure(t, scope);
  await drain(t, scope, async () => (await t.modules.novel.service.listArcs(scope)).some((a) => a.status === "plan_awaiting_approval"));
  expect((await decideApproval(t, scope, "arc_plan", "approved")).status).toBeLessThan(300);
  await drain(t, scope, async () => (await t.modules.manuscript.service.getEpisodeByNo(scope, 1)).status === "awaiting_approval", 150);
  return scope;
}

describe("rhythm pass in the pipeline + [문체 다듬기]", () => {
  let t: TestCore;
  let scope: Scope;
  beforeAll(async () => {
    t = await createTestCore();
    t.claude.reply(
      { times: Infinity, when: { text: true, system: DRAFT_SYS }, text: DRAFT },
      // polishing keeps the text as it is (the rhythm pass is what fixes it)
      { times: Infinity, when: { text: true, system: POLISH_SYS }, text: (r) => sceneOf(r) },
      // pipeline pass: A is fixed, B's rewrite is far too long (kept); the manual pass then fixes B
      { times: 1, when: { schemaHas: ["rewrites"] }, json: (r: ClaudeRequest) => rewrite(r, { [CHOPPY_A]: GOOD_A, [CHOPPY_B]: BAD_B }) },
      { times: Infinity, when: { schemaHas: ["rewrites"] }, json: (r: ClaudeRequest) => rewrite(r, { [CHOPPY_B]: GOOD_B }) },
    );
    scriptPipeline(t.claude);
    scope = await toFirstApproval(t, "리듬 작품");
  });
  afterAll(() => t.close());

  it("the draft's metric is stored on the version; polishing is told which paragraphs are flagged", async () => {
    const ep = await t.modules.manuscript.service.getEpisodeByNo(scope, 1);
    const versions = await t.modules.manuscript.service.listVersions(scope, ep.id);
    const draft = versions.find((v) => v.kind === "draft")!;
    expect(draft.rhythm).toMatchObject({ setting: "normal", flaggedParagraphs: [1, 3], longestShortRun: 4 });
    const polish = t.claude.requests.find((r) => r.system.includes(POLISH_SYS) && r.prompt.includes('"sceneOrd":1'))!;
    expect(polish.system).toContain("연결어미");
    expect(polish.prompt).toContain("문장 리듬: 이 씬의 2·4번째 문단은 짧은 평서문이 이어집니다");
    const draftReq = t.claude.requests.find((r) => r.system.includes(DRAFT_SYS))!;
    expect(draftReq.system).toContain("짧은 평서문을 연달아 끊어 쓰지 않습니다");
    expect(draftReq.system).toContain("문장 리듬은 '보통'");
  });

  it("one targeted pass rewrites only the flagged paragraphs; an out-of-bound rewrite keeps the original", async () => {
    const calls = t.claude.requests.filter(isRhythm);
    expect(calls).toHaveLength(1);
    expect(blocksOf(calls[0]!).map((b) => b.text)).toEqual([CHOPPY_A, CHOPPY_B]);
    const ep = await t.modules.manuscript.service.getEpisodeByNo(scope, 1);
    expect(ep.status).toBe("awaiting_approval");
    const current = await t.modules.manuscript.service.getVersion(scope, ep.currentVersionId!);
    expect(current.agentRole).toBe("line_editor");
    expect(current.content).toContain(GOOD_A);
    expect(current.content).not.toContain(CHOPPY_A);
    expect(current.content).toContain(CHOPPY_B); // BAD_B was over the ±5% bound
    expect(current.content).not.toContain(BAD_B);
    expect(current.rhythm).toMatchObject({ pass: { mode: "pipeline", rewrittenBlocks: 1, keptBlocks: 1, before: { flaggedParagraphs: 2, longestShortRun: 4 } }, flaggedParagraphs: [3] });
    // nothing else moved: the text outside the blocks is the polished base, the length is within ±5%
    const base = await t.modules.manuscript.service.getVersion(scope, (current.rhythm as { pass: { baseVersionId: string } }).pass.baseVersionId);
    expect(current.content).toBe(base.content.replace(CHOPPY_A, GOOD_A));
    expect(Math.abs(current.charCountWithSpaces - base.charCountWithSpaces)).toBeLessThanOrEqual(base.charCountWithSpaces * 0.05);
    // the episode screen shows the metric next to the length
    const detail = await t.http("GET", `/api/novels/${scope.novelId}/episodes/1`);
    expect(detail.body.rhythm).toMatchObject({ setting: "normal", longestShortRun: 4, flaggedParagraphs: [3] });
  });

  it("[문체 다듬기] creates a candidate version next to the current one; keep follows the human-edit rules (E16)", async () => {
    const before = await t.modules.manuscript.service.getEpisodeByNo(scope, 1);
    const r = await t.http("POST", `/api/novels/${scope.novelId}/episodes/1/rhythm-polish`);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    await drain(t, scope, async () => !!(await t.modules.manuscript.service.getEpisodeByNo(scope, 1)).rhythmCandidateVersionId);
    const ep = await t.modules.manuscript.service.getEpisodeByNo(scope, 1);
    expect(ep.status).toBe("awaiting_approval");
    expect(ep.currentVersionId).toBe(before.currentVersionId); // the working copy is untouched
    const pending = await t.http("GET", `/api/novels/${scope.novelId}/approvals?status=pending&type=episode`);
    expect(pending.body.items).toHaveLength(1); // approval rules unchanged
    const cand = await t.modules.manuscript.service.getVersion(scope, ep.rhythmCandidateVersionId!);
    expect(cand.parentVersionId).toBe(before.currentVersionId);
    expect(cand.content).toContain(GOOD_B);
    expect(cand.rhythm).toMatchObject({ pass: { mode: "manual", rewrittenBlocks: 1 }, flaggedParagraphs: [] });
    const manual = t.claude.requests.filter(isRhythm)[1]!;
    expect(blocksOf(manual).map((b) => b.text)).toEqual([CHOPPY_B]);
    // a stale id is refused
    const stale = await t.http("POST", `/api/novels/${scope.novelId}/episodes/1/rhythm-polish/decision`, { versionId: before.currentVersionId, decision: "keep" });
    expect(stale.status).toBe(409);
    const kept = await t.http("POST", `/api/novels/${scope.novelId}/episodes/1/rhythm-polish/decision`, { versionId: cand.id, decision: "keep" });
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    const after = await t.modules.manuscript.service.getEpisodeByNo(scope, 1);
    expect(after.status).toBe("checking");
    expect(after.rhythmCandidateVersionId).toBeNull();
    const v = await t.modules.manuscript.service.getVersion(scope, after.currentVersionId!);
    expect(v.isHumanEdit).toBe(true);
    expect(v.content).toBe(cand.content);
    const audit = await t.modules.audit.service.list(scope, { targetIds: [cand.id], limit: 10 });
    expect(audit.items.map((x) => x.action)).toEqual(expect.arrayContaining(["manuscript.rhythm_candidate_created", "manuscript.rhythm_candidate_decided"]));
  });

  it("nothing flagged → 422 rhythm_ok; the setting is a novel field (invalid values refused)", async () => {
    await drain(t, scope, async () => (await t.modules.manuscript.service.getEpisodeByNo(scope, 1)).status === "awaiting_approval", 150);
    const r = await t.http("POST", `/api/novels/${scope.novelId}/episodes/1/rhythm-polish`);
    expect(r.status).toBe(422);
    expect(r.body.error?.code ?? r.body.code).toBe("rhythm_ok");
    const patch = await t.http("PATCH", `/api/novels/${scope.novelId}`, { proseRhythm: "flowing" });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    expect(patch.body.proseRhythm).toBe("flowing");
    const detail = await t.http("GET", `/api/novels/${scope.novelId}/episodes/1`);
    expect(detail.body.rhythm.setting).toBe("flowing");
    const bad = await t.http("PATCH", `/api/novels/${scope.novelId}`, { proseRhythm: "choppy" });
    expect(bad.status).toBe(400);
  });
});

describe("human-written text is never sent to the rhythm pass", () => {
  let t: TestCore;
  beforeAll(async () => {
    t = await createTestCore();
    t.claude.reply(
      { times: Infinity, when: { text: true, system: DRAFT_SYS }, text: `${padScene(H1, 2550)}\n\n* * *\n\n${padScene(H2, 2550)}` },
      { times: Infinity, when: { text: true, system: POLISH_SYS }, text: (r) => sceneOf(r) },
    );
    scriptPipeline(t.claude);
  });
  afterAll(() => t.close());

  it("a choppy paragraph the author wrote stays as written; [문체 다듬기] has nothing to do", async () => {
    const scope = await toFirstApproval(t, "사람 문단 작품");
    expect(t.claude.requests.filter(isRhythm)).toHaveLength(0); // the scripted text is not flagged
    const ep = await t.modules.manuscript.service.getEpisodeByNo(scope, 1);
    const cur = await t.modules.manuscript.service.getVersion(scope, ep.currentVersionId!);
    // the author's paragraphs: a long one, the choppy one, a long one (the agent text around them is not flagged)
    const edited = cur.content.replace(H2, `${H2}\n\n${LONG_P}\n\n${CHOPPY_B}\n\n${LONG_P}`);
    const save = await t.http("POST", `/api/novels/${scope.novelId}/episodes/1/versions`, { content: edited, baseVersionId: cur.id });
    expect(save.status, JSON.stringify(save.body)).toBe(201);
    expect(save.body.rhythm.flaggedParagraphs.length).toBeGreaterThan(0);
    await drain(t, scope, async () => (await t.modules.manuscript.service.getEpisodeByNo(scope, 1)).status === "awaiting_approval", 150);
    expect(t.claude.requests.filter(isRhythm)).toHaveLength(0);
    const after = await t.modules.manuscript.service.getEpisodeByNo(scope, 1);
    expect((await t.modules.manuscript.service.getVersion(scope, after.currentVersionId!)).content).toContain(CHOPPY_B);
    const r = await t.http("POST", `/api/novels/${scope.novelId}/episodes/1/rhythm-polish`);
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).toContain("사람이 쓴 구간");
  });

  it("[문체 다듬기] is refused outside awaiting_approval / approved", async () => {
    const { scope } = await planningNovel(t, { title: "초기 작품" });
    const r = await t.http("POST", `/api/novels/${scope.novelId}/episodes/1/rhythm-polish`);
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
});

describe("a failing rhythm call never stalls the episode; a manual pass without a usable rewrite says so", () => {
  let t: TestCore;
  beforeAll(async () => {
    t = await createTestCore();
    t.claude.reply(
      { times: Infinity, when: { text: true, system: DRAFT_SYS }, text: DRAFT },
      { times: Infinity, when: { text: true, system: POLISH_SYS }, text: (r) => sceneOf(r) },
      // pipeline pass: the provider refuses the request
      { times: 1, when: { schemaHas: ["rewrites"] }, error: { status: 400 } },
      // manual pass: nothing usable comes back
      { times: Infinity, when: { schemaHas: ["rewrites"] }, json: () => ({ rewrites: [] }) },
    );
    scriptPipeline(t.claude);
  });
  afterAll(() => t.close());

  it("pipeline: the polished version goes on to approval; manual: no candidate, task done, audit rhythm_no_change", async () => {
    const scope = await toFirstApproval(t, "리듬 실패 작품");
    expect(t.claude.requests.filter(isRhythm)).toHaveLength(1);
    const ep = await t.modules.manuscript.service.getEpisodeByNo(scope, 1);
    expect(ep.status).toBe("awaiting_approval");
    const cur = await t.modules.manuscript.service.getVersion(scope, ep.currentVersionId!);
    expect(cur.content).toContain(CHOPPY_A); // kept as polished

    const r = await t.http("POST", `/api/novels/${scope.novelId}/episodes/1/rhythm-polish`);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const taskId = r.body.taskId as string;
    await drain(t, scope, async () => (await t.http("GET", `/api/novels/${scope.novelId}/tasks/${taskId}`)).body.status === "done");
    const after = await t.modules.manuscript.service.getEpisodeByNo(scope, 1);
    expect(after.rhythmCandidateVersionId).toBeNull();
    expect(after.currentVersionId).toBe(ep.currentVersionId);
    const audit = await t.modules.audit.service.list(scope, { targetIds: [ep.id], limit: 50 });
    expect(audit.items.map((x) => x.action)).toContain("manuscript.rhythm_no_change");
  });
});
