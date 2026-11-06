import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "@ncs/db/orm";
import { arcs, channels, conceptBriefs, conceptSessions, entities, episodes, facts, goals, manuscriptVersions, mentions, questions, scenes, seriesBibles } from "@ncs/db/schema";
import { newId } from "@ncs/shared";
import type { NovelScope } from "../../src/platform/index.js";
import type { LinkingService } from "../../src/modules/linking/index.js";
import type { OntologyService } from "../../src/modules/ontology/index.js";
import { decide, ruleJudge, ruleScore, sceneConsistency, type LinkCandidate } from "../../src/modules/linking/domain/linker.js";
import { dictionaryMentions, parseBibleContent, repairOffsets } from "../../src/modules/linking/domain/text.js";
import { thresholds } from "../../src/modules/linking/application/linker.js";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { G01, G03, G18 } from "./golden.js";

let t: TestCore;
let onto: OntologyService;
let link: LinkingService;
beforeAll(async () => {
  t = await createTestCore();
  onto = t.modules.ontology.service;
  link = t.modules.linking.service;
});
afterAll(() => t.close());

async function newNovel(): Promise<{ scope: NovelScope; tl: string }> {
  const n = await t.modules.novel.service.createNovel({ title: "링킹 테스트" }, t.owner);
  return { scope: { novelId: n.id }, tl: (await onto.getDefaultTimeline({ novelId: n.id })).id };
}
const run = <T>(fn: Parameters<TestCore["platform"]["uow"]["run"]>[0]) => t.platform.uow.run(fn) as Promise<T>;

describe("linker domain (pure)", () => {
  const th = thresholds();
  const cand = (id: string, f: Partial<LinkCandidate["features"]> = {}): LinkCandidate => {
    const features = { matchKind: "exact" as const, baseScore: 1, ...f };
    return { entityId: id, label: id, features, ruleScore: ruleScore(features, th.hiddenVariantCap) };
  };
  it("auto-links a unanimous single exact candidate; asks when two candidates compete (P-1)", () => {
    const one = [cand("A")];
    expect(decide({ mentionKind: "named", sourceKind: "manuscript", candidates: one, truncated: false, votes: [ruleJudge(one)] }, th)).toMatchObject({ linkStatus: "auto_linked", linkedEntityId: "A" });
    const two = [cand("A"), cand("B")];
    const d = decide({ mentionKind: "named", sourceKind: "manuscript", candidates: two, truncated: false, votes: [ruleJudge(two)] }, th);
    expect(d).toMatchObject({ linkStatus: "ambiguous", followUp: "question" });
  });
  it("never auto-links confusable, hidden-variant-capped, descriptive or zero mentions", () => {
    const c = [cand("A", { confusable: true })];
    expect(decide({ mentionKind: "named", sourceKind: "manuscript", candidates: c, truncated: false, votes: [{ kind: "entity", entityId: "A" }] }, th).linkStatus).toBe("ambiguous");
    const hv = [cand("A", { hiddenVariant: true })];
    expect(decide({ mentionKind: "named", sourceKind: "manuscript", candidates: hv, truncated: false, votes: [{ kind: "entity", entityId: "A" }] }, th).linkStatus).toBe("ambiguous");
    expect(decide({ mentionKind: "descriptive", sourceKind: "manuscript", candidates: [cand("A")], truncated: false, votes: [{ kind: "entity", entityId: "A" }] }, th).linkStatus).toBe("ambiguous");
    expect(decide({ mentionKind: "zero", sourceKind: "manuscript", candidates: [cand("A")], truncated: false, votes: [{ kind: "entity", entityId: "A" }] }, th)).toMatchObject({ linkStatus: "ambiguous", followUp: "report" });
    expect(decide({ mentionKind: "descriptive", sourceKind: "manuscript", candidates: [cand("A")], truncated: false, votes: [{ kind: "NON_ENTITY" }] }, th).linkStatus).toBe("rejected");
    expect(decide({ mentionKind: "named", sourceKind: "manuscript", candidates: [], truncated: false, votes: [{ kind: "NIL" }] }, th)).toMatchObject({ linkStatus: "new_entity_candidate", followUp: "new_entity" });
  });
  it("L8 demotes a chain linked to different entities", () => {
    const base = decide({ mentionKind: "named", sourceKind: "manuscript", candidates: [cand("A")], truncated: false, votes: [{ kind: "entity", entityId: "A" }] }, th);
    const items = sceneConsistency([
      { chainKey: "c1", sceneId: "s", decision: base },
      { chainKey: "c1", sceneId: "s", decision: { ...base, linkedEntityId: "B" } },
    ]);
    expect(items.map((i) => i.decision.linkStatus)).toEqual(["ambiguous", "ambiguous"]);
  });
  it("text helpers: offset repair, dictionary L0, bible parse", () => {
    expect(repairOffsets("레온은 웃었다", { char_start: 5, char_end: 7, surface: "레온" })).toEqual({ start: 0, end: 2 });
    expect(repairOffsets("레온과 레온", { char_start: 9, char_end: 10, surface: "레온" })).toBeNull();
    expect(dictionaryMentions("폐하께서 레온아, 하고 불렀다. 흑레온은 아니다.", [{ surface: "레온", nameKind: "true_name", entityType: "character" }, { surface: "폐하", nameKind: "title", entityType: "title" }]).map((m) => [m.surface, m.mentionKind])).toEqual([
      ["폐하", "title"],
      ["레온", "named"],
    ]);
    const b = parseBibleContent({ characters: [{ name: "레온", aliases: ["레오"], gender: "남", character_key: "chr_1" }], places: ["왕도"], world_rules: ["마나는 순환한다"] });
    expect(b.entities.map((e) => [e.entity_type, e.name])).toEqual([
      ["character", "레온"],
      ["place", "왕도"],
      ["rule", "마나는 순환한다"],
    ]);
    expect(b.facts.map((f) => f.predicate)).toEqual(["gender", "rule_statement"]);
  });
});

