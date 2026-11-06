/**
 * 설계 추가 0015: entity resolver agent — salience filter (pronouns / common nouns), alias memory, exact-name merge,
 * confidence threshold escalation, wording 누구/무엇, normal sensitivity, open-question dedupe, backlog cleanup, setting off.
 * Model responses are scripted (scripted Claude); the resolver answers `resolutions`, the L4 judge `choice`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "@ncs/db/orm";
import { arcs, entities, entityNames, episodes, glossaryTerms, goals, manuscriptVersions, mentions, questions, scenes } from "@ncs/db/schema";
import { newId } from "@ncs/shared";
import type { NovelScope } from "../../src/platform/index.js";
import { createTestCore, type TestCore } from "../support/test-core.js";
import type { ClaudeRequest } from "../support/scripted-claude.js";

let t: TestCore;
beforeAll(async () => {
  t = await createTestCore();
});
afterAll(() => t.close());
beforeEach(() => t.claude.reset());

const isResolve = (r: ClaudeRequest) => !!r.schema && "resolutions" in ((r.schema.properties ?? {}) as object);
const isChoice = (r: ClaudeRequest) => !!r.schema && "choice" in ((r.schema.properties ?? {}) as object);
const run = <T>(fn: Parameters<TestCore["platform"]["uow"]["run"]>[0]) => t.platform.uow.run(fn) as Promise<T>;

interface Novel {
  scope: NovelScope;
  tl: string;
  arcId: string;
}

async function newNovel(opts: { agent?: boolean } = {}): Promise<Novel> {
  const n = await t.modules.novel.service.createNovel({ title: "엔티티 판정 테스트" }, t.owner);
  const scope = { novelId: n.id };
  if (opts.agent === false) {
    const r = await t.http("PATCH", `/api/novels/${n.id}`, { entityAgentResolution: false });
    expect(r.status).toBe(200);
    expect(r.body.entityAgentResolution).toBe(false);
  }
  const tl = (await t.modules.ontology.service.getDefaultTimeline(scope)).id;
  const db = t.testDb.db;
  await db.insert(goals).values({ id: newId("gol"), novelId: n.id, totalEpisodesMin: 10, cadenceEpisodesPerWeek: 3, endingDirection: "끝" });
  const arcId = newId("arc");
  await db.insert(arcs).values({ id: arcId, novelId: n.id, ord: 1, title: "1부", goalText: "g", conflictText: "c", endCondition: "e", plannedEpisodeFrom: 1, plannedEpisodeTo: 10 });
  return { scope, tl, arcId };
}

async function character(nv: Novel, name: string, extra: { disambiguator?: string; status?: "active" | "candidate"; type?: string } = {}): Promise<string> {
  const r = await run<{ entity: { id: string } }>((tx) =>
    t.modules.ontology.service.createEntity(tx, nv.scope, { entityType: (extra.type ?? "character") as never, preferredName: { surface: name }, status: extra.status ?? "active", disambiguator: extra.disambiguator ?? null }, t.owner),
  );
  return r.entity.id;
}

type M = { key: string; surface: string; quote: string; kind: string; hint?: string };

/** one-scene episode + extract_facts with the scripted extraction; runs the dispatcher once */
async function extract(nv: Novel, episodeNo: number, text: string, ms: M[]): Promise<{ mvId: string; taskId: string }> {
  const db = t.testDb.db;
  const epId = newId("epi");
  await db.insert(episodes).values({ id: epId, novelId: nv.scope.novelId, arcId: nv.arcId, episodeNo, primaryTimelineId: nv.tl });
  const mvId = newId("mnv");
  await db.insert(manuscriptVersions).values({ id: mvId, novelId: nv.scope.novelId, episodeId: epId, versionNo: 1, kind: "draft", stage: "drafting", content: text, charCountWithSpaces: text.length, charCountWithoutSpaces: text.length, contentHash: "h", authorActorType: "user", authorActorId: t.ownerId });
  const scId = newId("scn");
  const sp = episodeNo * 1000 + 1;
  await db.insert(scenes).values({ id: scId, novelId: nv.scope.novelId, episodeId: epId, ord: 1, manuscriptVersionId: mvId, charStart: 0, charEnd: text.length, storyPoint: sp, timelineId: nv.tl, summary: "s" });
  t.claude.reply({
    when: { prompt: text, schemaHas: ["mentions", "facts"] },
    json: { mentions: ms.map((m) => ({ local_key: m.key, scene_ord: 1, surface: m.surface, quote: m.quote, mention_kind: m.kind, entity_type_hint: m.hint ?? null })), facts: [] },
  });
  const { taskId } = await run<{ taskId: string }>((tx) =>
    t.modules.orchestration.service.createTask(tx, nv.scope, {
      kind: "extract_facts",
      targetType: "episode",
      targetId: epId,
      episodeId: epId,
      input: { episode_id: epId, manuscript_version_id: mvId, scenes: [{ sceneId: scId, sceneOrd: 1, storyPoint: sp, timelineId: nv.tl, text, charOffset: 0 }] },
      createdBy: t.owner,
    }),
  );
  await until(nv.scope, taskId);
  const task = await t.modules.orchestration.service.getTask(nv.scope, taskId);
  expect(task.latestRun?.errorMessage ?? null).toBeNull();
  expect(task.status).toBe("done");
  return { mvId, taskId };
}

