/**
 * 설계 추가 0026 (linking / ontology / world slice): an entity handle (E1, E2 …) never becomes an entity, a name, an
 * alias, a mention or part of a stored sentence.
 *  - P5: the ontology gate, the linker, the dictionary, the HITL "새 엔티티" / alias paths
 *  - P3: extract_facts values / evidence, the resolver's rationale / canonical_name (batch handles are K1 …),
 *        build_initial_ontology (incl. the deterministic rule-name path), build_world_ontology
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "@ncs/db/orm";
import { arcs, conceptBriefs, conceptSessions, entities, entityNames, episodes, facts, goals, manuscriptVersions, mentions, scenes, seriesBibles } from "@ncs/db/schema";
import { newId } from "@ncs/shared";
import * as dto from "@ncs/shared";
import { actors, type NovelScope } from "../../src/platform/index.js";
import { createTestCore, type TestCore } from "../support/test-core.js";
import { SAMPLE_WORLD, isWorldRequest } from "../support/world.js";
import { extractionHandleIssues, initialOntologyHandleIssues, scrubExtraction, scrubInitialOntology } from "../../src/modules/linking/application/handle-guard.js";
import { checkResolution, RESOLVE_SYSTEM, resolveMentions, resolverPrompt, rewriteLocalRefs, type ResolverEntity, type ResolverItem } from "../../src/modules/linking/application/resolver.js";
import { runLinker } from "../../src/modules/linking/application/linker.js";
import { findHandleTokens, isHandleShaped, replaceHandleTokens } from "../../src/modules/agents/index.js";
import { handleTokensIn, isHandleShapedSurface } from "../../src/modules/ontology/adapters/db/entities.js";
import { rememberAlias } from "../../src/modules/linking/application/decisions.js";
import { resolverEntities } from "../../src/modules/linking/application/agent-resolution.js";
import { extractionResultSchema, initialOntologySchema } from "../../src/modules/linking/domain/schemas.js";
import { dictionaryMentions, parseBibleContent } from "../../src/modules/linking/domain/text.js";

let t: TestCore;
beforeAll(async () => {
  t = await createTestCore();
});
afterAll(() => t.close());
beforeEach(() => t.claude.reset());

const run = <T>(fn: Parameters<TestCore["platform"]["uow"]["run"]>[0]) => t.platform.uow.run(fn) as Promise<T>;
const agent = actors.agent("world_keeper", "run_handle_guard");

async function newNovel(title = "핸들 가드 테스트"): Promise<{ scope: NovelScope; tl: string }> {
  const n = await t.modules.novel.service.createNovel({ title }, t.owner);
  return { scope: { novelId: n.id }, tl: (await t.modules.ontology.service.getDefaultTimeline({ novelId: n.id })).id };
}
const entity = (scope: NovelScope, name: string, type = "character", status: "active" | "candidate" = "active") =>
  run<{ entity: { id: string } }>((tx) => t.modules.ontology.service.createEntity(tx, scope, { entityType: type as never, preferredName: { surface: name }, status }, t.owner)).then((r) => r.entity.id);
const namesOf = async (scope: NovelScope) => (await t.testDb.db.select().from(entityNames).where(eq(entityNames.novelId, scope.novelId))).map((n) => n.surface).sort();

/** the part of a RunHandle the repair dialogue touches */
const fakeRun = { runId: "run_fake", role: "world_keeper", checkpoint: async () => undefined, noteOutputSummary: () => undefined } as never;

