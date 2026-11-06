/**
 * extract_facts mention location + agent-to-agent repair dialogue (설계 추가).
 *
 * Reproduces the live failure of task tsk_01M6RMW4P7GR7JQR9SBGJ81N6H ("언급 위치가 원문과 맞지 않는 비율이 높습니다"
 * 4/7, 2/9, 8/12, 3/6): the four stored model answers (mentions only) against sanitized scene texts that keep the
 * real scene lengths, the leading "\n" of scenes 2–5 and every position of the mentioned names (the rest of the
 * prose is replaced by filler).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { arcs, episodes, goals, manuscriptVersions, scenes } from "@ncs/db/schema";
import { newId, repairDialoguesOf } from "@ncs/shared";
import type { NovelScope } from "../../src/platform/index.js";
import { checkExtraction, type CheckScene } from "../../src/modules/linking/domain/extraction-check.js";
import { extractionResultSchema } from "../../src/modules/linking/domain/schemas.js";
import { locateInText } from "../../src/modules/linking/domain/text.js";
import { createTestCore, type TestCore } from "../support/test-core.js";
import type { ClaudeRequest } from "../support/scripted-claude.js";

type MentionRow = [sceneOrd: number, start: number, end: number, surface: string, kind: string, key: string];

const LIVE_SCENES = [
  { ord: 1, len: 873, lead: "", occ: {"서이온": [31,178,377],"차경혁": [80,686,798]} },
  { ord: 2, len: 1037, lead: "\n", occ: {"서이온": [8,578],"차경혁": [717]} },
  { ord: 3, len: 1033, lead: "\n", occ: {"서이온": [44,192,464,718],"시스템": [151]} },
  { ord: 4, len: 1589, lead: "\n", occ: {"서이온": [145,486,902,1024,1256,1528],"헌터 관리 기구": [1381]} },
  { ord: 5, len: 1235, lead: "\n", occ: {"서이온": [53,318,762,998,1029],"헌터 관리 기구": [1],"각성 판정소": [10]} },
];

const LIVE_ATTEMPTS: MentionRow[][] = [
  [
    [1, 31, 34, "서이온", "named", "m_seoion_s1"],
    [1, 80, 83, "차경혁", "named", "m_chakh_s1"],
    [2, 7, 10, "서이온", "named", "m_seoion_s2"],
    [3, 43, 46, "서이온", "named", "m_seoion_s3"],
    [4, 144, 147, "서이온", "named", "m_seoion_s4"],
    [5, 0, 8, "헌터 관리 기구", "named", "m_hunter_org_s5"],
    [5, 52, 55, "서이온", "named", "m_seoion_s5"],
  ],
  [
    [1, 31, 34, "서이온", "named", "m1"],
    [1, 80, 83, "차경혁", "named", "m2"],
    [2, 8, 11, "서이온", "named", "m3"],
    [2, 760, 763, "차경혁", "named", "m4"],
    [3, 95, 98, "시스템", "descriptive", "m5"],
    [3, 60, 63, "서이온", "named", "m6"],
    [4, 1290, 1299, "헌터 관리 기구", "named", "m7"],
    [5, 1, 10, "헌터 관리 기구", "named", "m8"],
    [5, 1205, 1208, "서이온", "named", "m9"],
  ],
  [
    [1, 33, 36, "서이온", "named", "m1"],
    [1, 82, 85, "차경혁", "named", "m2"],
    [1, 905, 908, "차경혁", "named", "m3"],
    [1, 1032, 1035, "차경혁", "named", "m4"],
    [2, 9, 12, "서이온", "named", "m5"],
    [2, 735, 738, "차경혁", "named", "m6"],
    [3, 46, 49, "서이온", "named", "m7"],
    [3, 150, 153, "시스템", "descriptive", "m8"],
    [4, 160, 163, "서이온", "named", "m9"],
    [5, 2, 10, "헌터 관리 기구", "named", "m10"],
    [5, 11, 17, "각성 판정소", "named", "m11"],
    [5, 1150, 1153, "서이온", "named", "m12"],
  ],
  [
    [1, 31, 34, "서이온", "named", "m_seoion_s1"],
    [1, 80, 83, "차경혁", "named", "m_chakh_s1"],
    [2, 7, 10, "서이온", "named", "m_seoion_s2"],
    [3, 43, 46, "서이온", "named", "m_seoion_s3"],
    [4, 143, 146, "서이온", "named", "m_seoion_s4"],
    [5, 0, 8, "헌터 관리 기구", "named", "m_hunter_agency_s5"],
  ],
];

/** the live failure messages, per attempt */
const LIVE_FAILED = [4, 2, 8, 3];

