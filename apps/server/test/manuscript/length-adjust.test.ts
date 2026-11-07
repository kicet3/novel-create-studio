/**
 * 설계 추가 0017 — episodes land in the length profile (default 5,000~5,500자, +3% accepted): a trim / expand pass
 * (adjust_length, writer) after the draft or a revision (max 2 rounds) and one more after polishing; polishing never
 * grows the text past the maximum; a rewrite that appends a second copy is not doubled; full_auto never auto-approves
 * an episode outside the range. Each describe has its own core because the scripted texts differ.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluateApproval, holdsForAuto } from "../../src/modules/autopilot/domain/policy.js";
import { dedupeRewrite, guardSceneGrowth, lengthAdjustmentOf, sceneTargets } from "../../src/modules/manuscript/domain/text.js";
import { createTestCore, type TestCore } from "../support/test-core.js";
import type { ClaudeRequest } from "../support/scripted-claude.js";
import { padScene, REVISED_SCENE, scriptPipeline } from "../support/pipeline-script.js";
import { approveStructure, bibleApproved, decideApproval, drain, planningNovel, type Scope } from "../structure/harness.js";

const DRAFT_SYS = "아웃라인의 씬을 순서대로 본문으로 씁니다";
const CONTINUE_SYS = "최소 분량보다 짧습니다";
const TRIM_SYS = "분량 편집자(trim)";
const EXPAND_SYS = "분량 편집자(expand)";
const POLISH_SYS = "문장 교정자(line_editor)";
const REVISE_SYS = "주어진 씬 하나만 다시 씁니다";
const PROFILE = { minChars: 5000, maxChars: 5500 };

const H1 = "한결은 새벽 안개가 스며드는 여관 방에서 눈을 떴다. 창밖으로 들리는 종소리는 십 년 전 그날과 똑같았다.";
const H2 = "거울 앞에 선 한결은 손등에 새겨진 흉터를 내려다보았다. 흉터는 희미하게 빛나다가 이내 사그라들었다.";
const episodeText = (sceneChars: number) => `${padScene(H1, sceneChars)}\n\n* * *\n\n${padScene(H2, sceneChars)}`;
const len = (s: string) => [...s].length;

/** the scene text of a per-scene rewrite request (last line of the prompt is the JSON payload) */
const sceneOf = (r: ClaudeRequest) => (JSON.parse(r.prompt.slice(r.prompt.lastIndexOf("\n{") + 1)) as { text: string }).text.trim().replace(/\n[ \t]*\*[ \t]*\*[ \t]*\*[ \t]*$/u, "").trim();
const headOf = (r: ClaudeRequest) => (sceneOf(r).startsWith("거울") ? H2 : H1);