describe("pure guards", () => {
  it("resolver: the batch entity handles are K1 … (prompt, answer check, repair message) — never E", () => {
    const ents: ResolverEntity[] = [
      { entityId: "X", entityType: "character", status: "active", names: ["서이온", "이온"] },
      { entityId: "Y", entityType: "place", status: "candidate", names: ["판정실"] },
    ];
    const items: ResolverItem[] = [{ key: "a", surface: "이온 씨", mentionKind: "address", contexts: ["E7은 이온 씨를 불렀다"], candidateIds: ["X"], salience: "candidate" }];
    const handleOf = new Map([
      ["X", "K1"],
      ["Y", "K2"],
    ]);
    const prompt = resolverPrompt(items, ents, handleOf, ["character", "place"]);
    expect(prompt).toContain("K1 | 서이온 | character");
    expect(prompt).toContain("후보: K1");
    expect(prompt).not.toMatch(/(?<![A-Za-z0-9_])E\d+ \|/);
    expect(RESOLVE_SYSTEM).toContain("K 핸들");
    expect(RESOLVE_SYSTEM).not.toContain("E 핸들");
    const byHandle = new Map([
      ["K1", "X"],
      ["K2", "Y"],
    ]);
    const types = new Set(["character", "place"]);
    // an "E1" answer (the old namespace, or a handle copied from the excerpt) is not an entry of the list
    const old = checkResolution({ resolutions: [{ mention: "M1", action: "link_existing", entity: "E1", confidence: 0.9, rationale: "" }] }, items, byHandle, types);
    expect(old.result.decisions.size).toBe(0);
    expect(old.issues[0]!.problem).toContain("K1~K2");
    const ok = checkResolution({ resolutions: [{ mention: "M1", action: "add_alias", entity: "k1", confidence: 0.9, rationale: "" }] }, items, byHandle, types);
    expect(ok.issues).toEqual([]);
    expect(ok.result.decisions.get(0)).toMatchObject({ action: "add_alias", entityId: "X" });
  });

  it("resolver: batch references in the rationale become names; a handle left in it is repaired and never stored", () => {
    const names = new Map([
      ["K1", "서이온"],
      ["K24", "판정실"],
    ]);
    expect(rewriteLocalRefs("기존 '판정실'(K24)과 같은 곳인지도 불분명", names)).toBe("기존 '판정실'과 같은 곳인지도 불분명");
    expect(rewriteLocalRefs("K1은 앞 문장의 주어, K24를 가리킴", names)).toBe("서이온은 앞 문장의 주어, 판정실을 가리킴");
    expect(rewriteLocalRefs("K99는 목록에 없음, SK1 텔레콤", names)).toBe("K99는 목록에 없음, SK1 텔레콤");
    const items: ResolverItem[] = [
      { key: "a", surface: "그", mentionKind: "pronoun", contexts: [], candidateIds: ["X"], salience: "pronoun" },
      { key: "b", surface: "E3 구역", mentionKind: "named", contexts: [], candidateIds: [], salience: "candidate" },
    ];
    const byHandle = new Map([["K1", "X"]]);
    const types = new Set(["character", "place"]);
    const guard = { names: new Map([["K1", "서이온"]]), story: new Set(["E3"]) };
    const clean = checkResolution(
      {
        resolutions: [
          { mention: "M1", action: "link_existing", entity: "K1", confidence: 0.9, rationale: "앞 문장의 K1을 가리킴" },
          { mention: "M2", action: "create_entity", entity_type: "place", confidence: 0.9, rationale: "'E3 구역'은 반복되는 장소" },
        ],
      },
      items,
      byHandle,
      types,
      guard,
    );
    expect(clean.issues).toEqual([]);
    expect(clean.result.decisions.get(0)!.rationale).toBe("앞 문장의 서이온을 가리킴");
    expect(clean.result.decisions.get(1)).toMatchObject({ canonicalName: "E3 구역", rationale: "'E3 구역'은 반복되는 장소" }); // a story token stays
    const leaked = checkResolution({ resolutions: [{ mention: "M1", action: "link_existing", entity: "K1", confidence: 0.5, rationale: "원고에 남은 'E7' 표기가 핸들과 겹쳐 확신이 낮음" }, { mention: "M2", action: "ignore", confidence: 1, rationale: "" }] }, items, byHandle, types, guard);
    expect(leaked.issues).toHaveLength(1);
    expect(leaked.issues[0]).toMatchObject({ item: "M1 link_existing rationale" });
    expect(leaked.issues[0]!.problem).toContain("'E7'");
    // the decision stands; the sentence with the handle is not kept
    expect(leaked.result.decisions.get(0)).toMatchObject({ action: "link_existing", entityId: "X", rationale: "" });
  });

  it("resolver: a rewritten reference agrees its particle like every other handle rewrite; a K token of the excerpt is story text", () => {
    const names = new Map([
      ["K1", "민지"],
      ["K2", "판정실"],
    ]);
    // the same particle rules as the pack handles (one implementation: agents.replaceRefTokens)
    const k = "K1으로 향했다. K1이라는 사람, K1로서는 K2과 달랐다.";
    expect(rewriteLocalRefs(k, names)).toBe("민지로 향했다. 민지라는 사람, 민지로서는 판정실과 달랐다.");
    expect(rewriteLocalRefs(k, names)).toBe(replaceHandleTokens(k.replaceAll("K", "E"), ["민지", "판정실"]).text);
    // "K2 소총" is a word of the manuscript, not the 2nd entity of the list: neither rewritten nor reported
    const items: ResolverItem[] = [{ key: "a", surface: "K2 소총", mentionKind: "named", contexts: ["그는 K2 소총을 어깨에 멨다."], candidateIds: [], salience: "candidate" }];
    const byHandle = new Map([
      ["K1", "X"],
      ["K2", "Y"],
    ]);
    const r = checkResolution({ resolutions: [{ mention: "M1", action: "ignore", confidence: 0.9, rationale: "K2 소총은 일반 명사이고 K1의 소지품일 뿐" }] }, items, byHandle, new Set(["item"]), { names });
    expect(r.issues).toEqual([]);
    expect(r.result.decisions.get(0)!.rationale).toBe("K2 소총은 일반 명사이고 민지의 소지품일 뿐");
    // … unless the judgement itself points at that entity
    const own = checkResolution({ resolutions: [{ mention: "M1", action: "link_existing", entity: "K2", confidence: 0.9, rationale: "K2의 비품" }] }, items, byHandle, new Set(["item"]), { names });
    expect(own.result.decisions.get(0)!.rationale).toBe("판정실의 비품");
  });

  it("resolver: the surface being judged is no exemption — a handle inside it never becomes a name or stays in the rationale (P1)", async () => {
    const items: ResolverItem[] = [
      { key: "a", surface: "E12 일행", mentionKind: "named", contexts: ["E12 일행이 문을 넘었다."], candidateIds: [], salience: "candidate" },
      { key: "b", surface: "E7의 검", mentionKind: "named", contexts: [], candidateIds: [], salience: "candidate" },
    ];
    const answer = {
      resolutions: [
        { mention: "M1", action: "create_entity" as const, entity_type: "organization", canonical_name: "E12 일행", confidence: 0.9, rationale: "E12가 이끄는 무리로 반복 등장" },
        { mention: "M2", action: "create_entity" as const, entity_type: "item", confidence: 0.9, rationale: "" }, // canonical name defaults to the surface
      ],
    };
    const r = checkResolution(answer, items, new Map(), new Set(["organization", "item"]), { story: new Set() });
    expect(r.result.decisions.size).toBe(0);
    expect(r.issues.map((i) => i.item)).toEqual(["M1 create_entity rationale", "M1 create_entity canonical_name", "M2 create_entity canonical_name"]);
    // the guard resolveMentions really builds: story tokens come from the caller (ontology), never from the batch
    let calls = 0;
    const llm = { call: async () => ({ value: answer, modelId: "m", providerCallId: "c", reused: false, usage: {} }) } as never;
    const counting = { call: async () => (calls++, { value: answer, modelId: "m", providerCallId: "c", reused: false, usage: {} }) } as never;
    const out = await resolveMentions({ llm: counting, run: fakeRun, items, entities: [], entityTypes: new Set(["organization", "item"]) });
    expect(calls).toBeGreaterThan(1); // the answer went back for repair
    expect(out.failed).toBe(false);
    expect(out.decisions.size).toBe(0);
    // a person named an entity "E12 구역" → only then is E12 story text
    const ok = await resolveMentions({ llm, run: fakeRun, items: [items[0]!], entities: [], entityTypes: new Set(["organization"]), story: new Set(["E12"]) });
    expect(ok.decisions.get("a")).toMatchObject({ action: "create_entity", canonicalName: "E12 일행" });
  });

  it("resolver: a [중복 확인] pair with an entity that is not offered is not judged (no 'undefined' in the prompt, no blind merge)", async () => {
    const pair: ResolverItem = { key: "d|q1", surface: "", mentionKind: "named", contexts: [], candidateIds: ["X", "GHOST"], salience: "candidate", pair: { a: "GHOST", b: "X" } };
    const entities: ResolverEntity[] = [{ entityId: "X", entityType: "character", status: "active", names: ["서이온"] }];
    let calls = 0;
    const llm = { call: async () => (calls++, { value: { resolutions: [{ mention: "M1", action: "merge", confidence: 0.99, rationale: "" }] }, modelId: "m", providerCallId: "c", reused: false, usage: {} }) } as never;
    const out = await resolveMentions({ llm, run: fakeRun, items: [pair], entities, entityTypes: new Set(["character"]) });
    expect(calls).toBe(0);
    expect(out.decisions.size).toBe(0); // no decision → the question stays open for a person
    expect(out.failed).toBe(false);
    expect(resolverPrompt([pair], entities, new Map([["X", "K1"]]), ["character"])).not.toContain("undefined");
  });

  it("the ontology's own copy of the handle patterns agrees with agents/domain/handle-text", () => {
    for (const s of ["E7", " E11 ", "[E6]", "(E6)", "（E6）", "E3 구역", "SE6", "E6A", "E1234", "e7", "E_7", "서이온(E6)", "", "E7은 E12와 E7을 보았다\nE9", "DE12 E0 x_E3 E3_"]) {
      expect(isHandleShapedSurface(s), `shape of ${JSON.stringify(s)}`).toBe(isHandleShaped(s));
      expect(handleTokensIn(s), `tokens of ${JSON.stringify(s)}`).toEqual(findHandleTokens(s));
    }
  });

  it("resolver: a handle is never the canonical name of a new entity (given, or defaulted from the surface)", () => {
    const items: ResolverItem[] = [
      { key: "a", surface: "검은 탑", mentionKind: "named", contexts: [], candidateIds: [], salience: "candidate" },
      { key: "b", surface: "E7", mentionKind: "named", contexts: [], candidateIds: [], salience: "candidate" },
      { key: "c", surface: "사내", mentionKind: "descriptive", contexts: [], candidateIds: [], salience: "candidate" },
    ];
    const r = checkResolution(
      {
        resolutions: [
          { mention: "M1", action: "create_entity", entity_type: "place", canonical_name: "E12", confidence: 0.9, rationale: "" },
          { mention: "M2", action: "create_entity", entity_type: "character", confidence: 0.9, rationale: "" },
          { mention: "M3", action: "create_entity", entity_type: "character", canonical_name: "E7의 스승", confidence: 0.9, rationale: "" },
        ],
      },
      items,
      new Map(),
      new Set(["character", "place"]),
    );
    expect(r.result.decisions.size).toBe(0);
    expect(r.issues.map((i) => i.item)).toEqual(["M1 create_entity canonical_name", "M2 create_entity canonical_name", "M3 create_entity canonical_name"]);
    expect(r.issues[0]!.problem).toContain("'E12'");
  });

  it("extract_facts: fact values / evidence with a handle are repair issues, then dropped / cleared", () => {
    const x = extractionResultSchema.parse({
      mentions: [{ local_key: "m1", scene_ord: 1, surface: "서이온", mention_kind: "named" }],
      facts: [
        { local_key: "f1", fact_kind: "attribute", subject_mention_key: "m1", predicate: "occupation", value: "E7의 호위" },
        { local_key: "f2", fact_kind: "attribute", subject_mention_key: "m1", predicate: "occupation", value: "E3 구역 경비대" },
        { local_key: "f3", fact_kind: "relation", subject_mention_key: "m1", predicate: "ally_of", object_mention_key: "E7" }, // a reference key, not a sentence
      ],
      identity_assertions: [
        { mention_key_a: "m1", mention_key_b: "m2", evidence: "E7의 행동이 서이온과 같다" },
        { mention_key_a: "m1", mention_key_b: "m3", evidence: "가면을 벗자 서이온이었다" },
      ],
    });
    const story = new Set(["E3"]);
    const issues = extractionHandleIssues(x, story);
    expect(issues.map((i) => i.item)).toEqual(["fact f1 value", "identity_assertion m1/m2 evidence"]);
    expect(issues[0]!.problem).toContain("'E7'");
    const s = scrubExtraction(x, story);
    expect(s.droppedFacts).toEqual(["f1"]);
    expect(s.clearedEvidence).toBe(1);
    expect(s.extraction.facts.map((f) => f.local_key)).toEqual(["f2", "f3"]);
    expect(s.extraction.identity_assertions.map((ia) => ia.evidence)).toEqual([undefined, "가면을 벗자 서이온이었다"]);
    expect(s.extraction.mentions).toBe(x.mentions);
    // nothing to do → the same object
    expect(scrubExtraction(s.extraction, story).extraction).toBe(s.extraction);
    // "the token is in the input" is no exemption: only story tokens are
    expect(extractionHandleIssues(x, new Set())).toHaveLength(3);
  });

  it("bible ontology: handle names / aliases / summaries / values are issues and are scrubbed; empty shells go too", () => {
    const p = initialOntologySchema.parse({
      entities: [
        { key: "c1", entity_type: "character", name: "E11" },
        { key: "c2", entity_type: "character", name: "서이온", aliases: ["E6", "이온"], summary: "E12의 선택을 받은 검사" },
        { key: "r1", entity_type: "rule", name: "성장 규칙", summary: "E1은 계약 없이 성장한다" },
        { key: "r2", entity_type: "rule", name: "등급 규칙", summary: "등급은 F~S급이다" },
        { key: "p1", entity_type: "place", name: "E3 구역", summary: "E3 구역은 봉쇄되었다" },
      ],
      facts: [
        { subject_key: "c1", predicate: "gender", value: "남" },
        { subject_key: "c2", predicate: "gender", value: "남" },
        { subject_key: "r1", predicate: "rule_statement", value: "E1은 계약 없이 성장한다" },
        { subject_key: "r2", predicate: "rule_statement", value: "등급은 F~S급이다" },
      ],
    });
    const story = new Set(["E3"]);
    expect(initialOntologyHandleIssues(p, story).map((i) => i.item)).toEqual(["entity c1 name", 'entity c2 "서이온"', 'entity r1 "성장 규칙"', "fact r1 rule_statement value"]);
    const s = scrubInitialOntology(p, story);
    expect(s.ontology.entities.map((e) => [e.key, e.name, e.aliases, e.summary ?? null])).toEqual([
      ["c2", "서이온", ["이온"], null],
      ["r2", "등급 규칙", [], "등급은 F~S급이다"],
      ["p1", "E3 구역", [], "E3 구역은 봉쇄되었다"],
    ]);
    expect(s.ontology.facts.map((f) => f.subject_key)).toEqual(["c2", "r2"]);
    expect(s).toMatchObject({ droppedEntities: ["E11", "성장 규칙"], droppedAliases: 1, clearedSummaries: 2, droppedFacts: 2 });
    // only a rule is an empty shell without its sentence: other entities keep their name
    const org = scrubInitialOntology(initialOntologySchema.parse({ entities: [{ key: "o1", entity_type: "organization", name: "태양 길드", summary: "E9가 이끄는 길드" }] }), story);
    expect(org.ontology.entities).toMatchObject([{ name: "태양 길드", summary: null }]);
    expect(scrubInitialOntology(s.ontology, story).ontology).toBe(s.ontology);
  });

  it("deterministic bible parse: a nameless rule is never named with a handle; the dictionary skips handle-shaped names", () => {
    const b = parseBibleContent({ world_rules: ["신규 제안입니다. E1의 성장 조건은 계약이 아니다", { statement: "E12는 E1에게 힘을 빌려준다" }, "마나는 순환한다"] });
    expect(b.entities.map((e) => e.name)).toEqual(["신규 제안입니다", "세계 규칙 2", "마나는 순환한다"]);
    // the statements still carry the handles: the commit scrub removes those rules entirely
    expect(scrubInitialOntology(b, new Set()).ontology.entities.map((e) => e.name)).toEqual(["마나는 순환한다"]);
    const hits = dictionaryMentions("E11은 서이온을 보았다. E3 구역이었다.", [
      { surface: "E11", nameKind: "true_name", entityType: "character" },
      { surface: "서이온", nameKind: "true_name", entityType: "character" },
      { surface: "E3 구역", nameKind: "true_name", entityType: "place" },
    ]);
    expect(hits.map((h) => h.surface)).toEqual(["서이온", "E3 구역"]);
  });
});

