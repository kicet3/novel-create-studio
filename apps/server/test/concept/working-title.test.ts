/**
 * 설계 추가: 컨셉 대화가 작품 가제를 자동으로 붙인다(title_source provisional → auto),
 * 사용자가 정한 제목(title_source=user)은 대화가 바꾸지 않는다.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { conceptInternals } from "../../src/modules/concept/module.js";
import { cleanTitle } from "../../src/modules/concept/application/concept-app.js";
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
const turn = (working_title: unknown, extra: Record<string, unknown> = {}) => ({ reply_text: "좋아요. 다음을 정해 볼까요?", working_title, ...extra });

describe("working title from the concept conversation", () => {
  it("a new untitled novel starts provisional; the model's working title replaces it (auto) and is announced", async () => {
    const novel = await novelSvc().createNovel({}, t.owner);
    expect(novel.title).toBe("제목 미정");
    expect(novel.titleSource).toBe("provisional");
    const h = await conceptHarness(t, novel.id, script);

    script.push(turn({ title: "『회귀한 짐꾼은 탑을 오른다』", reason: "회귀 + 짐꾼 주인공" }));
    await h.say("회귀한 짐꾼이 탑을 오르는 이야기");
    await h.run();
    let n = await novelSvc().getNovel(h.scope);
    expect(n.title).toBe("회귀한 짐꾼은 탑을 오른다");
    expect(n.titleSource).toBe("auto");
    expect((await h.lastAgent()).body).toContain("가제를 『회귀한 짐꾼은 탑을 오른다』");

    // the conversation can improve the working title while it is still auto
    script.push(turn({ title: "짐꾼 회귀자의 탑 공략", reason: "" }));
    await h.say("주인공은 동료에게 배신당하고 회귀해요");
    await h.run();
    n = await novelSvc().getNovel(h.scope);
    expect(n.title).toBe("짐꾼 회귀자의 탑 공략");

    // same title again → no new audit row, no announcement
    script.push(turn({ title: "짐꾼 회귀자의 탑 공략", reason: "" }));
    await h.say("결말은 해피엔딩");
    await h.run();
    expect((await h.lastAgent()).body).not.toContain("가제를");
    const events = (await t.modules.audit.service.list(h.scope, { actionPrefix: "novel.settings_changed", limit: 50 })).items;
    expect(events.filter((e) => (e.details as { source?: string } | null)?.source === "concept_working_title")).toHaveLength(2);

    // null / placeholder titles never apply
    script.push(turn(null), turn({ title: "제목 미정" }));
    await h.say("톤은 진지하게");
    await h.run();
    await h.say("분량은 길게");
    await h.run();
    expect((await novelSvc().getNovel(h.scope)).title).toBe("짐꾼 회귀자의 탑 공략");
  });

  it("a user-set title is never replaced by the conversation", async () => {
    const novel = await novelSvc().createNovel({ title: "내 작품" }, t.owner);
    expect(novel.titleSource).toBe("user");
    const h = await conceptHarness(t, novel.id, script);
    script.push(turn({ title: "AI가 지은 제목", reason: "" }));
    await h.say("회귀물 이야기");
    await h.run();
    const n = await novelSvc().getNovel(h.scope);
    expect(n.title).toBe("내 작품");
    expect(n.titleSource).toBe("user");
    expect((await h.lastAgent()).body).not.toContain("가제를");
  });

  it("settings: unchanged title does not confirm an auto title; a change or confirmTitle does", async () => {
    const novel = await novelSvc().createNovel({}, t.owner);
    const h = await conceptHarness(t, novel.id, script);
    script.push(turn({ title: "북부 성채의 마지막 기사", reason: "" }));
    await h.say("북부 성채 기사 이야기");
    await h.run();
    const scope = h.scope;
    let n = await novelSvc().updateSettings(scope, { title: "북부 성채의 마지막 기사", timezone: "Asia/Tokyo" }, t.owner);
    expect(n.titleSource).toBe("auto");
    n = await novelSvc().updateSettings(scope, { confirmTitle: true }, t.owner);
    expect(n.titleSource).toBe("user");
    expect(n.title).toBe("북부 성채의 마지막 기사");
    script.push(turn({ title: "다른 가제", reason: "" }));
    await h.say("주인공은 막내 기사");
    await h.run();
    expect((await novelSvc().getNovel(scope)).title).toBe("북부 성채의 마지막 기사");

    const other = await novelSvc().createNovel({}, t.owner);
    const changed = await novelSvc().updateSettings({ novelId: other.id }, { title: "직접 정한 제목" }, t.owner);
    expect(changed.titleSource).toBe("user");
  });

  it("through the real llm module (Claude adapter → scripted API) the model's working title is applied", async () => {
    const app = conceptInternals(t.modules.concept.service);
    const saved = app.ports.modelCalls;
    app.ports.modelCalls = () => t.modules.llm.service.modelCalls;
    try {
      const novel = await novelSvc().createNovel({}, t.owner);
      const h = await conceptHarness(t, novel.id, script);
      t.claude.reply({ when: { prompt: "회귀한 짐꾼 이야기", schemaHas: ["working_title"] }, json: turn({ title: "「짐꾼, 다시 탑에 서다」", reason: "회귀 + 짐꾼" }) });
      await h.say("회귀한 짐꾼 이야기");
      await h.run();
      expect(t.claude.unmatched).toHaveLength(0);
      const n = await novelSvc().getNovel(h.scope);
      expect(n.titleSource).toBe("auto");
      expect(n.title).toBe("짐꾼, 다시 탑에 서다");
    } finally {
      app.ports.modelCalls = saved;
    }
  });

  it("cleanTitle strips quotes/brackets and rejects placeholders", () => {
    expect(cleanTitle("  「검은 탑」 ")).toBe("검은 탑");
    expect(cleanTitle('"회귀자"')).toBe("회귀자");
    expect(cleanTitle("제목 미정")).toBeNull();
    expect(cleanTitle("")).toBeNull();
    expect(cleanTitle(42)).toBeNull();
  });
});
