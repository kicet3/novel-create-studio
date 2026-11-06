/**
 * 설계 추가: 새 작품은 제목 없이 만들고(제목 미정), 컨셉 대화가 추천 제목 3~5개를 세션에 올린다.
 * 사용자가 하나를 고르거나 고쳐서 정하면 작품 제목이 확정(title_source=user)되고 브리프 승인 후에도 유지된다.
 * "다른 추천 받기"는 concept_turn(input.titles=true)으로 새 추천을 만든다.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { conceptInternals } from "../../src/modules/concept/module.js";
import { normalizeTitleSuggestions, hasTitleMaterial } from "../../src/modules/concept/domain/title.js";
import { emptyWorkingBrief } from "../../src/modules/concept/domain/brief.js";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { conceptHarness, installConceptStubs, type Scripted } from "./support.js";

let t: TestCore;
let script: Scripted[];
beforeAll(async () => {
  t = await createTestCore();
  script = installConceptStubs(t).script;
});
afterAll(() => t.close());

const novelSvc = () => t.modules.novel.service;
const conceptSvc = () => t.modules.concept.service;
const SUGGESTED = [
  { title: "『회귀한 짐꾼은 탑을 오른다』", reason: "회귀 + 짐꾼 주인공을 바로 드러냅니다" },
  { title: "짐꾼, 다시 탑에 서다", reason: "문장형으로 재도전을 강조" },
  { title: "탑의 짐꾼", reason: "짧고 기억하기 쉬운 키워드형" },
  { title: "탑의 짐꾼", reason: "중복 — 걸러져야 함" },
];
const turn = (extra: Record<string, unknown> = {}) => ({ reply_text: "좋아요. 주인공은 어떤 사람인가요?", ...extra });

describe("title suggestions in the concept conversation", () => {
  it("creating a novel without a title starts provisional (no title input needed)", async () => {
    const r = await t.http("POST", "/api/novels", { ageRating: "age_15", entryMode: "conversation" });
    expect(r.status).toBe(201);
    expect(r.body.title).toBe("제목 미정");
    expect(r.body.titleSource).toBe("provisional");
  });

  it("a turn stores 3–5 cleaned suggestions; the first previews as working title; choosing one confirms it", async () => {
    const novel = await novelSvc().createNovel({}, t.owner);
    const h = await conceptHarness(t, novel.id, script);

    script.push(turn({ title_suggestions: SUGGESTED }));
    await h.say("회귀한 짐꾼이 탑을 오르는 이야기");
    await h.run();

    let view = (await conceptSvc().getSessionView(h.scope))!;
    expect(view.titleSuggestions.items.map((x) => x.title)).toEqual(["회귀한 짐꾼은 탑을 오른다", "짐꾼, 다시 탑에 서다", "탑의 짐꾼"]);
    expect(view.titleSuggestions.items[0]!.reason).toContain("짐꾼");
    expect(view.titleSuggestions.generatedAt).not.toBeNull();
    expect(view.titleSuggestions.canRefresh).toBe(true);
    let n = await novelSvc().getNovel(h.scope);
    expect(n.titleSource).toBe("auto"); // preview only
    expect(n.title).toBe("회귀한 짐꾼은 탑을 오른다");
    expect((await h.lastAgent()).body).toContain("추천 제목 3개");

    // too few usable suggestions → ignored (old set kept)
    script.push(turn({ title_suggestions: [{ title: "제목 미정" }, { title: "하나" }] }));
    await h.say("주인공은 배신당한 짐꾼이에요");
    await h.run();
    view = (await conceptSvc().getSessionView(h.scope))!;
    expect(view.titleSuggestions.items).toHaveLength(3);

    // the user edits a suggestion and saves it (HTTP)
    const s = await h.session();
    const r = await t.http("POST", `/api/novels/${novel.id}/concept/sessions/${s.id}/title`, { title: "짐꾼, 다시 탑에 오르다" });
    expect(r.status).toBe(200);
    expect(r.body.workingBrief.content.title).toBe("짐꾼, 다시 탑에 오르다");
    n = await novelSvc().getNovel(h.scope);
    expect(n.title).toBe("짐꾼, 다시 탑에 오르다");
    expect(n.titleSource).toBe("user");

    // later turns no longer replace the chosen title nor store new suggestions
    script.push(turn({ working_title: { title: "다른 가제", reason: "" }, title_suggestions: [{ title: "가" + "나다" }, { title: "라마바" }, { title: "사아자" }] }));
    await h.say("결말은 해피엔딩");
    await h.run();
    n = await novelSvc().getNovel(h.scope);
    expect(n.title).toBe("짐꾼, 다시 탑에 오르다");
    view = (await conceptSvc().getSessionView(h.scope))!;
    expect(view.titleSuggestions.items[0]!.title).toBe("회귀한 짐꾼은 탑을 오른다");

    // empty title → 400
    const bad = await t.http("POST", `/api/novels/${novel.id}/concept/sessions/${s.id}/title`, { title: "  " });
    expect(bad.status).toBe(400);
  });

  it('"다른 추천 받기" refreshes the set through a titles-only concept_turn (no reply, no turn count)', async () => {
    const novel = await novelSvc().createNovel({}, t.owner);
    const h = await conceptHarness(t, novel.id, script);
    const s0 = await h.session();

    // nothing to base titles on yet → 422
    const early = await t.http("POST", `/api/novels/${novel.id}/concept/sessions/${s0.id}/title-suggestions`, {});
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe("concept_title_no_material");

    script.push(turn({ title_suggestions: SUGGESTED.slice(0, 3) }));
    await h.say("북부 성채의 막내 기사가 왕국을 지키는 이야기");
    await h.run();
    const before = await h.session();
    const msgCount = (await h.messages()).length;

    const r = await t.http("POST", `/api/novels/${novel.id}/concept/sessions/${before.id}/title-suggestions`, {});
    expect(r.status).toBe(202);
    expect(r.body.taskId).toMatch(/^tsk_/);
    // double click coalesces into the same task
    const again = await t.http("POST", `/api/novels/${novel.id}/concept/sessions/${before.id}/title-suggestions`, {});
    expect(again.body.taskId).toBe(r.body.taskId);
    expect((await conceptSvc().getSessionView(h.scope))!.titleSuggestions.refreshing).toBe(true);

    let seenSystem = "";
    script.push((input) => {
      expect(input.purpose).toBe("concept_titles");
      seenSystem = input.system;
      return {
        suggestions: [
          { title: "탑의 짐꾼", reason: "이전과 같음 — 제외" },
          { title: "북부 성채의 막내 기사", reason: "배경 + 주인공" },
          { title: "막내 기사는 성채를 버리지 않는다", reason: "문장형" },
          { title: "북벽", reason: "짧은 분위기형" },
        ],
      };
    });
    await h.run();
    expect(seenSystem).toContain("이전에 추천한 제목");
    expect(seenSystem).toContain("탑의 짐꾼");

    const view = (await conceptSvc().getSessionView(h.scope))!;
    expect(view.titleSuggestions.items.map((x) => x.title)).toEqual(["북부 성채의 막내 기사", "막내 기사는 성채를 버리지 않는다", "북벽"]);
    expect(view.titleSuggestions.refreshing).toBe(false);
    expect(view.titleSuggestions.error).toBeNull();
    const after = await h.session();
    expect(after.agentTurnCount).toBe(before.agentTurnCount);
    expect(after.spentMicros).toBeGreaterThan(before.spentMicros);
    expect((await h.messages()).length).toBe(msgCount);
    // the working title preview (auto) is not replaced by a refresh
    expect((await novelSvc().getNovel(h.scope)).title).toBe("회귀한 짐꾼은 탑을 오른다");
  });

  it("a refresh whose output has too few new titles reports an error and keeps the old set", async () => {
    const novel = await novelSvc().createNovel({}, t.owner);
    const h = await conceptHarness(t, novel.id, script);
    script.push(turn({ title_suggestions: SUGGESTED.slice(0, 3) }));
    await h.say("회귀한 짐꾼 이야기");
    await h.run();
    await conceptSvc().requestTitleSuggestions(h.scope, (await h.session()).id, t.owner);
    script.push({ suggestions: [{ title: "탑의 짐꾼", reason: "" }, { title: "새 제목", reason: "" }] });
    await h.run();
    const view = (await conceptSvc().getSessionView(h.scope))!;
    expect(view.titleSuggestions.refreshing).toBe(false);
    expect(view.titleSuggestions.error).toContain("만들지 못했습니다");
    expect(view.titleSuggestions.items).toHaveLength(3);
  });

  it("the chosen title survives brief approval (N2)", async () => {
    const novel = await novelSvc().createNovel({}, t.owner);
    const h = await conceptHarness(t, novel.id, script);
    const s = await h.session();
    // fill the required slots via form edits, then pick a title
    const svc = conceptSvc();
    await svc.switchEntryMode(h.scope, s.id, "direct_input", t.owner);
    const edits: Array<[string, unknown]> = [
      ["category.genre_key", "modern_fantasy"],
      ["age_rating", "age_15"],
      ["protagonist.name", "한도윤"],
      ["protagonist.starting_condition", "던전 짐꾼"],
      ["protagonist.desire", "탑 정상에 오르기"],
      ["opposition", "길드의 배신"],
      ["core_hook", "회귀한 짐꾼만 아는 탑의 비밀"],
      ["ending_direction", "해피엔딩"],
      ["logline", "회귀한 짐꾼이 탑을 다시 오른다"],
    ];
    for (const [path, value] of edits) await svc.editWorkingBrief(h.scope, s.id, path, value, t.owner).catch(() => undefined);
    await svc.chooseTitle(h.scope, s.id, "「짐꾼, 다시 탑에 서다」", t.owner);
    expect((await novelSvc().getNovel(h.scope)).title).toBe("짐꾼, 다시 탑에 서다");

    const view = (await svc.getSessionView(h.scope, s.id))!;
    if (!view.canSubmit) {
      // fill whatever the question set still requires
      for (const m of view.progress.missing) await svc.editWorkingBrief(h.scope, s.id, m.path, "테스트 값", t.owner).catch(() => undefined);
    }
    const ready = (await svc.getSessionView(h.scope, s.id))!;
    expect(ready.blockers).toEqual([]);
    await svc.submitForApproval(h.scope, s.id, t.owner);
    script.push({});
    await h.run();
    expect((await h.session()).status).toBe("awaiting_approval");
    // review3 #7: choosing a title while awaiting approval is refused (it would withdraw the approval request)
    await expect(svc.chooseTitle(h.scope, s.id, "다른 제목", t.owner)).rejects.toMatchObject({ code: "title_locked_awaiting_approval" });
    expect((await h.session()).status).toBe("awaiting_approval");
    expect((await svc.getSessionView(h.scope, s.id))!.nextStep).toEqual({ kind: "awaiting_approval", path: null, text: "" });
    await h.decide("approved");
    // review3 visual #3: a closed session has no "next" hint
    expect((await svc.getSessionView(h.scope, s.id))!.nextStep).toEqual({ kind: "closed", path: null, text: "" });
    const n = await novelSvc().getNovel(h.scope);
    expect(n.status).toBe("onboarding");
    expect(n.title).toBe("짐꾼, 다시 탑에 서다");
    expect(n.titleSource).toBe("user");
  });

  it("through the real Claude adapter (scripted API) turn suggestions and a refresh are validated and stored", async () => {
    const app = conceptInternals(conceptSvc());
    const saved = app.ports.modelCalls;
    app.ports.modelCalls = () => t.modules.llm.service.modelCalls;
    try {
      const novel = await novelSvc().createNovel({}, t.owner);
      const h = await conceptHarness(t, novel.id, script);
      t.claude.reply({
        when: { prompt: "사막 도시의 점술사", schemaHas: ["title_suggestions"] },
        json: turn({ title_suggestions: [{ title: "사막의 점술사", reason: "배경+직업" }, { title: "모래가 말하는 미래", reason: "문장형" }, { title: "신기루 점성록", reason: "분위기형" }] }),
      });
      await h.say("사막 도시의 점술사 이야기");
      await h.run();
      expect(t.claude.unmatched).toHaveLength(0);
      expect((await conceptSvc().getSessionView(h.scope))!.titleSuggestions.items).toHaveLength(3);

      await conceptSvc().requestTitleSuggestions(h.scope, (await h.session()).id, t.owner);
      t.claude.reply({
        when: { system: "이전에 추천한 제목", schemaHas: ["suggestions"] },
        json: { suggestions: [{ title: "점술사의 사막", reason: "도치" }, { title: "열사의 예언자", reason: "직설" }, { title: "모래시계 점술관", reason: "키워드" }, { title: "오아시스의 거짓 예언", reason: "훅" }] },
      });
      await h.run();
      expect(t.claude.unmatched).toHaveLength(0);
      const view = (await conceptSvc().getSessionView(h.scope))!;
      expect(view.titleSuggestions.items.map((x) => x.title)).toEqual(["점술사의 사막", "열사의 예언자", "모래시계 점술관", "오아시스의 거짓 예언"]);
    } finally {
      app.ports.modelCalls = saved;
    }
  });
});

describe("title domain helpers", () => {
  it("normalizeTitleSuggestions cleans, dedupes, excludes and caps at 5; < 3 → null", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ title: `제목 ${i}`, reason: " 이유 " }));
    expect(normalizeTitleSuggestions(many)).toHaveLength(5);
    expect(normalizeTitleSuggestions(many)![0]!.reason).toBe("이유");
    expect(normalizeTitleSuggestions([{ title: "가" }, { title: "가 " }, { title: "나" }])).toBeNull();
    expect(normalizeTitleSuggestions([{ title: "가" }, { title: "나" }, { title: "다" }], { exclude: ["가"] })).toBeNull();
  });
  it("hasTitleMaterial needs at least one story field", () => {
    const b = emptyWorkingBrief();
    expect(hasTitleMaterial(b)).toBe(false);
    b.content.seed_notes = "회귀물";
    expect(hasTitleMaterial(b)).toBe(true);
  });
});