describe("ontology gate (P5 / P6)", () => {
  it("a handle-shaped surface is never an entity name, an alias or a mention", async () => {
    const { scope, tl } = await newNovel();
    const onto = t.modules.ontology.service;
    for (const surface of ["E7", " E11 ", "[E6]", "E12(차경혁)"]) {
      await expect(run((tx) => onto.createEntity(tx, scope, { entityType: "character", preferredName: { surface }, status: "candidate" }, agent))).rejects.toMatchObject({ code: "handle_shaped_name" });
    }
    await expect(run((tx) => onto.createEntity(tx, scope, { entityType: "character", preferredName: { surface: "E7" } }, t.owner))).rejects.toMatchObject({ code: "handle_shaped_name" });
    await expect(run((tx) => onto.createEntity(tx, scope, { entityType: "character", preferredName: { surface: "차경혁" }, names: [{ surface: "E11", nameKind: "alias" }] }, t.owner))).rejects.toMatchObject({ code: "handle_shaped_name" });
    expect(await namesOf(scope)).toEqual([]); // nothing half-written
    const ion = await entity(scope, "서이온(E6)"); // a leaked reference mark is not a variant spelling
    await entity(scope, "E3 구역", "place"); // a real name that merely contains such a token is fine
    await expect(run((tx) => onto.addEntityName(tx, scope, ion, { surface: "E6", nameKind: "alias" }, t.owner))).rejects.toMatchObject({ code: "handle_shaped_name" });
    expect(await namesOf(scope)).toEqual(["E3 구역", "서이온"]);
    const mention = (surface: string) => ({ sourceKind: "user_input" as const, storyPoint: 1001, timelineId: tl, surface, mentionKind: "named" as const, candidates: [], linkedEntityId: ion, confidence: 1, linkStatus: "auto_linked" as const, linkerVersion: "t" });
    await expect(run((tx) => onto.writeMentions(tx, scope, [mention("서이온"), mention("E6")], t.owner))).rejects.toMatchObject({ code: "handle_shaped_name" });
    expect(await t.testDb.db.select().from(mentions).where(eq(mentions.novelId, scope.novelId))).toHaveLength(0);
  });

  it("agent-written fact values / summaries with a handle are refused; story tokens and human text pass", async () => {
    const { scope, tl } = await newNovel();
    const onto = t.modules.ontology.service;
    const ion = await entity(scope, "서이온");
    await entity(scope, "E3 구역", "place");
    // a real run of this novel (fact versions reference the agent's run)
    await t.testDb.db.insert(goals).values({ id: newId("gol"), novelId: scope.novelId, totalEpisodesMin: 10, cadenceEpisodesPerWeek: 3, endingDirection: "끝" });
    await run((tx) => t.modules.orchestration.service.createTask(tx, scope, { kind: "dedupe_entities", targetType: "novel", targetId: scope.novelId, input: {}, createdBy: t.owner }));
    let runId: string | undefined;
    for (let i = 0; i < 6 && !runId; i++) {
      await t.modules.orchestration.service.runOnce();
      runId = (await t.testDb.query<{ id: string }>(`SELECT id FROM runs WHERE novel_id = '${scope.novelId}' LIMIT 1`))[0]?.id;
    }
    const agent = actors.agent("world_keeper", runId!);
    const draft = (value: string) => ({ factKind: "attribute" as const, subjectEntityId: ion, predicate: "personality", value, timelineId: tl, storyRange: { from: 0, to: null }, sourceKind: "system_derived" as const, source: { refType: "novel" as const, refId: scope.novelId } });
    const r = await run<Awaited<ReturnType<typeof onto.writeCandidateFacts>>>((tx) => onto.writeCandidateFacts(tx, scope, [draft("E7의 호위"), draft("E3 구역 경비대")], agent));
    expect(r.rejected).toEqual([{ index: 0, reason: "handle_token_in_value:E7" }]);
    expect(r.written).toHaveLength(1);
    const human = await run<Awaited<ReturnType<typeof onto.writeCandidateFacts>>>((tx) => onto.writeCandidateFacts(tx, scope, [draft("E7의 호위")], t.owner));
    expect(human.rejected).toEqual([]);
    await expect(run((tx) => onto.createEntity(tx, scope, { entityType: "rule", preferredName: { surface: "성장 규칙" }, summary: "E1은 계약 없이 성장한다" }, agent))).rejects.toMatchObject({ code: "handle_token_in_text" });
    await expect(run((tx) => onto.updateEntity(tx, scope, ion, { summary: "E12의 선택을 받은 검사" }, agent))).rejects.toMatchObject({ code: "handle_token_in_text" });
    await run((tx) => onto.updateEntity(tx, scope, ion, { summary: "E3 구역 출신의 검사" }, agent));
    await run((tx) => onto.updateEntity(tx, scope, ion, { summary: "작가 메모: E7 참고" }, t.owner));
    expect(await namesOf(scope)).toEqual(["E3 구역", "서이온"]);
  });

  it("P1: story tokens come only from names a person gave — an agent can neither make such a name nor exempt a token with one", async () => {
    const { scope, tl } = await newNovel();
    const onto = t.modules.ontology.service;
    const ion = await entity(scope, "서이온");
    expect([...(await onto.storyHandleTokens(scope))]).toEqual([]);
    // an agent's names never carry a handle token: new entity, extra name, alias
    await expect(run((tx) => onto.createEntity(tx, scope, { entityType: "organization", preferredName: { surface: "E12 일행" }, status: "candidate" }, agent))).rejects.toMatchObject({ code: "handle_token_in_name" });
    await expect(run((tx) => onto.createEntity(tx, scope, { entityType: "item", preferredName: { surface: "명검" }, names: [{ surface: "E7의 검", nameKind: "alias" }] }, agent))).rejects.toMatchObject({ code: "handle_token_in_name" });
    await expect(run((tx) => onto.addEntityName(tx, scope, ion, { surface: "E7 선수", nameKind: "alias" }, agent))).rejects.toMatchObject({ code: "handle_token_in_name" });
    expect(await namesOf(scope)).toEqual(["서이온"]);
    // a name stored before the gate existed (the live rule "신규 제안입니다. E1의 성장 조건은", made by an agent) exempts nothing
    const legacy = newId("ent");
    const legacyName = newId("enm");
    const now = new Date();
    await t.testDb.db.insert(entities).values({ id: legacy, novelId: scope.novelId, entityType: "rule", status: "candidate", createdByActorType: "agent", createdByActorId: "world_keeper", createdAt: now, updatedAt: now } as typeof entities.$inferInsert);
    await t.testDb.db.insert(entityNames).values({ id: legacyName, novelId: scope.novelId, entityId: legacy, surface: "신규 제안입니다. E1의 성장 조건은", normalizedKey: "k", jamoKey: "k", translitKey: "k", nameKind: "true_name", isPreferred: true, status: "active", storyRange: "[0,)", sourceKind: "series_bible", sourceRefType: "entity", sourceRefId: legacy, createdAt: now, updatedAt: now } as typeof entityNames.$inferInsert);
    await t.testDb.db.update(entities).set({ preferredNameId: legacyName, status: "active" }).where(eq(entities.id, legacy));
    expect([...(await onto.storyHandleTokens(scope))]).toEqual([]);
    await expect(run((tx) => onto.updateEntity(tx, scope, ion, { summary: "E1의 맞수" }, agent))).rejects.toMatchObject({ code: "handle_token_in_text" });
    // a person names a place "E3 구역" → E3 (and only E3) is story text; now an agent may use it in a name too
    await entity(scope, "E3 구역", "place");
    expect([...(await onto.storyHandleTokens(scope))]).toEqual(["E3"]);
    await run((tx) => onto.createEntity(tx, scope, { entityType: "place", preferredName: { surface: "E3 구역 검문소" }, status: "candidate" }, agent));
    // the linker ignores a surface that carries a non-story token: no mention, no new-entity candidate
    const mention = (surface: string) => ({ surface, charStart: 0, charEnd: surface.length, sceneId: "scn_none", storyPoint: 1001, mentionKind: "named" as const });
    const linked = await runLinker({ ontology: onto, llm: t.modules.llm.service }, scope, { manuscriptVersionId: null, anchor: { storyPoint: 1001, timelineId: tl }, mentions: [mention("E12 일행"), mention("E7"), mention("E3 구역"), mention("낯선 사내")] });
    expect(linked.mentions.map((m) => m.surface)).toEqual(["E3 구역", "낯선 사내"]);
    expect((linked.newEntities ?? []).map((n) => n.surface)).not.toContain("E12 일행");
    // an alias is never remembered from such a surface, whoever confirmed the link
    const d = { ontology: onto, hitl: t.modules.hitl.service, novel: t.modules.novel.service };
    expect(await run((tx) => rememberAlias(d, tx, scope, ion, { surface: "E12 일행의 검사", mentionKind: "named" }, t.owner))).toBeNull();
    expect([...(await onto.storyHandleTokens(scope))]).toEqual(["E3"]);
  });
});