/** dispatcher passes until the task finished (other novels' follow-up tasks share the passes) */
async function until(scope: NovelScope, taskId: string): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const task = await t.modules.orchestration.service.getTask(scope, taskId);
    if (["done", "failed", "cancelled"].includes(task.status)) return;
    await t.modules.orchestration.service.runOnce();
  }
}
async function dedupe(nv: Novel): Promise<void> {
  const { taskId } = await run<{ taskId: string }>((tx) => t.modules.orchestration.service.createTask(tx, nv.scope, { kind: "dedupe_entities", targetType: "novel", targetId: nv.scope.novelId, input: { min_score: 0.5 }, createdBy: t.owner }));
  await until(nv.scope, taskId);
}

const handle = (r: ClaudeRequest, re: RegExp) => re.exec(r.prompt)?.[1] ?? "?";
const entityQs = (scope: NovelScope) => t.testDb.db.select().from(questions).where(and(eq(questions.novelId, scope.novelId), eq(questions.topic, "entity_disambiguation")));
const auditActions = async (scope: NovelScope, prefix: string) =>
  (await t.testDb.query<{ action: string; actor_type: string; actor_id: string; details: unknown }>(`SELECT action, actor_type, actor_id, details FROM activity_log WHERE novel_id = '${scope.novelId}' AND action LIKE '${prefix}%' ORDER BY seq`)) ?? [];