async function toFirstApproval(t: TestCore, title: string, opts: { fullAuto?: boolean } = {}): Promise<Scope> {
  const { scope } = await planningNovel(t, { title });
  if (opts.fullAuto) {
    const r = await t.http("PUT", `/api/novels/${scope.novelId}/autonomy`, { autonomyLevel: "full_auto", acknowledgedFullAutoWarning: true, acknowledgedAutoItems: true, autopilot: { autoApproveBible: false } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
  await bibleApproved(t, scope);
  await approveStructure(t, scope);
  if (opts.fullAuto) {
    await drain(t, scope, async () => (await t.modules.novel.service.listArcs(scope)).some((a) => a.status === "active"));
  } else {
    await drain(t, scope, async () => (await t.modules.novel.service.listArcs(scope)).some((a) => a.status === "plan_awaiting_approval"));
    expect((await decideApproval(t, scope, "arc_plan", "approved")).status).toBeLessThan(300);
  }
  await drain(t, scope, async () => (await t.modules.manuscript.service.getEpisodeByNo(scope, 1)).status === "awaiting_approval", 150);
  return scope;
}

async function adjustTasks(t: TestCore, scope: Scope, episodeNo = 1) {
  const ep = await t.modules.manuscript.service.getEpisodeByNo(scope, episodeNo);
  const tasks = await t.modules.orchestration.service.listTasks(scope, { kinds: ["adjust_length"], episodeId: ep.id, includeCancelled: true, limit: 50 });
  return tasks.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

async function currentCount(t: TestCore, scope: Scope, episodeNo = 1) {
  const ep = await t.modules.manuscript.service.getEpisodeByNo(scope, episodeNo);
  return (await t.modules.manuscript.service.getVersion(scope, ep.currentVersionId!)).charCountWithSpaces;
}

describe("length adjustment (pure)", () => {
  it("tolerance: up to max × 1.03 is accepted, below min expands, above it trims", () => {
    expect(lengthAdjustmentOf(5000, PROFILE, 0.03)).toBeNull();
    expect(lengthAdjustmentOf(5665, PROFILE, 0.03)).toBeNull();
    expect(lengthAdjustmentOf(5666, PROFILE, 0.03)).toBe("trim");
    expect(lengthAdjustmentOf(5501, PROFILE, 0)).toBe("trim");
    expect(lengthAdjustmentOf(4999, PROFILE, 0.03)).toBe("expand");
  });

  it("scene targets scale editable scenes toward the goal; user scenes keep their count", () => {
    expect(sceneTargets([3500, 3500], [true, true], 5250)).toEqual([2625, 2625]);
    expect(sceneTargets([3000, 4000], [false, true], 5250)).toEqual([3000, 2250]);
  });

  it("a rewrite holding the original verbatim plus a second version drops the copy; a short added tail is an edit", () => {
    const orig = padScene(H2, 1000);
    expect(dedupeRewrite(orig, `${orig}\n\n${REVISED_SCENE}`)).toBe(REVISED_SCENE);
    expect(dedupeRewrite(orig, `${orig}\n\n그는 숨을 골랐다.`)).toBe(`${orig}\n\n그는 숨을 골랐다.`);
    expect(dedupeRewrite(orig, REVISED_SCENE)).toBe(REVISED_SCENE);
  });

  it("growth guard: past the ceiling or a runaway scene keeps the original", () => {
    expect(guardSceneGrowth({ originalSceneCount: 2700, newSceneCount: 2900, projectedTotal: 5600, ceiling: 5500 })).toBe("keep_original");
    expect(guardSceneGrowth({ originalSceneCount: 2700, newSceneCount: 2900, projectedTotal: 5400, ceiling: 5500 })).toBe("keep_new");
    expect(guardSceneGrowth({ originalSceneCount: 2000, newSceneCount: 4000, projectedTotal: 9000, maxGrowthRatio: 1.6 })).toBe("keep_original");
    expect(guardSceneGrowth({ originalSceneCount: 2000, newSceneCount: 2400, projectedTotal: 5400, maxGrowthRatio: 1.6 })).toBe("keep_new");
  });

  it("autopilot: an episode outside the range goes to the author, never auto-approved", () => {
    const s = { autoApproveEpisodes: true, approveDelayMinutes: 0, holdOnMediumIssues: false } as never;
    const facts = { type: "episode" as const, episodeStatus: "awaiting_approval", episodeNo: 4, belowFloor: false, openHigh: 0, openMedium: 0, safetyEver: 0, rewriteLimit: false, pendingCanon: 0 };
    const a = { approvalType: "episode", createdAt: new Date(), payload: {} };
    expect(evaluateApproval(a, facts, s).kind).toBe("auto");
    const v = evaluateApproval(a, { ...facts, lengthOutOfRange: { deviation: "long", count: 11611, minChars: 5000, maxChars: 5500 } }, s);
    expect(v).toMatchObject({ kind: "human", gate: "length_out_of_range" });
    expect((v as { reasonKo: string }).reasonKo).toContain("11,611자");
    expect(holdsForAuto("episode", { lengthOutOfRange: { deviation: "long" } }, s)).toBe(false);
    expect(holdsForAuto("episode", {}, s)).toBe(true);
  });
});

describe("trim when the draft is over the maximum", () => {
  let t: TestCore;
  const LONG = episodeText(3500);
  beforeAll(async () => {
    t = await createTestCore();
    t.claude.reply(
      { times: Infinity, when: { text: true, system: DRAFT_SYS }, text: LONG },
      { times: Infinity, when: { text: true, system: TRIM_SYS }, text: (r) => padScene(headOf(r), 2600) },
    );
    scriptPipeline(t.claude);
  });
  afterAll(() => t.close());

  it("one trim round brings 7,000자 into 5,000~5,500 before the checks; the pass is a writer run on the board", async () => {
    expect(len(LONG)).toBeGreaterThan(6900);
    const scope = await toFirstApproval(t, "줄이기 작품");
    const tasks = await adjustTasks(t, scope);
    expect(tasks.map((x) => [x.status, x.agentRole, (x.input as { adjust_phase?: string }).adjust_phase])).toEqual([["done", "writer", "draft"]]);
    const ep = await t.modules.manuscript.service.getEpisodeByNo(scope, 1);
    const versions = await t.modules.manuscript.service.listVersions(scope, ep.id);
    const trimmed = versions.find((v) => v.agentRole === "writer" && v.kind === "revision" && v.stage === "drafting")!;
    expect(trimmed.charCountWithSpaces).toBeGreaterThanOrEqual(5000);
    expect(trimmed.charCountWithSpaces).toBeLessThanOrEqual(5500);
    const count = await currentCount(t, scope);
    expect(count).toBeGreaterThanOrEqual(5000);
    expect(count).toBeLessThanOrEqual(5665);
    // the trim prompt states the current count, the per-scene target and the allowed range
    const trim = t.claude.requests.find((r) => r.system.includes(TRIM_SYS))!;
    expect(trim.prompt).toMatch(/분량 줄이기: 이 씬 현재 \d+자 → 목표 \d+자 안팎\(공백 포함\)\. 화 전체 현재 7\d{3}자, 결과는 5000~5500자\(공백 포함\) 사이여야 합니다\./);
    const e3 = (await t.modules.audit.service.list(scope, { targetIds: [ep.id], actionPrefix: "episode.status_changed", limit: 50 })).items.find((x) => (x.details as { rule?: string })?.rule === "E3")!;
    expect(e3.details).toMatchObject({ versionId: trimmed.id, lengthShortfall: 0, lengthAdjust: { round: 1, action: "trim", improved: true } });
    // the draft prompt states the range and the ceiling
    const draft = t.claude.requests.find((r) => r.system.includes(DRAFT_SYS))!;
    expect(draft.prompt).toContain("허용 범위 5000~5500자(공백 포함)");
    // the episode approval is an ordinary one (manual level): no out-of-range flag on an in-range text
    const pending = await t.http("GET", `/api/novels/${scope.novelId}/approvals?status=pending&type=episode`);
    expect(pending.body.items).toHaveLength(1);
    expect(pending.body.items[0].payload?.lengthOutOfRange).toBeUndefined();
  });
});

describe("expand when the draft is under the minimum", () => {
  let t: TestCore;
  const SHORT = episodeText(2000);
  beforeAll(async () => {
    t = await createTestCore();
    t.claude.reply(
      { times: Infinity, when: { text: true, system: CONTINUE_SYS }, text: "그는 숨을 골랐다." }, // grows < 200 chars → stop
      { times: Infinity, when: { text: true, system: DRAFT_SYS }, text: SHORT },
      { times: Infinity, when: { text: true, system: EXPAND_SYS }, text: (r) => padScene(headOf(r), 2650) },
    );
    scriptPipeline(t.claude);
  });
  afterAll(() => t.close());

  it("the expand pass enriches the scenes up into the range", async () => {
    const scope = await toFirstApproval(t, "늘리기 작품");
    const tasks = await adjustTasks(t, scope);
    expect(tasks.map((x) => x.status)).toEqual(["done"]);
    const expand = t.claude.requests.find((r) => r.system.includes(EXPAND_SYS))!;
    expect(expand.prompt).toMatch(/분량 늘리기: 이 씬 현재 \d+자 → 목표 \d+자 안팎/);
    const count = await currentCount(t, scope);
    expect(count).toBeGreaterThanOrEqual(5000);
    expect(count).toBeLessThanOrEqual(5665);
  });
});

describe("round cap: two rounds before the checks, one more after polishing", () => {
  let t: TestCore;
  const LONG = episodeText(3500);
  beforeAll(async () => {
    t = await createTestCore();
    t.claude.reply(
      { times: Infinity, when: { text: true, system: DRAFT_SYS }, text: LONG },
      // every trim takes 300 chars off a scene: 7,000 → 6,400 → 5,800 (still over 5,665 after the 2-round cap)
      { times: Infinity, when: { text: true, system: TRIM_SYS }, text: (r) => sceneOf(r).slice(0, len(sceneOf(r)) - 300) },
      // the polish keeps the text as it is
      { times: Infinity, when: { text: true, system: POLISH_SYS }, text: (r) => sceneOf(r) },
    );
    scriptPipeline(t.claude);
  });
  afterAll(() => t.close());

  it("stops at 2 rounds, checks the text, polishes, then trims once more into the range", async () => {
    const scope = await toFirstApproval(t, "상한 작품");
    const tasks = await adjustTasks(t, scope);
    expect(tasks.map((x) => [(x.input as { adjust_phase?: string }).adjust_phase, (x.input as { adjust_round?: number }).adjust_round, x.status])).toEqual([
      ["draft", 1, "done"],
      ["draft", 2, "done"],
      ["polish", 1, "done"],
    ]);
    const ep = await t.modules.manuscript.service.getEpisodeByNo(scope, 1);
    const e3 = (await t.modules.audit.service.list(scope, { targetIds: [ep.id], actionPrefix: "episode.status_changed", limit: 80 })).items.find((x) => (x.details as { rule?: string })?.rule === "E3")!;
    expect(e3.details).toMatchObject({ lengthAdjust: { round: 2, action: "trim", improved: true } });
    const checked = await t.modules.manuscript.service.getVersion(scope, (e3.details as { versionId: string }).versionId);
    expect(checked.charCountWithSpaces).toBeGreaterThan(5665); // the cap left it over the range for the checks
    const count = await currentCount(t, scope);
    expect(count).toBeGreaterThanOrEqual(5000);
    expect(count).toBeLessThanOrEqual(5665);
    // the post-polish trim went through the re-check and straight to approval (no second polish)
    expect((await t.modules.orchestration.service.listTasks(scope, { kinds: ["polish_episode"], episodeId: ep.id })).length).toBe(1);
    expect(ep.status).toBe("awaiting_approval");
  });
});

describe("polishing never grows the text past the maximum", () => {
  let t: TestCore;
  const DRAFT = episodeText(2650);
  beforeAll(async () => {
    t = await createTestCore();
    t.claude.reply(
      { times: Infinity, when: { text: true, system: DRAFT_SYS }, text: DRAFT },
      // a polish that adds ~600 chars to every scene
      { times: Infinity, when: { text: true, system: POLISH_SYS }, text: (r) => padScene(headOf(r), 3300) },
    );
    scriptPipeline(t.claude);
  });
  afterAll(() => t.close());

  it("the grown scenes keep the checked text; no adjustment pass is needed", async () => {
    expect(len(DRAFT)).toBeLessThanOrEqual(5500);
    const scope = await toFirstApproval(t, "다듬기 상한 작품");
    const count = await currentCount(t, scope);
    expect(count).toBeLessThanOrEqual(5500);
    expect((await adjustTasks(t, scope)).length).toBe(0);
    const polish = t.claude.requests.find((r) => r.system.includes(POLISH_SYS))!;
    expect(polish.prompt).toMatch(/화 전체 현재 \d+자, 결과는 5000~5500자\(공백 포함\) 사이여야 합니다\. 문장만 다듬고 분량을 늘리지 않습니다\./);
  });
});

describe("rework never doubles the episode", () => {
  let t: TestCore;
  beforeAll(async () => {
    t = await createTestCore();
    // the revise answer repeats the original scene and appends the rewritten one
    t.claude.reply({ times: Infinity, when: { text: true, system: REVISE_SYS }, text: (r) => `${sceneOf(r)}\n\n${REVISED_SCENE}` });
    scriptPipeline(t.claude);
  });
  afterAll(() => t.close());

  it("a rejected episode reworked from the draft keeps one copy of each scene", async () => {
    const scope = await toFirstApproval(t, "재작업 작품");
    const before = await currentCount(t, scope);
    const r = await decideApproval(t, scope, "episode", "rejected", { decisionNote: "마지막 장면을 더 긴장감 있게", reworkFrom: "draft" });
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    await drain(t, scope, async () => (await t.modules.manuscript.service.getEpisodeByNo(scope, 1)).status === "awaiting_approval", 150);
    const ep = await t.modules.manuscript.service.getEpisodeByNo(scope, 1);
    const current = await t.modules.manuscript.service.getVersion(scope, ep.currentVersionId!);
    expect(current.content).toContain(REVISED_SCENE.slice(0, 40));
    expect(current.content.split("한결은 칼자루를 움켜쥐고").length - 1).toBe(1); // the rewritten scene once
    expect(current.content.split("거울 앞에 선 한결은").length - 1).toBe(0); // the old scene 2 is gone
    expect(current.charCountWithSpaces).toBeLessThanOrEqual(before + 300);
    expect(current.charCountWithSpaces).toBeLessThanOrEqual(5665);
    const revise = t.claude.requests.find((x) => x.system.includes(REVISE_SYS))!;
    expect(revise.prompt).toMatch(/결과는 5000~5500자\(공백 포함\) 사이여야 합니다\. 이 씬\(2\/2\)만 고쳐 씁니다\./);
  });
});

describe("full_auto: an episode still out of range after the passes is the author's decision", () => {
  let t: TestCore;
  const LONG = episodeText(3500);
  beforeAll(async () => {
    t = await createTestCore();
    t.claude.reply(
      { times: Infinity, when: { text: true, system: DRAFT_SYS }, text: LONG },
      // the trim gives nothing shorter → kept; the polish keeps the text as it is
      { times: Infinity, when: { text: true, system: TRIM_SYS }, text: (r) => sceneOf(r) },
      { times: Infinity, when: { text: true, system: POLISH_SYS }, text: (r) => sceneOf(r) },
    );
    scriptPipeline(t.claude);
  });
  afterAll(() => t.close());

  it("the approval carries lengthOutOfRange and the autopilot holds it (gate length_out_of_range)", async () => {
    const scope = await toFirstApproval(t, "범위 밖 작품", { fullAuto: true });
    expect(await currentCount(t, scope)).toBeGreaterThan(6900);
    // not improved → no further rounds: one before the checks, one after polishing
    expect((await adjustTasks(t, scope)).map((x) => (x.input as { adjust_phase?: string }).adjust_phase)).toEqual(["draft", "polish"]);
    const pending = await t.http("GET", `/api/novels/${scope.novelId}/approvals?status=pending&type=episode`);
    expect(pending.body.items).toHaveLength(1);
    const approvalId = pending.body.items[0].id as string;
    await t.modules.autopilot.service.tick(scope);
    const held = await t.modules.hitl.service.getApproval(scope, approvalId);
    expect(held).toMatchObject({ status: "pending", autoDecided: false });
    expect((held.payload as { lengthOutOfRange?: { deviation: string } }).lengthOutOfRange).toMatchObject({ deviation: "long", minChars: 5000, maxChars: 5500 });
    expect((held.payload as { autopilot?: { heldReason?: string } }).autopilot?.heldReason).toContain("설정 범위(5,000~5,500자)를 넘습니다");
    const hits = (await t.modules.audit.service.list(scope, { actionPrefix: "autopilot.gate_hit" })).items;
    expect(hits.some((h) => h.targetId === approvalId && (h.details as { gate?: string }).gate === "length_out_of_range")).toBe(true);
    // the author can still approve it (manual flow unchanged)
    expect((await decideApproval(t, scope, "episode", "approved")).status).toBeLessThan(300);
    expect((await t.modules.manuscript.service.getEpisodeByNo(scope, 1)).status).toBe("approved");
  });
});