describe("resolver entity list", () => {
  it("a ghost entity whose only name is a handle is never offered as a link target", async () => {
    const { scope } = await newNovel();
    const ion = await entity(scope, "서이온");
    const ghost = newId("ent");
    const ghostName = newId("enm");
    const now = new Date();
    await t.testDb.db.insert(entities).values({ id: ghost, novelId: scope.novelId, entityType: "character", status: "candidate", createdByActorType: "agent", createdByActorId: "world_keeper", createdAt: now, updatedAt: now } as typeof entities.$inferInsert);
    await t.testDb.db.insert(entityNames).values({ id: ghostName, novelId: scope.novelId, entityId: ghost, surface: "E11", normalizedKey: "e11", jamoKey: "e11", translitKey: "e11", nameKind: "true_name", isPreferred: true, status: "active", storyRange: "[0,)", sourceKind: "manuscript", sourceRefType: "entity", sourceRefId: ghost, createdAt: now, updatedAt: now } as typeof entityNames.$inferInsert);
    await t.testDb.db.update(entities).set({ preferredNameId: ghostName, status: "active" }).where(eq(entities.id, ghost));
    const list = await resolverEntities(t.modules.ontology.service, scope);
    expect(list.map((e) => e.entityId)).toEqual([ion]);
    expect(list[0]!.names).toEqual(["서이온"]);
  });
});

