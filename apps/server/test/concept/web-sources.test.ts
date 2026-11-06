/**
 * 설계 추가 0011 (인터넷 검색): a concept turn may search the web (novel setting, default on); the reply keeps the
 * sources it used (`concept_messages.sources`, footnote "출처" in the web) and the messages API returns them.
 * Real gateway → real Claude adapter → scripted Messages API with a server-side web search (no network).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { conceptInternals } from "../../src/modules/concept/module.js";
import { sourcesFootnote } from "../../src/modules/concept/application/concept-app.js";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { conceptHarness, installConceptStubs } from "./support.js";

let t: TestCore;
beforeAll(async () => {
  t = await createTestCore();
  installConceptStubs(t);
  conceptInternals(t.modules.concept.service).ports.modelCalls = () => t.modules.llm.service.modelCalls;
});
afterAll(() => t.close());

const GENRE_Q = { slot_key: "category.genre_label", ask_text: "장르는요?", options: [] };
const SRC = { url: "https://encykorea.aks.ac.kr/Article/E0060135", title: "포도대장 - 한국민족문화대백과사전" };

describe("concept turn web sources", () => {
  it("a searching reply stores its sources; with the setting off the request has no search tool and no sources", async () => {
    const novel = await t.modules.novel.service.createNovel({}, t.owner);
    const h = await conceptHarness(t, novel.id, []);
    const s = await h.session();
    const base = `/api/novels/${novel.id}/concept/sessions/${s.id}`;

    t.claude.reply({
      when: { schemaHas: ["reply_text"] },
      json: { reply_text: "포도청은 조선의 치안 관청이고 책임자는 포도대장이었어요. 주인공은 어떤 직책인가요?", questions: [GENRE_Q], user_intent: "answer" },
      webSearch: { query: "조선 포도청 직책", results: [SRC] },
    });
    expect((await t.http("POST", `${base}/messages`, { body: "조선 포도청 종사관이 주인공인 수사극" })).status).toBe(201);
    await h.run();
    expect(t.claude.unmatched).toHaveLength(0);
    const req = t.claude.requests[t.claude.requests.length - 1]!;
    expect(req.body.tools).toEqual([{ type: "web_search_20260209", name: "web_search", max_uses: 3 }]);
    // the model forms its own queries: the user's message is never sent as a query by the app
    expect(JSON.stringify(req.body.tools)).not.toContain("종사관이 주인공");
    const agent = await h.lastAgent();
    expect(agent.sources).toEqual([{ url: SRC.url, title: SRC.title, retrievedAt: expect.stringMatching(/^\d{4}-/) }]);
    const listed = await t.http("GET", `${base}/messages`);
    const shown = listed.body.items.find((m: { id: string }) => m.id === agent.id);
    expect(shown.sources[0].url).toBe(SRC.url);

    // setting off → no tool, no sources
    await t.modules.novel.service.updateSettings({ novelId: novel.id }, { webSearchEnabled: false }, t.owner);
    t.claude.reply({ when: { schemaHas: ["reply_text"] }, json: { reply_text: "검색 없이 이어 갈게요.", questions: [GENRE_Q] } });
    expect((await t.http("POST", `${base}/messages`, { body: "주인공은 종사관이에요" })).status).toBe(201);
    await h.run();
    expect(t.claude.requests[t.claude.requests.length - 1]!.body.tools).toBeUndefined();
    expect((await h.lastAgent()).sources).toBeNull();
  });

  it("messenger copy lists at most five sources as a footnote", () => {
    expect(sourcesFootnote(null)).toBe("");
    const many = Array.from({ length: 7 }, (_, i) => ({ url: `https://s${i}.example`, title: i === 0 ? null : `출처 ${i}`, retrievedAt: "2026-11-06T00:00:00Z" }));
    const f = sourcesFootnote(many);
    expect(f.startsWith("\n\n출처\n1. https://s0.example\n2. 출처 1 — https://s1.example")).toBe(true);
    expect(f.split("\n").filter((l) => /^\d\./.test(l))).toHaveLength(5);
  });
});