describe("extraction with the entity resolver (setting on, default)", () => {
  it("pronouns and common nouns never become questions or candidate entities; a pronoun links by coreference", async () => {
    const nv = await newNovel();
    const ion = await character(nv, "서이온");
    t.claude.reply({
      when: { schemaHas: ["resolutions"] },
      json: (r: ClaudeRequest) => ({ resolutions: [{ mention: handle(r, /(M\d+) "그"/), action: "link_existing", entity: handle(r, /(E\d+) \| 서이온/), confidence: 0.9, rationale: "앞 문장의 서이온" }] }),
    });
    const { mvId } = await extract(nv, 1, "서이온은 화면을 보았다. 그는 웃었다.", [
      { key: "m1", surface: "서이온", quote: "서이온은 화면을", kind: "named", hint: "character" },
      { key: "m2", surface: "화면", quote: "화면을 보았다", kind: "descriptive", hint: "item" },
      { key: "m3", surface: "그", quote: "그는 웃었다", kind: "pronoun", hint: "character" },
    ]);
    expect(await entityQs(nv.scope)).toHaveLength(0);
    const ents = await t.testDb.db.select().from(entities).where(eq(entities.novelId, nv.scope.novelId));
    expect(ents.map((e) => e.id)).toEqual([ion]);
    const ms = await t.modules.ontology.service.listMentions(nv.scope, { manuscriptVersionId: mvId });
    const by = Object.fromEntries(ms.map((m) => [m.surface, m]));
    expect(by["서이온"]).toMatchObject({ linkStatus: "auto_linked", linkedEntityId: ion });
    expect(by["화면"]!.linkStatus).toBe("rejected");
    expect(by["그"]).toMatchObject({ linkStatus: "auto_linked", linkedEntityId: ion });
    // the exact name needs no L4 model call; one resolver call for the pronoun only
    expect(t.claude.requests.filter(isChoice)).toHaveLength(0);
    expect(t.claude.requests.filter(isResolve)).toHaveLength(1);
    expect(t.claude.requests.find(isResolve)!.prompt).not.toContain('"화면"');
    const audit = await auditActions(nv.scope, "mention.agent_resolved");
    expect(audit.length).toBeGreaterThanOrEqual(2);
    expect(audit.every((a) => a.actor_type === "agent" && a.actor_id === "world_keeper")).toBe(true);
  });

  it("alias memory: '이온 씨' resolved once is linked in the next episode without a question or a model call", async () => {
    const nv = await newNovel();
    const ion = await character(nv, "서이온");
    t.claude.reply({
      when: { schemaHas: ["resolutions"], prompt: '"이온 씨"' },
      json: (r: ClaudeRequest) => ({ resolutions: [{ mention: handle(r, /(M\d+) "이온 씨"/), action: "add_alias", entity: handle(r, /(E\d+) \| 서이온/), confidence: 0.92, rationale: "서이온을 부르는 호칭" }] }),
    });
    const e2 = await extract(nv, 2, "이온 씨가 고개를 끄덕였다.", [{ key: "m1", surface: "이온 씨", quote: "이온 씨가 고개를", kind: "address", hint: "character" }]);
    const [m2] = await t.modules.ontology.service.listMentions(nv.scope, { manuscriptVersionId: e2.mvId });
    expect(m2).toMatchObject({ linkStatus: "auto_linked", linkedEntityId: ion });
    const names = await t.testDb.db.select().from(entityNames).where(eq(entityNames.entityId, ion));
    expect(names.find((n) => n.surface === "이온 씨")).toMatchObject({ status: "active", nameKind: "alias" });

    t.claude.reset();
    const e3 = await extract(nv, 3, "이온 씨는 다시 웃었다.", [{ key: "m1", surface: "이온 씨", quote: "이온 씨는 다시", kind: "address", hint: "character" }]);
    const [m3] = await t.modules.ontology.service.listMentions(nv.scope, { manuscriptVersionId: e3.mvId });
    expect(m3).toMatchObject({ linkStatus: "auto_linked", linkedEntityId: ion });
    expect(t.claude.requests.filter(isResolve)).toHaveLength(0);
    expect(t.claude.requests.filter(isChoice)).toHaveLength(0);
    expect(await entityQs(nv.scope)).toHaveLength(0);
  });

  it("confidence threshold: 0.5 between two established characters → one normal-sensitivity question with the agent's recommendation; 0.9 → linked", async () => {
    const nv = await newNovel();
    const older = await character(nv, "민준", { disambiguator: "형" });
    await character(nv, "민준", { disambiguator: "동생" });
    t.claude.reply({ when: { schemaHas: ["choice"] }, json: { choice: "UNSURE", rationale: "둘 다 가능" }, times: Infinity });
    t.claude.reply({
      when: { schemaHas: ["resolutions"] },
      json: (r: ClaudeRequest) => ({ resolutions: [{ mention: "M1", action: "link_existing", entity: handle(r, /(E\d+) \| 민준\(형\)/), confidence: 0.5, rationale: "형일 가능성이 조금 높음" }] }),
    });
    await extract(nv, 1, "민준이 문을 열었다.", [{ key: "m1", surface: "민준", quote: "민준이 문을", kind: "named", hint: "character" }]);
    const qs = await entityQs(nv.scope);
    expect(qs).toHaveLength(1);
    expect(qs[0]!.sensitivity).toBe("normal");
    expect(qs[0]!.title).toContain("누구인가요");
    const view = await t.modules.hitl.service.getQuestionView(nv.scope, qs[0]!.id);
    const rec = view.options.find((o) => o.isRecommended)!;
    expect((rec.value as { entity_id: string }).entity_id).toBe(older);
    expect(view.body).toContain("신뢰도 0.50");

    // the same contest with 0.9: applied, no new question, audited
    t.claude.reset();
    t.claude.reply({ when: { schemaHas: ["choice"] }, json: { choice: "UNSURE", rationale: "둘 다 가능" }, times: Infinity });
    t.claude.reply({
      when: { schemaHas: ["resolutions"] },
      json: (r: ClaudeRequest) => ({ resolutions: [{ mention: "M1", action: "link_existing", entity: handle(r, /(E\d+) \| 민준\(형\)/), confidence: 0.9, rationale: "형이 집에 있다" }] }),
    });
    const e2 = await extract(nv, 2, "민준이 창을 닫았다.", [{ key: "m1", surface: "민준", quote: "민준이 창을", kind: "named", hint: "character" }]);
    expect(await entityQs(nv.scope)).toHaveLength(1);
    const [m] = await t.modules.ontology.service.listMentions(nv.scope, { manuscriptVersionId: e2.mvId });
    expect(m).toMatchObject({ linkStatus: "auto_linked", linkedEntityId: older });
    const audit = await auditActions(nv.scope, "mention.agent_resolved");
    expect(audit.some((a) => (a.details as { confidence?: number }).confidence === 0.9)).toBe(true);
  });

  it("low confidence on a surface that does not matter is held without a question (and link_mentions does not re-ask it)", async () => {
    const nv = await newNovel();
    t.claude.reply({ when: { schemaHas: ["resolutions"] }, json: { resolutions: [{ mention: "M1", action: "create_entity", entity_type: "place", canonical_name: "검은 탑", confidence: 0.4, rationale: "한 번 나온 배경" }] } });
    const { mvId } = await extract(nv, 1, "멀리 검은 탑이 보였다.", [{ key: "m1", surface: "검은 탑", quote: "검은 탑이 보였다", kind: "descriptive", hint: "place" }]);
    for (const lt of await t.modules.orchestration.service.listTasks(nv.scope, { kinds: ["link_mentions"] })) await until(nv.scope, lt.id); // follow-up
    expect(await entityQs(nv.scope)).toHaveLength(0);
    const [m] = await t.modules.ontology.service.listMentions(nv.scope, { manuscriptVersionId: mvId });
    expect(m!.linkStatus).toBe("ambiguous");
    expect(m!.rationale).toContain("[에이전트 보류]");
  });
});

