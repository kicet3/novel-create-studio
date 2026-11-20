/**
 * 설계 추가 0026 — planning text never keeps an entity handle ("E7"): plan_series_bible, plan_structure, plan_arc,
 * [제목 정리], the legacy schedule_episodes copy and the applyArcPlan storage point. Planning runs are shown no
 * handle marks, so the answer goes back for repair (never rewritten, never stored); only a token inside a real
 * entity name is story text.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TaskFailure } from "../../src/modules/orchestration/index.js";
import { z } from "zod";
import { callPlanText, PLAN_NO_HANDLE_RULE, planHandleIssues, planStoryTokens, rejectPlanHandles } from "../../src/modules/manuscript/application/structure.js";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { SCRIPTED_ARC_PLAN, SCRIPTED_BIBLE, scriptPipeline, scriptedStructure } from "../support/pipeline-script.js";
import type { ClaudeRequest } from "../support/scripted-claude.js";
import { approveStructure, bibleApproved, decideApproval, drain, hooks, planningNovel, type Scope } from "./harness.js";

const RETITLE = {
  story_episodes: [
    { title: "회귀의 아침", from: 1, to: 2 },
    { title: "계약의 흔적", from: 3, to: 3 },
  ],
  rationale: "1~2화는 회귀 직후 하루, 3화는 단서를 푸는 독립 사건입니다.",
};
const HANDLE = /(?<![A-Za-z0-9_])E\d{1,3}(?![A-Za-z0-9_])/;

describe("planning handle helpers", () => {
  it("P1: story tokens of the novel plus tokens inside a real (non handle-shaped) cast name — nothing else", () => {
    expect([...planStoryTokens(new Set(["E3"]), ["한결", "E7", "E5 분대", null])]).toEqual(["E3", "E5"]);
    expect(planStoryTokens([], ["한결"]).size).toBe(0);
    expect(planStoryTokens([], ["E11", "[E6]", ""]).size).toBe(0); // a handle-shaped name is a ghost
  });

  it("callPlanText: web search runs once; its sources stay with the plan when a repaired answer is the one kept", async () => {
    const schema = z.object({ text: z.string() });
    const seen: Array<{ purpose: string; webSearch: unknown }> = [];
    const searched = { status: "used" as const, requests: 2, citations: [{ url: "https://example.com/a", title: "a" }] };
    const port = {
      call: async (input: { purpose: string; webSearch?: unknown }) => {
        seen.push({ purpose: input.purpose, webSearch: input.webSearch });
        const first = seen.length === 1;
        return { providerCallId: `c${seen.length}`, value: { text: first ? "E7이 길드를 떠난다." : "한결이 길드를 떠난다." }, modelId: "m", reused: false, usage: {}, webSearch: first ? searched : { status: "not_used" as const, requests: 0, citations: [] } };
      },
    };
    const run = { runId: "run_fake", role: "planner", checkpoint: async () => undefined, noteOutputSummary: () => undefined };
    const request = { run, purpose: "plan", system: "s", messages: [{ role: "user", content: "u" }], output: { kind: "object", schemaName: "T", schema }, webSearch: true };
    const out = await callPlanText<{ text: string }>({ port, call: port.call } as never, request as never, { story: new Set(), label: "기획서 문장" });
    expect(out.value.text).toBe("한결이 길드를 떠난다.");
    expect(seen).toEqual([
      { purpose: "plan", webSearch: true },
      { purpose: "plan_repair", webSearch: undefined }, // a repair round rewrites sentences — no second search
    ]);
    expect(out.webSearch).toEqual(searched);
  });

  it("P3: sentence fields are reported per path; id reference fields are left alone", () => {
    const value = { goal_text: "E7이 길드를 떠난다.", involved_character_ids: ["E2"], episodes: [{ summary: "E3 구역에서 E1을 만난다." }], character_states: [{ character_id: "E4", state: "성장한다." }] };
    const issues = planHandleIssues(value, new Set(["E3"]), "플롯 계획 문장");
    expect(issues.map((i) => i.item)).toEqual(["플롯 계획 문장 goal_text", "플롯 계획 문장 episodes[0].summary"]);
    expect(issues[0]!.problem).toContain("'E7'");
    expect(issues[1]!.problem).toContain("'E1'");
    expect(issues[1]!.problem).not.toContain("'E3'");
    expect(planHandleIssues({ goal_text: "E3 구역을 되찾는다." }, new Set(["E3"]), "플롯 계획 문장")).toEqual([]);
  });

  it("P3: a proposal with a handle left fails as invalid_output (retry with feedback)", () => {
    expect(() => rejectPlanHandles({ synopsis: "한결이 회귀한다." }, new Set(), "기획서 문장")).not.toThrow();
    let err: unknown;
    try {
      rejectPlanHandles({ synopsis: "E1입니다. 25세 남성으로 회귀한다." }, new Set(), "기획서 문장");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TaskFailure);
    expect(err).toMatchObject({ errorFamily: "invalid_output", retryable: true });
    expect((err as Error).message).toMatch(/기획서 문장 검사 실패.*'E1'/);
  });

  it("P7: the rule is one planner-tone line", () => {
    expect(PLAN_NO_HANDLE_RULE).toMatch(/^- .*E와 숫자로 된 기호는 이름이 아닙니다/);
    expect(PLAN_NO_HANDLE_RULE.split("\n")).toHaveLength(1);
  });
});

describe("planning pipeline: a handle in the planner's answer is sent back, never stored", () => {
  let t: TestCore;
  let scope: Scope;
  const schemaHas = (r: ClaudeRequest, ...keys: string[]) => !!r.schema && keys.every((k) => k in ((r.schema!.properties ?? {}) as object));
  const repairsOf = (...keys: string[]) => t.claude.requests.filter((r) => schemaHas(r, ...keys) && /구성 검사 에이전트/.test(r.prompt));

  beforeAll(async () => {
    t = await createTestCore();
    // (one novel in this core) the producing call, not the repair turn
    const mine = (r: ClaudeRequest) => !/구성 검사 에이전트/.test(r.prompt);
    t.claude.reply(
      // first answers of this novel carry handles; the repair turn (critique in the conversation) gets the clean script
      {
        when: (r) => schemaHas(r, "logline", "synopsis", "arc_outline") && mine(r),
        json: { ...SCRIPTED_BIBLE, characters: [{ ...SCRIPTED_BIBLE.characters[0]!, description: "E1입니다. 회귀한 검사." }, SCRIPTED_BIBLE.characters[1]!], world_rules: [{ statement: "E2의 흉터는 계약을 맺은 자에게만 생긴다.", source_field_path: null }] },
      },
      {
        when: (r) => schemaHas(r, "parts", "ending") && mine(r),
        json: (r: ClaudeRequest) => {
          const s = scriptedStructure(r.prompt);
          return { ...s, ending: { ...s.ending, conflict_resolution: "E1이 계약자를 쓰러뜨린다." }, parts: s.parts.map((p, i) => (i ? p : { ...p, plots: [{ ...p.plots[0]!, core_event: "E7이 길드를 배신한다." }] })) };
        },
      },
      {
        when: (r) => schemaHas(r, "goal_text", "episodes") && mine(r),
        json: { ...SCRIPTED_ARC_PLAN, goal_text: "E1이 회귀를 받아들인다.", episodes: SCRIPTED_ARC_PLAN.episodes.map((e, i) => (i ? e : { ...e, summary: "E1이 눈을 뜬다.", hook_note: "E2가 문을 두드린다." })) },
      },
      // [제목 정리]: a handle in a group title and in the rationale, then the clean proposal
      { when: (r) => schemaHas(r, "story_episodes", "rationale") && !schemaHas(r, "goal_text") && mine(r), json: { story_episodes: [{ title: "E1의 아침", from: 1, to: 2 }, { title: "계약의 흔적", from: 3, to: 3 }], rationale: "1~2화는 E1의 하루입니다." } },
      { times: Infinity, when: (r) => schemaHas(r, "story_episodes", "rationale") && !schemaHas(r, "goal_text"), json: RETITLE },
    );
    scriptPipeline(t.claude);
    ({ scope } = await planningNovel(t, { title: "기호 누출 작품" }));
  });
  afterAll(() => t.close());

  it("plan_series_bible: every string leaf is checked; the stored bible is the repaired one", async () => {
    await drain(t, scope, async () => (await t.modules.novel.service.listBibles(scope)).some((b) => b.status === "awaiting_approval"));
    const [bible] = await t.modules.novel.service.listBibles(scope);
    expect(JSON.stringify([bible!.synopsis, bible!.content, bible!.contentMd])).not.toMatch(HANDLE);
    const first = t.claude.requests.find((r) => schemaHas(r, "logline", "synopsis", "arc_outline"))!;
    expect(first.system).toContain("E와 숫자로 된 기호는 이름이 아닙니다"); // P7
    const [repair] = repairsOf("logline", "synopsis", "arc_outline");
    expect(repair, "bible repair turn").toBeTruthy();
    expect(repair!.prompt).toContain("기획서 문장 characters[0].description");
    expect(repair!.prompt).toContain("기획서 문장 world_rules[0].statement");
    expect(repair!.prompt).toContain("'E숫자' 기호는 모두 인물·장소의 실제 이름으로");
    const q = await t.http("GET", `/api/novels/${scope.novelId}/approvals?status=pending`);
    expect(JSON.stringify(q.body)).not.toMatch(HANDLE);
  });

  it("plan_structure: ending and plot text are repaired before the proposal is saved", async () => {
    await bibleApproved(t, scope);
    await approveStructure(t, scope);
    const st = (await t.modules.novel.service.getStructure(scope))!;
    expect(JSON.stringify([st.ending, st.parts.map((p) => [p.title, p.goalText, p.turningPoints, p.characterStates, p.plotOutline])])).not.toMatch(HANDLE);
    const [repair] = repairsOf("parts", "ending");
    expect(repair, "structure repair turn").toBeTruthy();
    expect(repair!.prompt).toContain("전체 구성 문장 ending.conflict_resolution");
    expect(repair!.prompt).toContain("전체 구성 문장 parts[0].plots[0].core_event");
    expect(repair!.system).toContain("E와 숫자로 된 기호는 이름이 아닙니다");
    // the plots copied from the structure (arcs.goal_text / core_event) are clean too
    const arcs = await t.modules.novel.service.listArcs(scope);
    expect(arcs.length).toBeGreaterThan(0);
    expect(JSON.stringify(arcs.map((a) => [a.title, a.goalText, a.coreEvent]))).not.toMatch(HANDLE);
  });

  it("plan_arc: plan fields and 화 plans are repaired; arcs / episodes carry no handle", async () => {
    await drain(t, scope, async () => (await t.modules.novel.service.listArcs(scope)).some((a) => a.status === "plan_awaiting_approval"));
    const arc = (await t.modules.novel.service.listArcs(scope)).find((a) => a.plannedEpisodeFrom === 1)!;
    expect(arc.goalText).toBe(SCRIPTED_ARC_PLAN.goal_text);
    expect(JSON.stringify([arc.title, arc.goalText, arc.conflictText, arc.endCondition, arc.coreEvent, arc.changeText, arc.setupPlan])).not.toMatch(HANDLE);
    const eps = await t.modules.manuscript.service.listEpisodes(scope, { arcId: arc.id });
    expect(eps.length).toBe(3);
    expect(JSON.stringify(eps.map((e) => [e.title, e.planSummary, e.hookNote]))).not.toMatch(HANDLE);
    const [repair] = repairsOf("goal_text", "episodes");
    expect(repair, "arc plan repair turn").toBeTruthy();
    expect(repair!.prompt).toContain("플롯 계획 문장 goal_text");
    expect(repair!.prompt).toContain("플롯 계획 문장 episodes[0].summary");
    expect(repair!.prompt).toContain("플롯 계획 문장 episodes[0].hook_note");
    expect(repair!.system).toContain("E와 숫자로 된 기호는 이름이 아닙니다");
  });

  it("[제목 정리]: group titles and the rationale are repaired before the proposal reaches the author", async () => {
    const arc = (await t.modules.novel.service.listArcs(scope)).find((a) => a.plannedEpisodeFrom === 1)!;
    const url = `/api/novels/${scope.novelId}/arcs/${arc.id}/retitle`;
    expect((await t.http("POST", url)).status).toBe(202);
    let proposal: unknown = null;
    for (let i = 0; i < 30 && !proposal; i++) {
      proposal = (await t.http("GET", url)).body.proposal;
      if (proposal) break;
      await t.testDb.exec(`UPDATE tasks SET not_before_at = NULL WHERE novel_id = '${scope.novelId}' AND status = 'ready'`);
      await t.modules.orchestration.service.runOnce();
    }
    expect(proposal, "retitle proposal").toBeTruthy();
    expect(JSON.stringify(proposal)).not.toMatch(HANDLE);
    expect(JSON.stringify(proposal)).toContain("회귀의 아침");
    const [repair] = repairsOf("story_episodes", "rationale").filter((r) => !schemaHas(r, "goal_text"));
    expect(repair, "retitle repair turn").toBeTruthy();
    expect(repair!.prompt).toContain("묶음 제목·이유 story_episodes[0].title");
    expect(repair!.prompt).toContain("묶음 제목·이유 rationale");
    expect(repair!.system).toContain("E와 숫자로 된 기호는 이름이 아닙니다");
  });

  it("P6: a re-plan payload stored earlier with a handle is refused at applyArcPlan (nothing is written)", async () => {
    const r = await decideApproval(t, scope, "arc_plan", "approved");
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    const nv = t.modules.novel.service;
    const arc = (await nv.listArcs(scope)).find((a) => a.plannedEpisodeFrom === 1)!;
    expect(arc.status).toBe("active");
    const plan = { ...SCRIPTED_ARC_PLAN, story_episodes: [], goal_text: "E7이 길드를 무너뜨린다." };
    const approval = { id: "apr_x", subjectId: arc.id, payload: { replan: { plan, modelId: "m", newCharacters: [] } } };
    const decide = () =>
      t.platform.uow.run((tx) => hooks(t).approvalHandlers.arc_plan({ tx, scope, approval, decision: "approved", decisionNote: null, reworkFrom: null, actor: t.owner, answerId: null } as never));
    await expect(decide()).rejects.toMatchObject({ name: "HandleLeakError" });
    expect((await nv.getArc(scope, arc.id)).goalText).toBe(SCRIPTED_ARC_PLAN.goal_text);
  });
});

describe("a planner that keeps writing handles", () => {
  let t: TestCore;
  beforeAll(async () => {
    t = await createTestCore();
    t.claude.reply({ times: Infinity, when: { schemaHas: ["logline", "synopsis", "arc_outline"] }, json: { ...SCRIPTED_BIBLE, synopsis: "E1은 죽음 직전 십 년 전으로 회귀한다." } });
    scriptPipeline(t.claude);
  });
  afterAll(() => t.close());

  it("plan_series_bible fails with invalid_output naming the symbol; no bible is stored", async () => {
    const { scope } = await planningNovel(t, { title: "끝까지 새는 작품" });
    const failed = async () => (await t.modules.orchestration.service.listTasks(scope, { kinds: ["plan_series_bible"], limit: 5 }))[0]?.latestRun?.errorMessage ?? null;
    await drain(t, scope, async () => !!(await failed()));
    expect(await failed()).toMatch(/기획서 문장 검사 실패.*'E1'/);
    expect(await t.modules.novel.service.listBibles(scope)).toEqual([]);
  });
});

describe("legacy schedule_episodes (no story structure): the bible line is not copied when it carries a handle", () => {
  let t: TestCore;
  beforeAll(async () => {
    t = await createTestCore();
    scriptPipeline(t.claude);
  });
  afterAll(() => t.close());

  it("the new plot gets no goal text from a contaminated arc_outline summary", async () => {
    const { scope } = await planningNovel(t, { title: "구성 없는 옛 작품" });
    const nv = t.modules.novel.service;
    await drain(t, scope, async () => (await nv.listBibles(scope)).some((b) => b.status === "awaiting_approval"));
    // rows written before 0026: a bible whose second arc line carries a handle, and a running first plot without a structure
    await t.testDb.exec(`UPDATE series_bibles SET content = jsonb_set(content, '{arc_outline,1,summary}', '"E7이 계약자를 추적한다."') WHERE novel_id = '${scope.novelId}'`);
    const first = await t.platform.uow.run((tx) => nv.createArc(tx, scope, { ord: 1, title: "1부", goalText: "", conflictText: "", endCondition: "", plannedEpisodeFrom: 1, plannedEpisodeTo: 3 }, t.owner));
    await t.testDb.exec(`UPDATE arcs SET status = 'active' WHERE id = '${first.id}'`);
    const r = await decideApproval(t, scope, "series_bible", "approved");
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    await drain(t, scope, async () => (await nv.listArcs(scope)).some((a) => a.ord === 2));
    const second = (await nv.listArcs(scope)).find((a) => a.ord === 2)!;
    expect(second).toMatchObject({ title: "2부 계약자", goalText: "", plannedEpisodeFrom: 4, plannedEpisodeTo: 12 });
  });
});