describe("extract_facts on a manuscript that still carries handles", () => {
  async function seed(scope: NovelScope, tl: string, text: string) {
    const db = t.testDb.db;
    await db.insert(goals).values({ id: newId("gol"), novelId: scope.novelId, totalEpisodesMin: 10, cadenceEpisodesPerWeek: 3, endingDirection: "끝" });
    const arcId = newId("arc");
    await db.insert(arcs).values({ id: arcId, novelId: scope.novelId, ord: 1, title: "1부", goalText: "g", conflictText: "c", endCondition: "e", plannedEpisodeFrom: 1, plannedEpisodeTo: 10 });
    const epId = newId("epi");
    await db.insert(episodes).values({ id: epId, novelId: scope.novelId, arcId, episodeNo: 3, primaryTimelineId: tl });
    const mvId = newId("mnv");
    await db.insert(manuscriptVersions).values({ id: mvId, novelId: scope.novelId, episodeId: epId, versionNo: 1, kind: "draft", stage: "drafting", content: text, charCountWithSpaces: text.length, charCountWithoutSpaces: text.length, contentHash: "h", authorActorType: "user", authorActorId: t.ownerId });
    const scId = newId("scn");
    await db.insert(scenes).values({ id: scId, novelId: scope.novelId, episodeId: epId, ord: 1, manuscriptVersionId: mvId, charStart: 0, charEnd: text.length, storyPoint: 3001, timelineId: tl, summary: "s" });
    return { epId, mvId, scId };
  }

  it("a bare handle is no mention and no entity; a ghost name is not in the dictionary; leaking values are repaired or dropped", async () => {
    const { scope, tl } = await newNovel();
    const ion = await entity(scope, "서이온");
    // a ghost left by an earlier run (stored before the gate existed)
    const ghost = newId("ent");
    const ghostName = newId("enm");
    const now = new Date();
    await t.testDb.db.insert(entities).values({ id: ghost, novelId: scope.novelId, entityType: "character", status: "candidate", createdByActorType: "agent", createdByActorId: "world_keeper", createdAt: now, updatedAt: now } as typeof entities.$inferInsert);
    await t.testDb.db.insert(entityNames).values({ id: ghostName, novelId: scope.novelId, entityId: ghost, surface: "E11", normalizedKey: "e11", jamoKey: "e11", translitKey: "e11", nameKind: "true_name", isPreferred: true, status: "active", storyRange: "[0,)", sourceKind: "manuscript", sourceRefType: "entity", sourceRefId: ghost, createdAt: now, updatedAt: now } as typeof entityNames.$inferInsert);
    await t.testDb.db.update(entities).set({ preferredNameId: ghostName, status: "active" }).where(eq(entities.id, ghost));

    const text = "E7은 죽도를 내려놓았다. 서이온은 E11을 노려보았다.";
    const { epId, mvId, scId } = await seed(scope, tl, text);
    const extraction = (value: string, evidence: string) => ({
      mentions: [
        { local_key: "m1", scene_ord: 1, surface: "E7", quote: "E7은 죽도를 내려놓았다", mention_kind: "named", entity_type_hint: "character" },
        { local_key: "m2", scene_ord: 1, surface: "서이온", quote: "서이온은 E11을 노려보았다", mention_kind: "named", entity_type_hint: "character" },
      ],
      facts: [
        { local_key: "f1", fact_kind: "attribute", subject_mention_key: "m2", predicate: "personality", value },
        { local_key: "f2", fact_kind: "state", subject_mention_key: "m1", predicate: "life_status", value: "alive" },
      ],
      identity_assertions: [{ mention_key_a: "m1", mention_key_b: "m2", evidence }],
    });
    t.claude.reply({ when: { prompt: "E7은 죽도를 내려놓았다", schemaHas: ["mentions", "facts"] }, json: extraction("E11의 맞수", "E7의 행동이 서이온과 같다") });
    // the validator critique names the symbol; the producer still leaves one value dirty → that fact is dropped
    t.claude.reply({ times: Infinity, when: (r) => /'E11'|'E7'/.test(r.prompt) && r.prompt.includes("기호"), json: extraction("E11의 맞수", "두 사람의 검술이 같다") });
    t.claude.reply({ times: Infinity, when: { schemaHas: ["choice"] }, json: { choice: "C1", rationale: "" } });
    t.claude.reply({ times: Infinity, when: { schemaHas: ["resolutions"] }, json: { resolutions: [] } });
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
    for (let i = 0; i < 6; i++) {
      const [task] = await t.modules.orchestration.service.listTasks(scope, { kinds: ["extract_facts"] });
      if (["done", "failed", "cancelled"].includes(task!.status)) break;
      await t.modules.orchestration.service.runOnce();
    }
    const [task] = await t.modules.orchestration.service.listTasks(scope, { kinds: ["extract_facts"] });
    expect(task!.latestRun?.errorMessage ?? null).toBeNull();
    expect(task!.status).toBe("done");

    // the known-entity list shown to the model has no ghost name
    const first = t.claude.requests.find((r) => r.prompt.includes("<known_entities>"))!;
    expect(first.prompt).toContain("- 서이온 | character");
    expect(first.prompt).not.toContain("- E11 |");
    expect(first.system).toContain("E와 숫자로 된 기호는 이름이 아닙니다");
    // no mention of a handle surface (neither the model's "E7" nor a dictionary hit for the ghost "E11")
    const ms = await t.modules.ontology.service.listMentions(scope, { manuscriptVersionId: mvId });
    expect(ms.map((m) => m.surface)).toEqual(["서이온"]);
    expect(ms[0]).toMatchObject({ linkedEntityId: ion });
    // no new ghost entity
    expect(await namesOf(scope)).toEqual(["E11", "서이온"]);
    // f1 kept its handle through the dialogue → dropped; f2 pointed at the dropped mention → skipped
    expect(await t.testDb.db.select().from(facts).where(eq(facts.novelId, scope.novelId))).toHaveLength(0);
    const [last] = await t.testDb.query<{ output_summary: { handleGuard?: unknown } | null }>(`SELECT output_summary FROM runs WHERE task_id = '${task!.id}' ORDER BY created_at DESC LIMIT 1`);
    expect(last!.output_summary?.handleGuard).toMatchObject({ mentionsDropped: 1, factsDropped: 1, evidenceCleared: 0 });
  });
});

