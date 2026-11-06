/**
 * 설계 추가 0008 — plot characters gate, writing context (story_plan + focused cast profiles), plan_deviation issues,
 * draft continuation below the profile minimum and the 3,000-char floor (no auto approval / publish), full_auto.
 * Each describe has its own core because the scripted responses differ (draft length, polish, plot characters).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as dto from "@ncs/shared";
import { actors } from "../../src/platform/index.js";
import { createTestCore, type TestCore } from "../support/test-core.js";
import type { ClaudeRequest } from "../support/scripted-claude.js";
import { padScene, SCRIPTED_ARC_PLAN, scriptPipeline } from "../support/pipeline-script.js";
import { approveStructure, bibleApproved, decideApproval, drain, planningNovel, type Scope } from "./harness.js";

const DRAFT_SYS = "아웃라인의 씬을 순서대로 본문으로 씁니다";
const CONTINUE_SYS = "최소 분량보다 짧습니다";

describe("plot characters, writing context and plan deviations", () => {
  let t: TestCore;
  let scope: Scope;
  beforeAll(async () => {
    t = await createTestCore();
    t.claude.reply(
      {
        times: Infinity,
        when: { schemaHas: ["goal_text", "episodes"] },
        json: (r: ClaudeRequest) => {
          const hero = /"id":"(chr_[0-9A-HJKMNP-TV-Z]{26})","name":"한결"/.exec(r.prompt)?.[1];
          return {
            ...SCRIPTED_ARC_PLAN,
            involved_character_ids: hero ? [hero] : [],
            new_characters: [
              {
                name: "도윤",
                role: "antagonist",
                age: "",
                appearance: "",
                personality: "",
                desire: "길드를 손에 넣는다",
                motivation: "",
                weakness: "",
                background: "",
                speech_sample: "\"넌 아직 아무것도 몰라.\"",
                arc_start: "",
                arc_end: "",
                story_role: "",
                relation_to_protagonist: "숙적",
                first_appearance_episode_no: 2,
              },
            ],
          };
        },
      },
      { times: Infinity, when: { schemaHas: ["characters"], prompt: "빈 필수 항목 채우기" }, json: { characters: [] } },
      {
        times: Infinity,
        when: { schemaHas: ["verdicts"] },
        json: { verdicts: [], issues: [{ kind: "plan_deviation", severity: "high", scene_ord: 1, message: "1부 목표와 무관한 장면이 길게 이어집니다.", fix_scope: "outline", evidence: ["PLAN"] }] },
      },
    );
    scriptPipeline(t.claude);
    ({ scope } = await planningNovel(t, { title: "플롯 인물 작품" }));
    await bibleApproved(t, scope);
    await approveStructure(t, scope);
  });
  afterAll(() => t.close());

  it("plan_arc proposes a new character (introducedArcId, proposed); the arc plan approval waits for its required fields", async () => {
    await drain(t, scope, async () => (await t.modules.novel.service.listArcs(scope)).some((a) => a.status === "plan_awaiting_approval"));
    const arc = (await t.modules.novel.service.listArcs(scope)).find((a) => a.status === "plan_awaiting_approval")!;
    const cast = dto.castViewSchema.parse((await t.http("GET", `/api/novels/${scope.novelId}/cast`)).body);
    const doyun = cast.items.find((c) => c.name === "도윤")!;
    expect(doyun).toMatchObject({ introducedArcId: arc.id, proposed: true, status: "draft", firstAppearanceEpisodeNo: 2, firstAppearanceArcTitle: arc.title });
    expect(cast.completeness.complete).toBe(true); // plot characters are not part of the initial gate
    expect((await t.modules.orchestration.service.listTasks(scope, { kinds: ["draft_cast"] })).some((x) => (x.input as { fill_missing?: boolean }).fill_missing)).toBe(true);
    const approvals = await t.http("GET", `/api/novels/${scope.novelId}/approvals?status=pending&type=arc_plan`);
    const q = await t.http("GET", `/api/novels/${scope.novelId}/questions/${approvals.body.items[0].questionId}`);
    expect(JSON.stringify(q.body)).toContain("캐릭터 화면에서 확인해야 승인할 수 있습니다");
    expect(q.body.approval.payload).toMatchObject({ castIncomplete: true, characterIds: [doyun.id] });
    // the gap is visible on the cast page and on the plot row of the structure view
    expect(cast.plotCompleteness.complete).toBe(false);
    expect(cast.plotCompleteness.items.map((i) => i.characterId)).toEqual([doyun.id]);
    const sv = dto.structureViewSchema.parse((await t.http("GET", `/api/novels/${scope.novelId}/structure`)).body);
    expect(sv.plots.find((p) => p.id === arc.id)!.castGaps?.items.map((i) => i.name)).toEqual(["도윤"]);
    expect(sv.plots.find((p) => p.id === arc.id)!.involvedCharacterIds).toContain(doyun.id); // introduced → involved
    const r = await decideApproval(t, scope, "arc_plan", "approved");
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("plot_cast_incomplete");
    expect(r.body.error.message).toContain("도윤");
    expect(r.body.error.message.match(/새로 등장하는 인물/g)).toHaveLength(1); // one sentence, no duplicated head
    expect((await t.modules.novel.service.getArc(scope, arc.id)).status).toBe("plan_awaiting_approval"); // rolled back

    expect((await t.http("PATCH", `/api/novels/${scope.novelId}/cast/characters/${doyun.id}`, { storyRole: "길드를 노리는 부길드장" })).status).toBe(200);
    expect((await t.http("POST", `/api/novels/${scope.novelId}/cast/characters/${doyun.id}/accept`)).status).toBe(200);
    const ok = await decideApproval(t, scope, "arc_plan", "approved");
    expect(ok.status, JSON.stringify(ok.body)).toBeLessThan(300);
    const after = await t.modules.cast.service.getCharacter(scope, doyun.id);
    expect(after.status).toBe("confirmed");
    expect(after.entityId).toBeTruthy();
    expect((await t.modules.audit.service.list(scope, { actionPrefix: "cast.plot_characters" })).items.map((e) => e.action)).toEqual(
      expect.arrayContaining(["cast.plot_characters_proposed", "cast.plot_characters_confirmed"]),
    );
  });

  it("outline / draft / check prompts carry the story plan and the focused cast; plan deviations are medium and do not block", async () => {
    await drain(t, scope, async () => (await t.modules.manuscript.service.getEpisodeByNo(scope, 1)).status === "awaiting_approval", 100);
    const outline = t.claude.requests.find((r) => r.system.includes("이번 화 아웃라인을 JSON으로"))!;
    for (const s of ["작품 구성", "[결말]", "[현재 부] 1부", "[현재 플롯]", "[이번 화 계획] 1화: 한결이 십 년 전 새벽에 눈을 뜬다.", "말투 예시", "변화 아크"]) expect(outline.prompt, s).toContain(s);
    expect(outline.prompt).toContain("도윤");
    expect(outline.prompt).toContain("아직 등장 전 — 2화 첫 등장 예정");
    const draft = t.claude.requests.find((r) => r.system.includes(DRAFT_SYS))!;
    expect(draft.prompt).toContain("[이번 화 계획]");
    expect(draft.prompt).toMatch(/목표 분량: \d+자 이상\(공백 포함\), 최소 5000자/);
    const check = t.claude.requests.find((r) => r.system.includes("연속성 편집자"))!;
    expect(check.prompt).toContain("[결말]");
    expect(check.system).toContain("plan_deviation");
    const issues = await t.testDb.query<{ kind: string; severity: string; fix_scope: string }>(`SELECT kind, severity, fix_scope FROM continuity_issues WHERE novel_id = '${scope.novelId}'`);
    expect(issues.some((i) => i.kind === "plan_deviation" && i.severity === "medium" && i.fix_scope === "outline")).toBe(true);
    const ev = await t.testDb.query<{ ref_type: string }>(`SELECT e.ref_type FROM continuity_issue_evidence e JOIN continuity_issues i ON i.id = e.issue_id WHERE i.kind = 'plan_deviation' AND i.novel_id = '${scope.novelId}'`);
    expect(ev[0]!.ref_type).toBe("arc");
  });
});

describe("draft continuation below the profile minimum", () => {
  let t: TestCore;
  const SHORT = `${padScene("한결은 새벽 안개가 스며드는 여관 방에서 눈을 떴다.", 1500)}\n\n* * *\n\n${padScene("거울 앞에 선 한결은 손등의 흉터를 내려다보았다.", 1500)}`;
  const MORE = padScene("한결은 여관을 나서 길드 회관으로 향했다.", 2200);
  beforeAll(async () => {
    t = await createTestCore();
    t.claude.reply(
      { times: Infinity, when: { text: true, system: CONTINUE_SYS }, text: MORE },
      { times: Infinity, when: { text: true, system: DRAFT_SYS }, text: SHORT },
    );
    scriptPipeline(t.claude);
  });
  afterAll(() => t.close());

  it("continues once from the outline until the 5,000-char minimum is reached", async () => {
    const { scope } = await planningNovel(t, { title: "이어쓰기 작품" });
    await bibleApproved(t, scope);
    await approveStructure(t, scope);
    await drain(t, scope, async () => (await t.modules.novel.service.listArcs(scope)).some((a) => a.status === "plan_awaiting_approval"));
    expect((await decideApproval(t, scope, "arc_plan", "approved")).status).toBeLessThan(300);
    await drain(t, scope, async () => {
      const ep = await t.modules.manuscript.service.getEpisodeByNo(scope, 1);
      return ["checking", "polishing", "awaiting_approval"].includes(ep.status);
    });
    const ep = await t.modules.manuscript.service.getEpisodeByNo(scope, 1);
    const draft = (await t.modules.manuscript.service.listVersions(scope, ep.id)).find((v) => v.kind === "draft")!;
    expect(draft.charCountWithSpaces).toBeGreaterThanOrEqual(5000);
    expect((await t.modules.manuscript.service.getVersion(scope, draft.id)).content).toContain("한결은 여관을 나서 길드 회관으로 향했다.");
    expect(t.claude.requests.filter((r) => r.system.includes(CONTINUE_SYS))).toHaveLength(1);
    const e3 = (await t.modules.audit.service.list(scope, { targetIds: [ep.id], actionPrefix: "episode.status_changed", limit: 50 })).items.find((x) => (x.details as { rule?: string })?.rule === "E3")!;
    expect(e3.details).toMatchObject({ continueAttempts: 1, lengthShortfall: 0, belowFloor: false });
  });
});

describe("3,000-char floor: full_auto keeps the structure approval, no auto approval / publish of a short episode", () => {
  let t: TestCore;
  const TINY = `${padScene("한결은 새벽 안개가 스며드는 여관 방에서 눈을 떴다.", 550)}\n\n* * *\n\n${padScene("거울 앞에 선 한결은 손등의 흉터를 내려다보았다.", 550)}`;
  beforeAll(async () => {
    t = await createTestCore();
    t.claude.reply(
      { times: Infinity, when: { text: true, system: CONTINUE_SYS }, text: "그는 숨을 골랐다." }, // grows < 200 chars → stop
      { times: Infinity, when: { text: true, system: DRAFT_SYS }, text: TINY },
      { times: Infinity, when: { text: true, system: "문장 교정자(line_editor)" }, text: "짧게 다듬은 문장." },
    );
    scriptPipeline(t.claude);
  });
  afterAll(() => t.close());

  it("full_auto: the structure still needs the user; plots start without a plan approval (AR4)", async () => {
    const { scope } = await planningNovel(t, { title: "분량 미달 작품" });
    expect((await t.http("PUT", `/api/novels/${scope.novelId}/autonomy`, { autonomyLevel: "full_auto", acknowledgedFullAutoWarning: true })).status).toBe(200);
    await bibleApproved(t, scope);
    await drain(t, scope, async () => (await t.modules.novel.service.getStructure(scope))?.status === "awaiting_approval");
    await drain(t, scope, async () => true, 3);
    expect((await t.modules.novel.service.getStructure(scope))!.status).toBe("awaiting_approval"); // never auto-approved
    expect((await t.http("GET", `/api/novels/${scope.novelId}/approvals?status=pending&type=story_structure`)).body.items).toHaveLength(1);
    await approveStructure(t, scope);
    await drain(t, scope, async () => (await t.modules.novel.service.listArcs(scope)).some((a) => a.status === "active"));

    // short draft: continuation gave nothing; polish would shrink it further → kept; no E9(c)
    await drain(t, scope, async () => (await t.modules.manuscript.service.getEpisodeByNo(scope, 1)).status === "awaiting_approval", 100);
    const ep = await t.modules.manuscript.service.getEpisodeByNo(scope, 1);
    const current = await t.modules.manuscript.service.getVersion(scope, ep.currentVersionId!);
    expect(current.content).toBe(`${TINY}\n\n그는 숨을 골랐다.`); // the shorter polished scenes were not taken
    expect(t.claude.requests.filter((r) => r.system.includes(CONTINUE_SYS))).toHaveLength(1);
    expect(current.charCountWithSpaces).toBeLessThan(3000);
    const list = dto.structureViewSchema.parse((await t.http("GET", `/api/novels/${scope.novelId}/structure`)).body);
    expect(list.episodes.find((e) => e.episodeNo === 1)!.lengthBelowFloor).toBe(true);
    const detail = dto.episodeDetailDtoSchema.parse((await t.http("GET", `/api/novels/${scope.novelId}/episodes/1`)).body);
    expect(detail.length).toMatchObject({ hardMinChars: 3000, belowFloor: true });
    expect(detail.lengthBelowFloor).toBe(true);
    const pending = await t.http("GET", `/api/novels/${scope.novelId}/approvals?status=pending&type=episode`);
    expect(pending.body.items).toHaveLength(1);
    const q = await t.http("GET", `/api/novels/${scope.novelId}/questions/${pending.body.items[0].questionId}`);
    expect(JSON.stringify(q.body)).toContain("분량 미달");

    // an agent / system can neither approve nor publish it; the user can
    await expect(t.platform.uow.run((tx) => t.modules.manuscript.service.transitionEpisode(tx, scope, ep.id, "approved", actors.agent("showrunner", "run_x")))).rejects.toMatchObject({ code: "length_below_floor" });
    expect((await decideApproval(t, scope, "episode", "approved")).status).toBeLessThan(300);
    await expect(t.modules.manuscript.service.publishEpisode(scope, ep.id, actors.system("publisher"))).rejects.toMatchObject({ code: "length_below_floor" });
    const pub = await t.http("POST", `/api/novels/${scope.novelId}/episodes/1/publish`);
    expect(pub.status, JSON.stringify(pub.body)).toBe(200);
  });
});