describe("commit rules (deterministic)", () => {
  it("wording: 무엇 for a place, 누구 for a character; typed new-entity option; high sensitivity without the agent's judgement", async () => {
    const nv = await newNovel();
    const link = t.modules.linking.service;
    const r = await link.linkMentions(nv.scope, {
      manuscriptVersionId: null,
      sourceKind: "user_input",
      anchor: { storyPoint: 4001, timelineId: nv.tl },
      mentions: [
        { surface: "검은 탑", charStart: 0, charEnd: 4, sceneId: "", storyPoint: 4001, mentionKind: "descriptive", entityTypeHint: "place" },
        { surface: "검은 옷의 사내", charStart: 0, charEnd: 7, sceneId: "", storyPoint: 4001, mentionKind: "descriptive", entityTypeHint: "character" },
      ],
    });
    expect(r.questionsNeeded).toHaveLength(2);
    const w = await run<{ questionIds: string[] }>((tx) => link.commitLinkerResult(tx, nv.scope, r, t.owner));
    expect(w.questionIds).toHaveLength(2);
    const qs = await entityQs(nv.scope);
    const place = qs.find((q) => q.title.includes("검은 탑"))!;
    const man = qs.find((q) => q.title.includes("검은 옷의 사내"))!;
    expect(place.title).toBe('4화의 "검은 탑"은(는) 무엇을 가리키나요?');
    expect(man.title).toBe('4화의 "검은 옷의 사내"은(는) 누구인가요?');
    // no resolver recommendation (only the linker's guess) → the autopilot must not answer it
    expect(qs.every((q) => q.sensitivity === "high")).toBe(true);
    const view = await t.modules.hitl.service.getQuestionView(nv.scope, place.id);
    expect(view.options.map((o) => o.label)).toContain("새 장소(새 엔티티)");
    expect(view.options.find((o) => o.label === "새 장소(새 엔티티)")!.value).toEqual({ kind: "new_entity", entity_type: "place" });

    // answering "새 장소" creates a place (not a character)
    const [ch] = await t.testDb.query<{ id: string }>(`SELECT id FROM channels WHERE novel_id = '${nv.scope.novelId}' AND kind = 'web'`);
    const idx = view.options.find((o) => o.label === "새 장소(새 엔티티)")!.optionId;
    await t.modules.hitl.service.acceptAnswer(nv.scope, { questionId: place.id, channelId: ch!.id, responderUserId: t.ownerId, optionIds: [idx], sourceKey: "web:test-place" });
    const created = await t.modules.ontology.service.listEntities(nv.scope, { statuses: ["active"] });
    expect(created.map((e) => [e.preferredName, e.entity.entityType])).toEqual([["검은 탑", "place"]]);
  });

  it("an open question for the same surface absorbs the next mentions; one answer resolves all of them (+ non-entity memory)", async () => {
    const nv = await newNovel();
    const link = t.modules.linking.service;
    const at = (p: number) => ({ manuscriptVersionId: null, sourceKind: "user_input" as const, anchor: { storyPoint: p, timelineId: nv.tl }, mentions: [{ surface: "붉은 문", charStart: 0, charEnd: 4, sceneId: "", storyPoint: p, mentionKind: "descriptive" as const, entityTypeHint: "item" }] });
    const r1 = await link.linkMentions(nv.scope, at(1001));
    const w1 = await run<{ questionIds: string[]; mentionIds: string[] }>((tx) => link.commitLinkerResult(tx, nv.scope, r1, t.owner));
    const r2 = await link.linkMentions(nv.scope, at(2001));
    const w2 = await run<{ questionIds: string[]; mentionIds: string[] }>((tx) => link.commitLinkerResult(tx, nv.scope, r2, t.owner));
    expect(w1.questionIds).toHaveLength(1);
    expect(w2.questionIds).toHaveLength(0);
    const ms = await t.testDb.db.select().from(mentions).where(eq(mentions.novelId, nv.scope.novelId));
    expect(new Set(ms.map((m) => m.questionId))).toEqual(new Set([w1.questionIds[0]]));
    const [ch] = await t.testDb.query<{ id: string }>(`SELECT id FROM channels WHERE novel_id = '${nv.scope.novelId}' AND kind = 'web'`);
    const view = await t.modules.hitl.service.getQuestionView(nv.scope, w1.questionIds[0]!);
    const not = view.options.find((o) => o.label === "엔티티 아님")!.optionId;
    await t.modules.hitl.service.acceptAnswer(nv.scope, { questionId: w1.questionIds[0]!, channelId: ch!.id, responderUserId: t.ownerId, optionIds: [not], sourceKey: "web:test-door" });
    const after = await t.testDb.db.select().from(mentions).where(eq(mentions.novelId, nv.scope.novelId));
    expect(after.map((m) => m.linkStatus)).toEqual(["rejected", "rejected"]);
    const terms = await t.testDb.db.select().from(glossaryTerms).where(eq(glossaryTerms.novelId, nv.scope.novelId));
    expect(terms.map((x) => [x.surface, x.category])).toEqual([["붉은 문", "non_entity"]]);
  });

  it("exact normalized-name duplicates: a same-name candidate merges automatically (dedupe), and a NIL name created meanwhile is reused", async () => {
    const nv = await newNovel();
    const a = await character(nv, "한서윤");
    await character(nv, "한서윤", { status: "candidate" });
    await dedupe(nv);
    const [dt] = await t.modules.orchestration.service.listTasks(nv.scope, { kinds: ["dedupe_entities"] });
    expect(dt?.latestRun?.errorMessage ?? null).toBeNull();
    expect(dt!.status).toBe("done");
    const decs = await t.modules.ontology.service.listIdentityDecisions(nv.scope);
    expect(decs.map((d) => [d.kind, d.status, d.survivorEntityId])).toEqual([["merge", "applied", a]]);
    expect(await t.testDb.db.select().from(questions).where(and(eq(questions.novelId, nv.scope.novelId), eq(questions.topic, "duplicate_entity")))).toHaveLength(0);

    // race: the linker saw no "서이온" (NIL); another episode created it before this commit → linked, not duplicated
    const link = t.modules.linking.service;
    const r = await link.linkMentions(nv.scope, { manuscriptVersionId: null, sourceKind: "user_input", anchor: { storyPoint: 1001, timelineId: nv.tl }, mentions: [{ surface: "서이온", charStart: 0, charEnd: 3, sceneId: "", storyPoint: 1001, entityTypeHint: "character" }] });
    expect(r.newEntities).toHaveLength(1);
    const ion = await character(nv, "서이온");
    const w = await run<{ createdEntityIds: string[]; mentionIds: string[] }>((tx) => link.commitLinkerResult(tx, nv.scope, r, t.owner));
    expect(w.createdEntityIds).toHaveLength(0);
    const [m] = await t.testDb.db.select().from(mentions).where(eq(mentions.id, w.mentionIds[0]!));
    expect(m).toMatchObject({ linkedEntityId: ion, linkStatus: "auto_linked" });
  });
});