describe("golden seeds (deterministic, 06 §12.2)", () => {
  it("G01 칭호 승계: '폐하' resolves to the holder at each story point, via_entity_id = title", async () => {
    const { scope, tl } = await newNovel();
    const seed = await G01.load(t, scope, tl);
    const r = await link.linkMentions(scope, { manuscriptVersionId: null, sourceKind: "user_input", anchor: { storyPoint: 0, timelineId: tl }, mentions: G01.mentions(tl) });
    expect(r.mentions.map((m) => [m.storyPoint, m.linkStatus, m.linkedEntityId, m.viaEntityId])).toEqual(G01.expected(seed));
    const w = await run<{ mentionIds: string[] }>((tx) => link.commitLinkerResult(tx, scope, r, t.owner));
    expect(w.mentionIds).toHaveLength(2);
  });

  it("G03 동명 가문: same-name houses stay separate — mention asks, dedupe proposes but never merges", async () => {
    const { scope, tl } = await newNovel();
    const seed = await G03.load(t, scope, tl);
    const r = await link.linkMentions(scope, { manuscriptVersionId: null, sourceKind: "user_input", anchor: { storyPoint: 3001, timelineId: tl }, mentions: G03.mentions() });
    expect(r.mentions[0]!.linkStatus).toBe("ambiguous");
    expect(r.mentions[0]!.candidates.map((c) => c.entityId).sort()).toEqual([seed.main, seed.branch].sort());
    expect(r.questionsNeeded).toHaveLength(1);
    const w = await run<{ questionIds: string[]; mentionIds: string[] }>((tx) => link.commitLinkerResult(tx, scope, r, t.owner));
    expect(w.questionIds).toHaveLength(1);
    const [q] = await t.testDb.db.select().from(questions).where(eq(questions.id, w.questionIds[0]!));
    expect(q!.topic).toBe("entity_disambiguation");
    // dedupe: same name only (0.5) < 0.75 → no proposal; both stay active
    const dups = await onto.findDuplicateCandidates(scope);
    expect(dups.every((d) => d.score < 0.75)).toBe(true);
    const ents = await t.testDb.db.select().from(entities).where(and(eq(entities.novelId, scope.novelId), eq(entities.entityType, "organization")));
    expect(ents.map((e) => e.status)).toEqual(["active", "active"]);
    // answering the question confirms the main house (entity_disambiguation applier)
    const [ch] = await t.testDb.db.select().from(channels).where(eq(channels.novelId, scope.novelId));
    await t.modules.hitl.service.openFromWeb(scope, q!.id, t.owner).catch(() => undefined);
    const options = await t.modules.hitl.service.getQuestionView(scope, q!.id);
    const mainIdx = (options as unknown as { options: Array<{ label: string }> }).options.findIndex((o) => o.label.includes("본가"));
    expect(mainIdx).toBeGreaterThanOrEqual(0);
    const optId = (options as unknown as { options: Array<{ id?: string; idx?: number }> }).options[mainIdx]!;
    await t.modules.hitl.service.acceptAnswer(scope, { questionId: q!.id, channelId: ch!.id, responderUserId: t.ownerId, optionIds: [String(optId.id ?? optId.idx ?? mainIdx)], sourceKey: "web:test-g03" });
    const [m] = await t.testDb.db.select().from(mentions).where(eq(mentions.id, w.mentionIds[0]!));
    expect(m).toMatchObject({ linkStatus: "confirmed", linkedEntityId: seed.main });
  });

  it("G18 스키마 위반: CR-09 / CR-11 findings for the seeded facts", async () => {
    const { scope, tl } = await newNovel();
    await G18.load(t, scope, tl);
    const v = await onto.findSchemaViolations(scope);
    const keys = v.map((x) => `${x.crRule}:${x.schemaRuleKey}`).sort();
    expect(keys).toHaveLength(G18.expected.length);
    for (const re of G18.expected) expect(keys.some((k) => re.test(k))).toBe(true);
  });
});