function sceneText(s: (typeof LIVE_SCENES)[number]): string {
  const chars: string[] = Array.from({ length: s.len }, (_, i) => (i % 17 === 16 ? " " : "다"));
  for (let i = 0; i < s.lead.length; i++) chars[i] = s.lead[i]!;
  for (const [surface, at] of Object.entries(s.occ) as Array<[string, number[]]>) {
    for (const p of at) {
      if (p > 0 && chars[p - 1] !== "\n") chars[p - 1] = " ";
      for (let k = 0; k < surface.length; k++) chars[p + k] = surface[k]!;
    }
  }
  return chars.join("");
}
const TEXTS = LIVE_SCENES.map(sceneText);
const OFFSETS = TEXTS.map((_, i) => TEXTS.slice(0, i).reduce((n, x) => n + x.length, 0));
const CHECK_SCENES: CheckScene[] = LIVE_SCENES.map((s, i) => ({ sceneOrd: s.ord, text: TEXTS[i]!, charOffset: OFFSETS[i]! }));

const mention = ([scene_ord, char_start, char_end, surface, mention_kind, local_key]: MentionRow) => ({ local_key, scene_ord, char_start, char_end, surface, mention_kind, entity_type_hint: "character" });
const answer = (rows: MentionRow[]) => ({ mentions: rows.map(mention), facts: [] });
const BOGUS: MentionRow = [2, 300, 303, "백도윤", "named", "m_bogus"];

/** the previous check: exact span, else the surface must occur exactly once in the scene */
function legacyFailures(rows: MentionRow[]): number {
  let failed = 0;
  for (const [ord, s, e, surface] of rows) {
    const text = TEXTS[ord - 1];
    if (!text) {
      failed++;
      continue;
    }
    if (text.slice(s, e) === surface) continue;
    const f = text.indexOf(surface);
    if (f < 0 || text.indexOf(surface, f + 1) >= 0) failed++;
  }
  return failed;
}