describe("backlog cleanup (resolve_entities)", () => {
  it("resolves open world_keeper questions through the answer / cancel paths; low confidence stays open; idempotent", async () => {
    // questions made the old way (setting off), then the agent cleans them up
    const nv = await newNovel({ agent: false });
    const ion = await character(nv, "서이온");
    const minA = await character(nv, "민준", { disambiguator: "형" });
    await character(nv, "민준", { disambiguator: "동생" });
    t.claude.reply({ when: { schemaHas: ["choice"] }, json: { choice: "UNSURE", rationale: "둘 다 가능" }, times: Infinity });
    await extract(nv, 1, "이온 씨가 화면을 보며 그를 불렀다. 민준이 왔다.", [
      { key: "m1", surface: "이온 씨", quote: "이온 씨가 화면을", kind: "address", hint: "character" },
      { key: "m2", surface: "화면", quote: "화면을 보며", kind: "descriptive", hint: "item" },
      { key: "m3", surface: "그", quote: "그를 불렀다", kind: "pronoun", hint: "character" },
      { key: "m4", surface: "민준", quote: "민준이 왔다", kind: "named", hint: "character" },
    ]);
    await extract(nv, 2, "이온 씨는 대답하지 않았다.", [{ key: "m1", surface: "이온 씨", quote: "이온 씨는 대답", kind: "address", hint: "character" }]);
    // a same-name candidate → duplicate_entity question (setting off: asked)
    await character(nv, "한서윤");
    await character(nv, "한서윤", { status: "candidate" });
    await dedupe(nv);
    const before = await t.modules.hitl.service.listQuestions(nv.scope, { statuses: ["pending", "open"] });
    const ed = before.filter((q) => q.topic === "entity_disambiguation");
    // old behaviour: every surface asked, always "누구"
    expect(ed.length).toBe(5);
    expect(ed.every((q) => q.title.includes("누구인가요"))).toBe(true);
    expect(before.some((q) => q.topic === "duplicate_entity")).toBe(true);
    // the first "이온 씨" question was answered with free text → interpretation_confirm child (asked by world_keeper)
    const ionQs = ed.filter((q) => q.title.includes("이온 씨")).sort((x, y) => x.displayNo - y.displayNo);
    const [ch] = await t.testDb.query<{ id: string }>(`SELECT id FROM channels WHERE novel_id = '${nv.scope.novelId}' AND kind = 'web'`);
    t.claude.reply({ when: { schemaHas: ["summary_ko", "changes"] }, json: { status: "proposed", summary_ko: "이온 씨는 서이온입니다.", changes: [] } });
    await t.modules.hitl.service.acceptAnswer(nv.scope, { questionId: ionQs[0]!.id, channelId: ch!.id, responderUserId: t.ownerId, text: "서이온이에요", sourceKey: "web:test-free" });
    for (const it of await t.modules.orchestration.service.listTasks(nv.scope, { kinds: ["interpret_answer"] })) await until(nv.scope, it.id);
    const ic = (await t.modules.hitl.service.listQuestions(nv.scope, { topics: ["interpretation_confirm"], statuses: ["pending", "open"] }))[0];
    expect(ic?.askedByRole).toBe("world_keeper");

    // turn the agent on and run the cleanup from the inbox button's endpoint
    expect((await t.http("PATCH", `/api/novels/${nv.scope.novelId}`, { entityAgentResolution: true })).status).toBe(200);
    t.claude.reset();
    t.claude.reply({
      when: { schemaHas: ["resolutions"] },
      times: Infinity,
      json: (r: ClaudeRequest) => ({
        resolutions: [
          ...(/"이온 씨"/.test(r.prompt) ? [{ mention: handle(r, /(M\d+) "이온 씨"/), action: "add_alias", entity: handle(r, /(E\d+) \| 서이온/), confidence: 0.9, rationale: "서이온을 부르는 호칭" }] : []),
          ...(/"그"/.test(r.prompt) ? [{ mention: handle(r, /(M\d+) "그"/), action: "link_existing", entity: handle(r, /(E\d+) \| 서이온/), confidence: 0.3, rationale: "누군지 불분명" }] : []),
          ...(/"민준"/.test(r.prompt) ? [{ mention: handle(r, /(M\d+) "민준"/), action: "link_existing", entity: handle(r, /(E\d+) \| 민준\(형\)/), confidence: 0.5, rationale: "확신 없음" }] : []),
          // the dedupe pass also paired the two 민준 (same name): different people
          ...[...r.prompt.matchAll(/(M\d+) \[중복 확인\]/g)].map((x) => ({ mention: x[1]!, action: "keep_distinct", confidence: 0.9, rationale: "형과 동생은 다른 인물" })),
        ],
      }),
    });
    const res = await t.http("POST", `/api/novels/${nv.scope.novelId}/linking/resolve-backlog`);
    expect(res.status).toBe(201);
    expect(res.body.openQuestions).toBeGreaterThanOrEqual(6);
    await until(nv.scope, res.body.taskId);
    const task = await t.modules.orchestration.service.getTask(nv.scope, res.body.taskId);
    expect(task.latestRun?.errorMessage ?? null).toBeNull();
    expect(task.status).toBe("done");
    expect(t.claude.requests.filter(isResolve)).toHaveLength(1);

    const all = await t.testDb.db.select().from(questions).where(eq(questions.novelId, nv.scope.novelId));
    const byTitle = (s: string, topic = "entity_disambiguation") => all.filter((q) => q.topic === topic && q.title.includes(s)).sort((x, y) => x.displayNo - y.displayNo);
    // 화면 → answered by the agent ("엔티티 아님")
    expect(byTitle('"화면"')[0]).toMatchObject({ resolutionSource: "agent_resolved" });
    expect(["answered", "resolved"]).toContain(byTitle('"화면"')[0]!.status);
    // duplicate → merged through the registered applier
    const dups = all.filter((q) => q.topic === "duplicate_entity");
    expect(dups.length).toBe(2);
    expect(dups.every((q) => q.resolutionSource === "agent_resolved")).toBe(true);
    const decs = await t.modules.ontology.service.listIdentityDecisions(nv.scope);
    expect(decs.map((d) => `${d.kind}:${d.status}`).sort()).toEqual(["confirm_distinct:applied", "merge:applied", "merge:rejected"].sort());
    // 이온 씨 (no candidate card) → applied directly + closed; the interpretation is closed without a follow-up
    expect(byTitle("이온 씨")[1]!.status).toBe("cancelled");
    expect(byTitle("이온 씨")[1]!.cancelledReason).toMatch(/^에이전트가 정리/);
    expect(all.find((q) => q.topic === "interpretation_confirm")!.status).toBe("cancelled");
    expect(all.filter((q) => q.topic === "followup")).toHaveLength(0);
    const ionMentions = await t.testDb.db.select().from(mentions).where(and(eq(mentions.novelId, nv.scope.novelId), eq(mentions.surface, "이온 씨")));
    expect(ionMentions.map((m) => [m.linkStatus, m.linkedEntityId])).toEqual([
      ["confirmed", ion],
      ["confirmed", ion],
    ]);
    const names = await t.testDb.db.select().from(entityNames).where(eq(entityNames.entityId, ion));
    expect(names.some((n) => n.surface === "이온 씨" && n.status === "active")).toBe(true);
    // 그 (pronoun, unsure) → closed without asking; 민준 (two characters, unsure) → stays open
    expect(byTitle('"그"')[0]!.status).toBe("cancelled");
    expect(["pending", "open"]).toContain(byTitle('"민준"')[0]!.status);
    expect(minA).toBeTruthy();
    // inbox summary shows the agent's work
    const sum = await t.http("GET", `/api/novels/${nv.scope.novelId}/inbox/summary`);
    expect(sum.body.agentResolved).toBeGreaterThanOrEqual(6);
    expect((await auditActions(nv.scope, "question.agent_resolved")).length).toBeGreaterThanOrEqual(6);

    // idempotent: a second run decides nothing new (only the open contested question, still unsure)
    const snapshot = JSON.stringify((await t.testDb.db.select().from(questions).where(eq(questions.novelId, nv.scope.novelId))).map((q) => [q.id, q.status, q.resolutionSource]));
    const res2 = await t.http("POST", `/api/novels/${nv.scope.novelId}/linking/resolve-backlog`);
    expect(res2.status).toBe(201);
    await until(nv.scope, res2.body.taskId);
    const after = JSON.stringify((await t.testDb.db.select().from(questions).where(eq(questions.novelId, nv.scope.novelId))).map((q) => [q.id, q.status, q.resolutionSource]));
    expect(after).toBe(snapshot);
  });
});