describe("NIL → candidate entity → activation (EN1, EN3(b), MN3/MN7)", () => {
  it("creates a candidate entity for an unknown name, passes the equivalence check, activates on promotion", async () => {
    const { scope, tl } = await newNovel();
    const r = await link.linkMentions(scope, { manuscriptVersionId: null, sourceKind: "user_input", anchor: { storyPoint: 2001, timelineId: tl }, mentions: [{ surface: "카이렌", charStart: 0, charEnd: 3, sceneId: "", storyPoint: 2001 }] });
    expect(r.newEntities).toHaveLength(1);
    const w = await run<{ createdEntityIds: string[]; mentionIds: string[] }>((tx) => link.commitLinkerResult(tx, scope, r, t.owner));
    const id = w.createdEntityIds[0]!;
    const e = await onto.getEntity(scope, id);
    expect(e.status).toBe("candidate");
    expect((e.equivalenceCheck as { status: string }).status).toBe("passed");
    await run((tx) =>
      onto.writeCandidateFacts(tx, scope, [{ factKind: "attribute", subjectEntityId: id, predicate: "gender", value: "여", timelineId: tl, storyRange: { from: 2001, to: null }, sourceKind: "user_input", source: { refType: "novel", refId: scope.novelId }, mentionIds: w.mentionIds, episodeId: "epi_NIL" }], t.owner),
    );
    const p = await run<{ promoted: number }>((tx) => onto.promoteEpisodeFacts(tx, scope, "epi_NIL", "approved", t.owner));
    expect(p.promoted).toBe(1);
    expect((await onto.getEntity(scope, id)).status).toBe("active");
    const [m] = await t.testDb.db.select().from(mentions).where(eq(mentions.id, w.mentionIds[0]!));
    expect(m!.linkStatus).toBe("auto_linked");
  });

  it("a near-duplicate new name triggers a duplicate_entity question + proposed merge", async () => {
    const { scope, tl } = await newNovel();
    await run((tx) => onto.createEntity(tx, scope, { entityType: "character", preferredName: { surface: "아이언하트" }, status: "active" }, t.owner));
    const r = await link.linkMentions(scope, { manuscriptVersionId: null, sourceKind: "user_input", anchor: { storyPoint: 1001, timelineId: tl }, mentions: [{ surface: "아이언하드", charStart: 0, charEnd: 5, sceneId: "", storyPoint: 1001 }] });
    // jamo distance 1 on a 5-syllable name is a 2nd-pass candidate, not NIL: the mention asks instead
    expect(r.mentions[0]!.linkStatus).toBe("ambiguous");
    const r2 = await link.linkMentions(scope, { manuscriptVersionId: null, sourceKind: "user_input", anchor: { storyPoint: 1001, timelineId: tl }, mentions: [{ surface: "Iron Hart", charStart: 0, charEnd: 9, sceneId: "", storyPoint: 1001 }] });
    expect(r2.mentions[0]!.candidates.length).toBeGreaterThan(0);
  });
});