describe("HITL paths", () => {
  it("'새 엔티티' on a handle surface creates nothing; a handle is never remembered as an alias", async () => {
    const { scope, tl } = await newNovel();
    const onto = t.modules.ontology.service;
    const ion = await entity(scope, "서이온");
    // mentions stored before the gate existed
    const now = new Date();
    const row = (id: string, surface: string) => ({ id, novelId: scope.novelId, sourceKind: "user_input", storyPoint: 1001, timelineId: tl, surface, mentionKind: "named", candidates: [], confidence: 0, linkStatus: "ambiguous", linkerVersion: "t", createdAt: now, updatedAt: now }) as typeof mentions.$inferInsert;
    const m1 = newId("mnt");
    const m2 = newId("mnt");
    await t.testDb.db.insert(mentions).values([row(m1, "E7"), row(m2, "E12")]);
    await expect(run((tx) => t.modules.linking.service.confirmMention(tx, scope, m1, { kind: "new_entity", entityType: "character", preferredName: "" }, t.owner))).rejects.toMatchObject({ code: "handle_shaped_name" });
    await expect(run((tx) => t.modules.linking.service.confirmMention(tx, scope, m1, { kind: "new_entity", entityType: "character", preferredName: "E7" }, t.owner))).rejects.toMatchObject({ code: "handle_shaped_name" });
    expect(await namesOf(scope)).toEqual(["서이온"]);
    // the author names the person: a real entity, the handle is not its alias
    const made = await run<{ entityId: string | null }>((tx) => t.modules.linking.service.confirmMention(tx, scope, m1, { kind: "new_entity", entityType: "character", preferredName: "차경혁" }, t.owner));
    expect(made.entityId).toBeTruthy();
    // linking the handle mention to the person it stood for is fine — but nothing is remembered
    const linked = await run<{ entityId: string | null }>((tx) => t.modules.linking.service.confirmMention(tx, scope, m2, { kind: "entity", entityId: ion }, t.owner));
    expect(linked.entityId).toBe(ion);
    const d = { ontology: onto, hitl: t.modules.hitl.service, novel: t.modules.novel.service };
    expect(await run((tx) => rememberAlias(d, tx, scope, ion, { surface: "E12", mentionKind: "named" }, t.owner))).toBeNull();
    expect(await run((tx) => rememberAlias(d, tx, scope, ion, { surface: "이온 씨", mentionKind: "address" }, t.owner))).toBeTruthy();
    expect(await namesOf(scope)).toEqual(["서이온", "이온 씨", "차경혁"]);
  });
});