describe("review fixes", () => {
  it("a resolver create_entity whose canonical name already exists links to it (no duplicate entity) and remembers the alias", async () => {
    const nv = await newNovel();
    const ion = await character(nv, "서이온");
    t.claude.reply({
      when: { schemaHas: ["resolutions"] },
      json: (r: ClaudeRequest) => ({ resolutions: [{ mention: handle(r, /(M\d+) "이온이"/), action: "create_entity", entity_type: "character", canonical_name: "서이온", confidence: 0.9, rationale: "서이온의 애칭" }] }),
    });
    const { mvId } = await extract(nv, 1, "이온이가 웃었다.", [{ key: "m1", surface: "이온이", quote: "이온이가 웃었다", kind: "named", hint: "character" }]);
    const ents = await t.testDb.db.select().from(entities).where(eq(entities.novelId, nv.scope.novelId));
    expect(ents.map((e) => e.id)).toEqual([ion]);
    const [m] = await t.modules.ontology.service.listMentions(nv.scope, { manuscriptVersionId: mvId });
    expect(m).toMatchObject({ linkedEntityId: ion });
    const names = await t.testDb.db.select().from(entityNames).where(eq(entityNames.entityId, ion));
    expect(names.some((n) => n.surface === "이온이" && n.status === "active")).toBe(true);
  });

  it("backlog: create_entity reuses a same-name entity across questions; low confidence without competing entities is closed, not kept", async () => {
    const nv = await newNovel({ agent: false });
    const link = t.modules.linking.service;
    const ask = async (surface: string, p: number) => {
      const r = await link.linkMentions(nv.scope, { manuscriptVersionId: null, sourceKind: "user_input", anchor: { storyPoint: p, timelineId: nv.tl }, mentions: [{ surface, charStart: 0, charEnd: surface.length, sceneId: "", storyPoint: p, mentionKind: "descriptive", entityTypeHint: "place" }] });
      const ids = (await run<{ questionIds: string[] }>((tx) => link.commitLinkerResult(tx, nv.scope, r, t.owner))).questionIds;
      for (const id of ids) await t.testDb.db.update(questions).set({ askedByRole: "world_keeper" }).where(eq(questions.id, id)); // as an extraction asks
      return ids;
    };
    expect(await ask("판정소", 1001)).toHaveLength(1);
    expect(await ask("판정소", 2001)).toHaveLength(1);
    expect(await ask("재활 센터", 2001)).toHaveLength(1);
    // the place appeared meanwhile as a candidate entity (e.g. another episode's extraction)
    const existing = await character(nv, "판정소", { type: "place", status: "candidate" });

    expect((await t.http("PATCH", `/api/novels/${nv.scope.novelId}`, { entityAgentResolution: true })).status).toBe(200);
    const count = await t.http("GET", `/api/novels/${nv.scope.novelId}/linking/backlog`);
    expect(count.body.openQuestions).toBe(3);
    t.claude.reset();
    t.claude.reply({
      when: { schemaHas: ["resolutions"] },
      times: Infinity,
      json: (r: ClaudeRequest) => ({
        resolutions: [
          ...(/"판정소"/.test(r.prompt) ? [{ mention: handle(r, /(M\d+) "판정소"/), action: "create_entity", entity_type: "place", canonical_name: "판정소", confidence: 0.9, rationale: "반복되는 장소" }] : []),
          ...(/"재활 센터"/.test(r.prompt) ? [{ mention: handle(r, /(M\d+) "재활 센터"/), action: "ignore", confidence: 0.55, rationale: "배경 묘사로 보임" }] : []),
        ],
      }),
    });
    const res = await t.http("POST", `/api/novels/${nv.scope.novelId}/linking/resolve-backlog`);
    expect(res.status).toBe(201);
    await until(nv.scope, res.body.taskId);
    const task = await t.modules.orchestration.service.getTask(nv.scope, res.body.taskId);
    expect(task.latestRun?.errorMessage ?? null).toBeNull();

    const places = (await t.testDb.db.select().from(entities).where(eq(entities.novelId, nv.scope.novelId))).filter((e) => e.entityType === "place" && e.status !== "merged" && e.status !== "retired");
    expect(places.map((e) => e.id)).toEqual([existing]);
    const ms = await t.testDb.db.select().from(mentions).where(and(eq(mentions.novelId, nv.scope.novelId), eq(mentions.surface, "판정소")));
    expect(ms.map((m) => m.linkedEntityId)).toEqual([existing, existing]);
    const all = await t.testDb.db.select().from(questions).where(eq(questions.novelId, nv.scope.novelId));
    const rehab = all.find((q) => q.title.includes("재활 센터"))!;
    expect(rehab.status).toBe("cancelled");
    expect(rehab.cancelledReason).toMatch(/^에이전트가 정리/);
    expect(all.filter((q) => q.status === "pending" || q.status === "open")).toHaveLength(0);
    expect((await t.http("GET", `/api/novels/${nv.scope.novelId}/linking/backlog`)).body.openQuestions).toBe(0);
  });

  it("dedupe: two people sharing only an alias are not auto-merged (only identical representative names are)", async () => {
    const nv = await newNovel();
    const a = await character(nv, "강도윤");
    const b = await character(nv, "류하", { status: "candidate" });
    for (const id of [a, b]) await run((tx) => t.modules.ontology.service.addEntityName(tx, nv.scope, id, { surface: "판정관", nameKind: "alias", status: "active" }, t.owner));
    await dedupe(nv);
    const decs = await t.modules.ontology.service.listIdentityDecisions(nv.scope);
    expect(decs.filter((d) => d.status === "applied")).toHaveLength(0);
    const ents = await t.testDb.db.select().from(entities).where(eq(entities.novelId, nv.scope.novelId));
    expect(ents.every((e) => e.status !== "merged")).toBe(true);
  });

  it("setting off: an old-path entity question is high sensitivity (the autopilot never answers the linker's guess)", async () => {
    const nv = await newNovel({ agent: false });
    const link = t.modules.linking.service;
    const r = await link.linkMentions(nv.scope, { manuscriptVersionId: null, sourceKind: "user_input", anchor: { storyPoint: 1001, timelineId: nv.tl }, mentions: [{ surface: "검은 탑", charStart: 0, charEnd: 4, sceneId: "", storyPoint: 1001, mentionKind: "descriptive", entityTypeHint: "place" }] });
    await run((tx) => link.commitLinkerResult(tx, nv.scope, r, t.owner));
    const qs = await entityQs(nv.scope);
    expect(qs.length).toBeGreaterThan(0);
    expect(qs.every((q) => q.sensitivity === "high")).toBe(true);
  });
});

describe("setting off → old behaviour", () => {
  it("asks about every unresolved surface (incl. pronouns and common nouns) with the old wording; no resolver call", async () => {
    const nv = await newNovel({ agent: false });
    await extract(nv, 1, "멀리 화면이 켜졌다. 그가 왔다.", [
      { key: "m1", surface: "화면", quote: "화면이 켜졌다", kind: "descriptive", hint: "item" },
      { key: "m2", surface: "그", quote: "그가 왔다", kind: "pronoun", hint: "character" },
    ]);
    const qs = await entityQs(nv.scope);
    expect(qs).toHaveLength(2);
    expect(qs.every((q) => q.title.endsWith("누구인가요?"))).toBe(true);
    const view = await t.modules.hitl.service.getQuestionView(nv.scope, qs[0]!.id);
    expect(view.options.map((o) => o.label)).toContain("새 인물(새 엔티티)");
    expect(t.claude.requests.filter(isResolve)).toHaveLength(0);
  });
});