describe("tasks via orchestration (scripted Claude responses)", () => {
  async function seedPipeline(scope: NovelScope, tl: string) {
    const db = t.testDb.db;
    await db.insert(goals).values({ id: newId("gol"), novelId: scope.novelId, totalEpisodesMin: 10, cadenceEpisodesPerWeek: 3, endingDirection: "끝" });
    const arcId = newId("arc");
    await db.insert(arcs).values({ id: arcId, novelId: scope.novelId, ord: 1, title: "1부", goalText: "g", conflictText: "c", endCondition: "e", plannedEpisodeFrom: 1, plannedEpisodeTo: 10 });
    const epId = newId("epi");
    await db.insert(episodes).values({ id: epId, novelId: scope.novelId, arcId, episodeNo: 3, primaryTimelineId: tl });
    const text = "레온은 왕도로 향했다. 폐하가 그를 불렀다.";
    const mvId = newId("mnv");
    await db.insert(manuscriptVersions).values({ id: mvId, novelId: scope.novelId, episodeId: epId, versionNo: 1, kind: "draft", stage: "drafting", content: text, charCountWithSpaces: text.length, charCountWithoutSpaces: text.length, contentHash: "h", authorActorType: "user", authorActorId: t.ownerId });
    const scId = newId("scn");
    await db.insert(scenes).values({ id: scId, novelId: scope.novelId, episodeId: epId, ord: 1, manuscriptVersionId: mvId, charStart: 0, charEnd: text.length, storyPoint: 3001, timelineId: tl, summary: "s" });
    return { epId, mvId, scId, text };
  }

  it("extract_facts: dictionary L0 + linker → mentions with FK to the version/scene", async () => {
    const { scope, tl } = await newNovel();
    const leon = (await run<{ entity: { id: string } }>((tx) => onto.createEntity(tx, scope, { entityType: "character", preferredName: { surface: "레온" }, status: "active" }, t.owner))).entity.id;
    await run((tx) => onto.createEntity(tx, scope, { entityType: "place", preferredName: { surface: "왕도" }, status: "active" }, t.owner));
    const { epId, mvId, scId, text } = await seedPipeline(scope, tl);
    // the model's L0 extraction for "레온은 왕도로 향했다. 폐하가 그를 불렀다." (scene 1)
    t.claude.reply({
      when: { prompt: "레온은 왕도로 향했다", schemaHas: ["mentions", "facts"] },
      json: {
        mentions: [
          { local_key: "m1", scene_ord: 1, char_start: 0, char_end: 2, surface: "레온", mention_kind: "named", entity_type_hint: "character" },
          { local_key: "m2", scene_ord: 1, char_start: 4, char_end: 6, surface: "왕도", mention_kind: "named", entity_type_hint: "place" },
        ],
        facts: [{ local_key: "f1", fact_kind: "state", subject_mention_key: "m1", predicate: "life_status", value: "alive", scope_hint: "from_here" }],
      },
    });
    // L4: the model picks the (only) candidate card for each surface
    t.claude.reply(
      { when: { prompt: '표기: "레온"', schemaHas: ["choice"] }, json: { choice: "C1", rationale: "문맥상 주인공 레온" } },
      { when: { prompt: '표기: "왕도"', schemaHas: ["choice"] }, json: { choice: "C1", rationale: "왕도는 하나뿐" } },
    );
    await run((tx) =>
      t.modules.orchestration.service.createTask(tx, scope, {
        kind: "extract_facts",
        targetType: "episode",
        targetId: epId,
        episodeId: epId,
        input: { episode_id: epId, manuscript_version_id: mvId, scenes: [{ sceneId: scId, sceneOrd: 1, storyPoint: 3001, timelineId: tl, text, charOffset: 0 }] },
        createdBy: t.owner,
      }),
    );
    await t.modules.orchestration.service.runOnce();
    const tasks = await t.modules.orchestration.service.listTasks(scope, { kinds: ["extract_facts"] });
    expect(tasks[0]!.status).toBe("done");
    const ms = await onto.listMentions(scope, { manuscriptVersionId: mvId });
    const byS = Object.fromEntries(ms.map((m) => [m.surface, m]));
    expect(byS["레온"]).toMatchObject({ linkStatus: "auto_linked", linkedEntityId: leon, sceneId: scId, charStart: 0, charEnd: 2 });
    expect(byS["왕도"]!.linkStatus).toBe("auto_linked");
    expect(t.claude.unmatched).toHaveLength(0);
    // the scripted fact on the linked character becomes a candidate fact → the fact chain carries data
    const rows = await t.testDb.query<{ predicate: string; subject_entity_id: string; canon_status: string }>(`SELECT predicate, subject_entity_id, canon_status FROM facts WHERE novel_id = '${scope.novelId}' AND source_kind = 'manuscript'`);
    expect(rows).toEqual([{ predicate: "life_status", subject_entity_id: leon, canon_status: "candidate" }]);
  });

  it("build_initial_ontology → approveBibleFacts makes bible entities active and facts canon (INV-BIB-03)", async () => {
    const { scope, tl } = await newNovel();
    const db = t.testDb.db;
    await db.insert(goals).values({ id: newId("gol"), novelId: scope.novelId, totalEpisodesMin: 10, cadenceEpisodesPerWeek: 3, endingDirection: "끝" });
    const [session] = await db.select().from(conceptSessions).where(eq(conceptSessions.novelId, scope.novelId));
    const briefId = newId("cbf");
    await db.insert(conceptBriefs).values({ id: briefId, novelId: scope.novelId, sessionId: session!.id, versionNo: 1, authorActorType: "user", authorActorId: t.ownerId, entryMode: "conversation", questionSetVersion: "common@1", content: {}, contentMd: "# 컨셉" });
    const bibleId = newId("bib");
    await db.insert(seriesBibles).values({
      id: bibleId,
      novelId: scope.novelId,
      versionNo: 1,
      logline: "l",
      synopsis: "s",
      contentMd: "# 기획서",
      authorActorType: "user",
      authorActorId: t.ownerId,
      conceptBriefId: briefId,
      content: { characters: [{ name: "레온", aliases: ["레오"], gender: "남", character_key: "chr_1" }, { name: "에린", gender: "여" }], places: [{ name: "왕도" }], relationships: [{ from: "레온", to: "에린", relation: "동맹" }] },
    });
    // the model adds nothing beyond the bible's own lists (entities/relations below come from the bible content)
    t.claude.reply({ when: { schemaHas: ["entities", "facts"] }, json: { entities: [], facts: [] } });
    await run((tx) => t.modules.orchestration.service.createTask(tx, scope, { kind: "build_initial_ontology", targetType: "novel", targetId: scope.novelId, input: { series_bible_id: bibleId }, createdBy: t.owner }));
    await t.modules.orchestration.service.runOnce();
    const [task] = await t.modules.orchestration.service.listTasks(scope, { kinds: ["build_initial_ontology"] });
    expect(task!.status).toBe("done");
    const list = await onto.listEntities(scope, { statuses: ["candidate"] });
    expect(list.map((x) => x.preferredName).sort()).toEqual(["레온", "에린", "왕도"]);
    const r = await run<{ approved: number }>((tx) => onto.approveBibleFacts(tx, scope, bibleId, t.owner));
    expect(r.approved).toBe(3); // gender ×2 + ally_of
    const active = await onto.listEntities(scope, { statuses: ["active"] });
    expect(active).toHaveLength(3);
    const leon = active.find((x) => x.preferredName === "레온")!.entity;
    expect(leon.conceptCharacterKey).toBe("chr_1");
    const canon = await onto.getCanonAt(scope, [leon.id], 1000, tl);
    expect(canon.map((f) => f.predicate).sort()).toEqual(["ally_of", "gender"]);
    expect((await t.testDb.db.select().from(facts).where(and(eq(facts.novelId, scope.novelId), eq(facts.canonStatus, "candidate"))))).toHaveLength(0);
  });

  it("dedupe_entities proposes merges as questions only (P-4)", async () => {
    const { scope } = await newNovel();
    const db = t.testDb.db;
    await db.insert(goals).values({ id: newId("gol"), novelId: scope.novelId, totalEpisodesMin: 10, cadenceEpisodesPerWeek: 3, endingDirection: "끝" });
    await run((tx) => onto.createEntity(tx, scope, { entityType: "character", preferredName: { surface: "한서윤" }, status: "active" }, t.owner));
    await run((tx) => onto.createEntity(tx, scope, { entityType: "character", preferredName: { surface: "한서윤" }, status: "candidate" }, t.owner));
    await run((tx) => t.modules.orchestration.service.createTask(tx, scope, { kind: "dedupe_entities", targetType: "novel", targetId: scope.novelId, input: { min_score: 0.5 }, createdBy: t.owner }));
    await t.modules.orchestration.service.runOnce();
    const [dt] = await t.modules.orchestration.service.listTasks(scope, { kinds: ["dedupe_entities"] });
    expect(dt?.latestRun?.errorMessage ?? null).toBeNull();
    expect(dt!.status).toBe("done");
    const decs = await onto.listIdentityDecisions(scope);
    expect(decs).toHaveLength(1);
    expect(decs[0]!.status).toBe("proposed");
    expect(decs[0]!.questionId).toBeTruthy();
    expect((await onto.listEntities(scope)).length).toBe(2);
  });
});