describe("mention location (pure)", () => {
  it("the stored live answers fail the old check exactly as in production (4/7, 2/9, 8/12, 3/6)", () => {
    expect(LIVE_ATTEMPTS.map(legacyFailures)).toEqual(LIVE_FAILED);
    expect(LIVE_ATTEMPTS.map((a) => a.length)).toEqual([7, 9, 12, 6]);
  });

  it("all four live answers are located by the new check (offsets are hints only)", () => {
    for (const rows of LIVE_ATTEMPTS) {
      const c = checkExtraction(CHECK_SCENES, extractionResultSchema.parse(answer(rows)));
      expect(c.unlocated).toEqual([]);
      expect(c.issues).toEqual([]);
      for (const l of c.located) expect(TEXTS[l.sceneOrd - 1]!.slice(l.start, l.end)).toBe(rows[l.index]![3]);
    }
    // attempt 1: scene 3 "서이온" was given as [43,46) (the leading "\n" not counted) → the real 44
    const c1 = checkExtraction(CHECK_SCENES, extractionResultSchema.parse(answer(LIVE_ATTEMPTS[0]!)));
    expect(c1.located.find((l) => rows(0, l.index)[5] === "m_seoion_s3")).toMatchObject({ sceneOrd: 3, start: 44, end: 47, how: "nearest" });
    // attempt 3: [905,908) in scene 1 (873 chars) → the nearest real occurrence 798
    const c3 = checkExtraction(CHECK_SCENES, extractionResultSchema.parse(answer(LIVE_ATTEMPTS[2]!)));
    expect(c3.located.find((l) => rows(2, l.index)[5] === "m3")).toMatchObject({ sceneOrd: 1, start: 798 });
  });

  it("quote pins a repeated name; particles / quotes / NFD / spacing on the surface are tolerated", () => {
    const text = "\n서이온은 웃었다. 차경혁이 서이온을 불렀다. 그리고 서이온이 대답했다.";
    expect(locateInText(text, { surface: "서이온", quote: "그리고 서이온이 대답", charStart: 3 })).toMatchObject({ ok: true, start: text.lastIndexOf("서이온"), how: "quote" });
    expect(locateInText(text, { surface: "서이온께서", charStart: 13 })).toMatchObject({ ok: true, start: 16, end: 19, surface: "서이온" });
    expect(locateInText(text, { surface: "“차경혁”" })).toMatchObject({ ok: true, start: 11, how: "unique" });
    expect(locateInText(text, { surface: "차경혁".normalize("NFD") })).toMatchObject({ ok: true, start: 11 });
    expect(locateInText("헌터  관리 기구가 왔다", { surface: "헌터 관리 기구" })).toMatchObject({ ok: true, start: 0, end: 9 });
    // a common short surface far from its hint is not guessed
    expect(locateInText("그는 왔다. 그는 갔다. 그는 웃었다.", { surface: "그", charStart: 40, mentionKind: "pronoun" })).toMatchObject({ ok: false, reason: "ambiguous" });
    expect(locateInText(text, { surface: "백도윤" })).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("a mention filed under the neighbouring scene is moved there; unknown names become critique issues", () => {
    const c = checkExtraction(CHECK_SCENES, extractionResultSchema.parse(answer([[2, 5, 8, "시스템", "descriptive", "mx"], BOGUS])));
    expect(c.located).toEqual([expect.objectContaining({ index: 0, sceneOrd: 3, start: 151, how: "neighbour_scene" })]);
    expect(c.unlocated).toEqual([1]);
    expect(c.issues[0]!.item).toContain("백도윤");
    expect(c.issues[0]!.problem).toContain("원문에");
  });
});

function rows(attempt: number, index: number): MentionRow {
  return LIVE_ATTEMPTS[attempt]![index]!;
}

describe("extract_facts: agent-to-agent repair dialogue (scripted Claude)", () => {
  let t: TestCore;
  beforeAll(async () => {
    t = await createTestCore();
  });
  afterAll(() => t.close());
  beforeEach(() => t.claude.reset());

  const isExtract = (r: ClaudeRequest) => !!r.schema && "mentions" in ((r.schema.properties ?? {}) as object);
  const isRepair = (r: ClaudeRequest) => isExtract(r) && r.prompt.includes("검증 에이전트");
  const extractRequests = () => t.claude.requests.filter(isExtract);

  async function seed(opts: { maxAttempts?: number } = {}) {
    const n = await t.modules.novel.service.createNovel({ title: "수정 대화 테스트" }, t.owner);
    const scope: NovelScope = { novelId: n.id };
    const tl = (await t.modules.ontology.service.getDefaultTimeline(scope)).id;
    const db = t.testDb.db;
    await db.insert(goals).values({ id: newId("gol"), novelId: n.id, totalEpisodesMin: 10, cadenceEpisodesPerWeek: 3, endingDirection: "끝" });
    const arcId = newId("arc");
    await db.insert(arcs).values({ id: arcId, novelId: n.id, ord: 1, title: "1부", goalText: "g", conflictText: "c", endCondition: "e", plannedEpisodeFrom: 1, plannedEpisodeTo: 10 });
    const epId = newId("epi");
    await db.insert(episodes).values({ id: epId, novelId: n.id, arcId, episodeNo: 1, primaryTimelineId: tl });
    const content = TEXTS.join("");
    const mvId = newId("mnv");
    await db.insert(manuscriptVersions).values({ id: mvId, novelId: n.id, episodeId: epId, versionNo: 1, kind: "draft", stage: "drafting", content, charCountWithSpaces: content.length, charCountWithoutSpaces: content.length, contentHash: "h", authorActorType: "user", authorActorId: t.ownerId });
    const sceneRows = LIVE_SCENES.map((s, i) => ({ id: newId("scn"), ord: s.ord, start: OFFSETS[i]!, end: OFFSETS[i]! + TEXTS[i]!.length }));
    for (const s of sceneRows) await db.insert(scenes).values({ id: s.id, novelId: n.id, episodeId: epId, ord: s.ord, manuscriptVersionId: mvId, charStart: s.start, charEnd: s.end, storyPoint: 1001, timelineId: tl, summary: "s" });
    // L4: no known entities → the linker may ask the model; every name is new here
    t.claude.reply({ when: { schemaHas: ["choice"] }, json: { choice: "NIL", rationale: "새 이름" }, times: Infinity });
    const { taskId } = await t.platform.uow.run((tx) =>
      t.modules.orchestration.service.createTask(tx, scope, {
        kind: "extract_facts",
        targetType: "episode",
        targetId: epId,
        episodeId: epId,
        input: { episode_id: epId, manuscript_version_id: mvId, scenes: sceneRows.map((s, i) => ({ sceneId: s.id, sceneOrd: s.ord, storyPoint: 1001, timelineId: tl, text: TEXTS[i]!, charOffset: s.start })) },
        createdBy: t.owner,
        ...(opts.maxAttempts ? { maxAttempts: opts.maxAttempts } : {}),
      }),
    );
    return { scope, taskId, mvId, sceneRows };
  }

  it("a validator critique fixes an unlocatable mention in the same conversation; the transcript is on the run", async () => {
    const { scope, taskId, mvId, sceneRows } = await seed();
    t.claude.reply({ when: (r) => isExtract(r) && !isRepair(r), json: answer([...LIVE_ATTEMPTS[3]!, BOGUS]) });
    t.claude.reply({ when: isRepair, json: answer(LIVE_ATTEMPTS[3]!) });
    await t.modules.orchestration.service.runOnce();

    const task = await t.modules.orchestration.service.getTask(scope, taskId);
    expect(task.status).toBe("done");
    expect(task.latestRun?.repairRounds).toBe(1);
    const reqs = extractRequests();
    expect(reqs).toHaveLength(2);
    // same conversation: the first answer comes back as the assistant turn, then the critique
    const turns = reqs[1]!.messages;
    expect(turns.at(-2)!.role).toBe("assistant");
    expect(turns.at(-2)!.content).toContain("백도윤");
    expect(turns.at(-1)!.content).toMatch(/검증 에이전트\(언급 위치 검증\).*1개 항목/);
    expect(turns.at(-1)!.content).toContain('m_bogus "백도윤"');
    // the system prompt states the location contract
    expect(reqs[0]!.system).toContain("quote");

    const [run] = await t.modules.orchestration.service.listRuns(scope, taskId);
    const [d] = repairDialoguesOf(run!.outputSummary);
    expect(d).toMatchObject({ purpose: "extract_facts", label: "언급 위치 검증", producerRole: "world_keeper", status: "resolved", initialIssueCount: 1, finalIssueCount: 0, maxRounds: 2 });
    expect(d!.rounds).toHaveLength(1);
    expect(d!.rounds[0]).toMatchObject({ round: 1, issueCount: 1, remainingIssueCount: 0 });
    expect(d!.rounds[0]!.responseCallId).toMatch(/^pcl_/);
    expect(d!.initialCallId).toMatch(/^pcl_/);
    expect((run!.outputSummary as { mentionCheck: { unlocated: number } }).mentionCheck.unlocated).toBe(0);

    // the scene-3 name given at [43,46) is stored at its real place (44 in the scene)
    const ms = await t.modules.ontology.service.listMentions(scope, { manuscriptVersionId: mvId });
    const s3 = ms.filter((m) => m.sceneId === sceneRows[2]!.id && m.surface === "서이온").map((m) => (m.charStart ?? -1) - sceneRows[2]!.start);
    expect(s3).toContain(44);

    // agents page timeline carries the round count
    const tl = await t.http("GET", `/api/novels/${scope.novelId}/agents/timeline`);
    expect(tl.status).toBe(200);
    expect(tl.body.runs.find((r: { taskId: string }) => r.taskId === taskId).repairRounds).toBe(1);
  });

  it("rounds are capped (agents.repair_rounds = 2); a mention still unlocatable is dropped alone, the task succeeds", async () => {
    const { scope, taskId } = await seed();
    t.claude.reply({ when: isExtract, json: answer([...LIVE_ATTEMPTS[0]!, BOGUS]), times: Infinity });
    await t.modules.orchestration.service.runOnce();

    expect(extractRequests()).toHaveLength(3); // answer + 2 repair rounds
    const task = await t.modules.orchestration.service.getTask(scope, taskId);
    expect(task.status).toBe("done");
    const [run] = await t.modules.orchestration.service.listRuns(scope, taskId);
    const [d] = repairDialoguesOf(run!.outputSummary);
    expect(d).toMatchObject({ status: "unresolved", rounds: [expect.anything(), expect.anything()], finalIssueCount: 1 });
    expect((run!.outputSummary as { repairRounds: number }).repairRounds).toBe(2);
    expect((run!.outputSummary as { mentionCheck: object }).mentionCheck).toMatchObject({ mentions: 8, located: 7, unlocated: 1, repairRounds: 2 });
  });

  it("a mostly unusable answer fails after the dialogue; the retry carries the failure feedback instead of the identical prompt", async () => {
    const { scope, taskId } = await seed({ maxAttempts: 1 });
    const garbage: MentionRow[] = [BOGUS, [3, 10, 13, "한서진", "named", "m_b2"], [4, 20, 23, "도하람", "named", "m_b3"]];
    t.claude.reply({ when: isExtract, json: answer(garbage), times: 3 });
    await t.modules.orchestration.service.runOnce();

    let task = await t.modules.orchestration.service.getTask(scope, taskId);
    expect(task.status).toBe("failed");
    expect(task.latestRun).toMatchObject({ errorFamily: "invalid_output", repairRounds: 2 });
    expect(task.latestRun!.errorMessage).toContain("에이전트 간 수정 대화 2회");
    expect(task.latestRun!.errorMessage).toContain("백도윤");

    t.claude.reply({ when: (r) => isExtract(r) && r.system.includes("직전 시도 실패 피드백"), json: answer(LIVE_ATTEMPTS[1]!) });
    await t.modules.orchestration.service.retryTask(scope, taskId, t.owner);
    await t.modules.orchestration.service.runOnce();
    task = await t.modules.orchestration.service.getTask(scope, taskId);
    expect(task.status).toBe("done");
    const retryReq = extractRequests().at(-1)!;
    expect(retryReq.system).toContain("직전 시도 실패 피드백");
    expect(retryReq.system).toContain("백도윤");
    // (follow-up check_continuity runs are not scripted here)
    expect(t.claude.unmatched.filter(isExtract)).toHaveLength(0);
  });
});