describe("build_initial_ontology on a bible that carries handles", () => {
  it("handle names, summaries and rule statements are not stored (deterministic parse + model answer)", async () => {
    const { scope } = await newNovel();
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
      contentMd: "# 기획서\n- E1의 성장 조건은 계약이 아니다",
      authorActorType: "user",
      authorActorId: t.ownerId,
      conceptBriefId: briefId,
      content: { characters: [{ name: "서이온", gender: "남" }], world_rules: ["신규 제안입니다. E1의 성장 조건은 계약이 아니다", "마나는 순환한다"] },
    });
    const dirty = { entities: [{ key: "x1", entity_type: "character", name: "E12", summary: "E1에게 힘을 빌려주는 성좌" }, { key: "x2", entity_type: "organization", name: "태양 길드", summary: "E9가 이끄는 길드" }], facts: [] };
    const repaired = { entities: [{ key: "x1", entity_type: "character", name: "잠든 등불", summary: "서이온에게 힘을 빌려주는 성좌" }, { key: "x2", entity_type: "organization", name: "태양 길드", summary: "E9가 이끄는 길드" }], facts: [] };
    t.claude.reply({ when: (r) => !!r.schema && "entities" in ((r.schema.properties ?? {}) as object) && r.prompt.includes("<series_bible>") && !r.prompt.includes("이름·문장 검증"), json: dirty });
    t.claude.reply({ times: Infinity, when: (r) => r.prompt.includes("이름·문장 검증"), json: repaired });
    await run((tx) => t.modules.orchestration.service.createTask(tx, scope, { kind: "build_initial_ontology", targetType: "novel", targetId: scope.novelId, input: { series_bible_id: bibleId }, createdBy: t.owner }));
    for (let i = 0; i < 4; i++) {
      const [task] = await t.modules.orchestration.service.listTasks(scope, { kinds: ["build_initial_ontology"] });
      if (["done", "failed", "cancelled"].includes(task!.status)) break;
      await t.modules.orchestration.service.runOnce();
    }
    const [task] = await t.modules.orchestration.service.listTasks(scope, { kinds: ["build_initial_ontology"] });
    expect(task!.latestRun?.errorMessage ?? null).toBeNull();
    expect(task!.status).toBe("done");
    // the critique went back to the producer with the symbols it used
    const critique = t.claude.requests.find((r) => r.prompt.includes("이름·문장 검증"))!;
    expect(critique.prompt).toContain("entity x1 name");
    expect(critique.prompt).toContain("'E9'");
    const list = await t.modules.ontology.service.listEntities(scope, { statuses: ["candidate", "active"] });
    expect(list.map((x) => [x.preferredName, x.entity.summary]).sort()).toEqual([
      ["마나는 순환한다", "마나는 순환한다"],
      ["서이온", null],
      ["잠든 등불", "서이온에게 힘을 빌려주는 성좌"],
      ["태양 길드", null], // the summary the producer did not repair is dropped, the entity stays
    ]);
    const stored = await t.testDb.query<{ t: string }>(`SELECT value::text AS t FROM facts WHERE novel_id = '${scope.novelId}' UNION ALL SELECT surface FROM entity_names WHERE novel_id = '${scope.novelId}' UNION ALL SELECT coalesce(summary, '') FROM entities WHERE novel_id = '${scope.novelId}' UNION ALL SELECT surface FROM mentions WHERE novel_id = '${scope.novelId}'`);
    expect(stored.filter((s) => /(?<![A-Za-z0-9_])E\d{1,3}(?![A-Za-z0-9_])/.test(s.t ?? ""))).toEqual([]);
  });
});

describe("build_world_ontology", () => {
  it("an answer with a handle in a name / summary is not stored; the next attempt is clean", async () => {
    const nv = t.modules.novel.service;
    const title = "핸들 세계관";
    const novel = await nv.createNovel({ title }, t.owner);
    const scope = { novelId: novel.id };
    const [session] = await t.testDb.db.select().from(conceptSessions).where(eq(conceptSessions.novelId, novel.id));
    const briefId = t.platform.ids.next("cbf");
    await t.testDb.db.insert(conceptBriefs).values({ id: briefId, novelId: novel.id, sessionId: session!.id, versionNo: 1, authorActorType: "user", authorActorId: t.ownerId, entryMode: "conversation", questionSetVersion: "common@1", content: { logline: "l" }, contentMd: "# 브리프" } as typeof conceptBriefs.$inferInsert);
    await t.platform.uow.run((tx) => nv.applyConceptApproval(tx, scope, { conceptBriefId: briefId, purpose: "initial", genre: "현대 판타지", ageRating: "age_15", category: {} }, t.owner));
    const mine = (r: { system: string; prompt: string }) => isWorldRequest(r) && r.prompt.includes(`제목: ${title}\n`);
    const dirty = structuredClone(SAMPLE_WORLD);
    dirty.factions[0]!.summary = "E7이 이끄는 최대 길드.";
    dirty.places[0]!.source_urls = ["https://example.com/wiki/E12"]; // a URL is a reference, not a sentence
    const clean = structuredClone(SAMPLE_WORLD);
    clean.places[0]!.source_urls = ["https://example.com/wiki/E12"];
    t.claude.reply({ when: mine, json: dirty });
    t.claude.reply({ times: Infinity, when: mine, json: clean });
    const base = `/api/novels/${novel.id}`;
    const view = async () => dto.worldOntologyViewSchema.parse((await t.http("GET", `${base}/world-ontology`)).body);
    let state = "";
    let afterFirst: string[] | null = null;
    for (let i = 0; i < 6 && state !== "done" && state !== "failed"; i++) {
      await t.testDb.exec(`UPDATE tasks SET not_before_at = NULL WHERE kind = 'build_world_ontology' AND status = 'ready'`);
      await t.modules.orchestration.service.runOnce();
      if (afterFirst === null && t.claude.requests.filter(mine).length === 1) afterFirst = await namesOf(scope);
      state = (await view()).generation.state;
    }
    expect(t.claude.requests.filter(mine).length).toBeGreaterThanOrEqual(2);
    expect(afterFirst).toEqual([]); // the dirty answer wrote nothing
    expect(state).toBe("done");
    const req = t.claude.requests.filter(mine)[0]!;
    expect(req.system).toContain("E와 숫자로 된 기호는 이름이 아닙니다");
    const summaries = (await t.testDb.db.select().from(entities).where(eq(entities.novelId, novel.id))).map((e) => e.summary ?? "");
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries.filter((s) => /E7/.test(s))).toEqual([]);
  });
});
