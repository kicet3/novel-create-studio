import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "@ncs/db/orm";
import { entities, entityNames, factCardinalitySlots, facts, factVersions, identityDecisionMoves, mentions } from "@ncs/db/schema";
import { ConflictError, InvalidTransitionError, type NovelScope } from "../../src/platform/index.js";
import type { CandidateFactDraft, OntologyService } from "../../src/modules/ontology/index.js";
import { editDistance, jamoKey, normalizedKey, splitParenthetical, syllableCount } from "../../src/modules/ontology/domain/normalize.js";
import { assertEntityTransition, assertFactTransition, assertIdentityTransition, assertMentionTransition } from "../../src/modules/ontology/domain/transitions.js";
import { classifyFact, computeSlotKey, cardinalitySlotKeys } from "../../src/modules/ontology/domain/facts.js";
import { BASE_SCHEMA_V1, mapPredicateLabel } from "../../src/modules/ontology/domain/base-schema.js";
import { createTestCore, type TestCore } from "../support/test-core.js";

let t: TestCore;
let svc: OntologyService;
beforeAll(async () => {
  t = await createTestCore();
  svc = t.modules.ontology.service;
});
afterAll(() => t.close());

async function newNovel(): Promise<{ scope: NovelScope; tl: string }> {
  const n = await t.modules.novel.service.createNovel({ title: "온톨로지 테스트" }, t.owner);
  const scope = { novelId: n.id };
  const tl = (await svc.getDefaultTimeline(scope)).id;
  return { scope, tl };
}

async function ent(scope: NovelScope, name: string, type: "character" | "title" | "organization" | "place" = "character", opts: { status?: "candidate" | "active"; disambiguator?: string } = {}) {
  return t.platform.uow.run(async (tx) => (await svc.createEntity(tx, scope, { entityType: type, preferredName: { surface: name }, status: opts.status ?? "active", disambiguator: opts.disambiguator }, t.owner)).entity);
}

function draft(tl: string, f: Partial<CandidateFactDraft> & Pick<CandidateFactDraft, "subjectEntityId" | "predicate">, from = 0, to: number | null = null): CandidateFactDraft {
  return {
    factKind: "relation",
    timelineId: tl,
    storyRange: { from, to },
    sourceKind: "user_input",
    source: { refType: "novel", refId: "x" },
    ...f,
  };
}

describe("domain (pure)", () => {
  it("normalizes Korean without stripping Hangul (06 §3.4)", () => {
    expect(normalizedKey("청운검 진무")).toBe("청운검진무");
    expect(normalizedKey("흑룡·상단")).toBe("흑룡상단");
    expect(normalizedKey("Ｌｅｏｎ")).toBe("leon");
    expect(splitParenthetical("천마(天魔)")).toEqual({ main: "천마", variants: ["天魔"] });
    expect(normalizedKey("천마(天魔)")).toBe("천마");
    expect(editDistance(jamoKey("민준"), jamoKey("민중"))).toBe(1);
    expect(syllableCount("민준")).toBe(2);
    expect(normalizedKey("레온")).not.toBe(normalizedKey("레옹"));
  });

  it("maps synonyms / inverse expressions to schema keys (06 §4.6, G17)", () => {
    expect(mapPredicateLabel(BASE_SCHEMA_V1, "수하")).toEqual({ key: "subordinate_of", inverted: false });
    expect(mapPredicateLabel(BASE_SCHEMA_V1, "휘하")).toEqual({ key: "subordinate_of", inverted: false });
    expect(mapPredicateLabel(BASE_SCHEMA_V1, "제자")).toEqual({ key: "master_of", inverted: true });
    expect(mapPredicateLabel(BASE_SCHEMA_V1, "심복")).toBeNull();
  });

  it("rejects transitions that are not in the tables", () => {
    expect(assertEntityTransition("candidate", "active").id).toBe("EN3");
    expect(() => assertEntityTransition("retired", "active")).toThrow(InvalidTransitionError);
    expect(assertMentionTransition("ambiguous", "confirmed").id).toBe("MN5");
    expect(() => assertMentionTransition("rejected", "confirmed")).toThrow(InvalidTransitionError);
    expect(assertFactTransition("candidate", "approved").id).toBe("F3");
    expect(() => assertFactTransition("rejected", "approved")).toThrow(InvalidTransitionError);
    expect(() => assertFactTransition("candidate", "published_locked")).toThrow(InvalidTransitionError);
    expect(assertIdentityTransition("applied", "reverted").id).toBe("ID4");
    expect(() => assertIdentityTransition("reverted", "applied")).toThrow(InvalidTransitionError);
  });

  it("slot keys and classification (06 §6.1, §6.6)", () => {
    const s = BASE_SCHEMA_V1;
    expect(computeSlotKey(s, { factKind: "state", subjectEntityId: "ent_A", predicate: "located_at", objectEntityId: "ent_P" })).toBe("s:ent_A|located_at");
    expect(cardinalitySlotKeys(s, { factKind: "relation", subjectEntityId: "ent_F", predicate: "father_of", objectEntityId: "ent_C" })).toEqual(["o:ent_C|father_of"]);
    expect(cardinalitySlotKeys(s, { factKind: "relation", subjectEntityId: "ent_A", predicate: "spouse_of", objectEntityId: "ent_B" }).sort()).toEqual(["s:ent_A|spouse_of", "s:ent_B|spouse_of"]);
    const link = computeSlotKey(s, { factKind: "state", subjectEntityId: null, predicate: "located_at", objectEntityId: "ent_P", argMentions: { subject: "mnt_X" } });
    expect(link).toBe("s:?mnt_X|located_at");
    const prev = { id: "f1", slotKey: "s:ent_A|located_at", cardSlots: ["s:ent_A|located_at"], range: { from: 0, to: null }, valueKey: "ent_P||||" + "x", canon: true };
    const moved = classifyFact(s, { factKind: "state", subjectEntityId: "ent_A", predicate: "located_at", objectEntityId: "ent_Q" }, { from: 5001, to: null }, [prev]);
    expect(moved).toEqual({ kind: "transition", againstFactId: "f1" });
  });
});

describe("entities and names", () => {
  it("creates entities with preferred name, rejects duplicate names (INV-ONT-03) and finds candidates", async () => {
    const { scope, tl } = await newNovel();
    const leon = await ent(scope, "레온 아스테르");
    await t.platform.uow.run((tx) => svc.addEntityName(tx, scope, leon.id, { surface: "레오", nameKind: "alias" }, t.owner));
    await expect(t.platform.uow.run((tx) => svc.addEntityName(tx, scope, leon.id, { surface: "레 오", nameKind: "alias" }, t.owner))).rejects.toBeInstanceOf(ConflictError);
    const c = await svc.findNameCandidates(scope, "레오", 1001, tl);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ entityId: leon.id, matchKind: "exact", score: 1 });
    // jamo fallback only for 4+ syllables (G20: short names never fuzzy-merge)
    const long = await ent(scope, "청운검진무");
    const fuzzy = await svc.findNameCandidates(scope, "청운검진모", 1001, tl);
    expect(fuzzy.map((x) => x.entityId)).toEqual([long.id]);
    expect(fuzzy[0]!.matchKind).toBe("jamo");
    // cross-script translit (06 §3.4 N8)
    const iron = await ent(scope, "아이언하트");
    expect((await svc.findNameCandidates(scope, "Iron Heart", 1001, tl)).map((x) => [x.entityId, x.matchKind])).toEqual([[iron.id, "translit"]]);
    await ent(scope, "민준");
    expect(await svc.findNameCandidates(scope, "민중", 1001, tl)).toEqual([]);
  });

  it("entity status transitions EN3/EN8 with reference guard", async () => {
    const { scope } = await newNovel();
    const e = await ent(scope, "후보", "character", { status: "candidate" });
    const a = await t.platform.uow.run((tx) => svc.setEntityStatus(tx, scope, e.id, "active", t.owner));
    expect(a.status).toBe("active");
    await expect(t.platform.uow.run((tx) => svc.setEntityStatus(tx, scope, e.id, "candidate", t.owner))).rejects.toBeInstanceOf(InvalidTransitionError);
    const r = await t.platform.uow.run((tx) => svc.setEntityStatus(tx, scope, e.id, "retired", t.owner));
    expect(r.status).toBe("retired");
  });
});

describe("facts: classification, promotion, range_close, slots", () => {
  it("G01 칭호 승계: holds_title succession closes the previous holder's range at promotion (F11) and holders are as-of", async () => {
    const { scope, tl } = await newNovel();
    const kingA = await ent(scope, "아르센");
    const kingB = await ent(scope, "레온");
    const crown = await ent(scope, "국왕", "title");
    await t.platform.uow.run((tx) => svc.addEntityName(tx, scope, crown.id, { surface: "폐하", nameKind: "title" }, t.owner));
    // bible-level canon: A holds the crown from 0
    const w1 = await t.platform.uow.run((tx) => svc.writeCandidateFacts(tx, scope, [draft(tl, { subjectEntityId: kingA.id, predicate: "holds_title", objectEntityId: crown.id, canonStatus: "approved" })], t.owner));
    expect(w1.written[0]!.diffKind).toBe("new");
    // episode 10 scene 3: A dies, B succeeds
    const ep = "epi_TEST10";
    const w2 = await t.platform.uow.run((tx) =>
      svc.writeCandidateFacts(
        tx,
        scope,
        [
          draft(tl, { subjectEntityId: kingB.id, predicate: "holds_title", objectEntityId: crown.id, episodeId: ep }, 10003),
          draft(tl, { factKind: "state", subjectEntityId: kingA.id, predicate: "life_status", value: "dead", episodeId: ep }, 10003),
        ],
        t.owner,
      ),
    );
    expect(w2.written.map((w) => w.diffKind)).toEqual(["transition", "new"]);
    expect(await svc.getTitleHolders(scope, crown.id, tl, 12001)).toEqual([{ entityId: kingA.id, storyRange: { from: 0, to: null } }]); // still candidate
    const p = await t.platform.uow.run((tx) => svc.promoteEpisodeFacts(tx, scope, ep, "approved", t.owner));
    expect(p).toEqual({ promoted: 2, held: [] });
    expect(await svc.getTitleHolders(scope, crown.id, tl, 5001)).toEqual([{ entityId: kingA.id, storyRange: { from: 0, to: 10003 } }]);
    expect(await svc.getTitleHolders(scope, crown.id, tl, 12001)).toEqual([{ entityId: kingB.id, storyRange: { from: 10003, to: null } }]);
    const closed = await t.testDb.db.select().from(factVersions).where(and(eq(factVersions.novelId, scope.novelId), eq(factVersions.changeReason, "range_close")));
    expect(closed).toHaveLength(1);
    const canon = await svc.getCanonAt(scope, [kingA.id], 12001, tl);
    expect(canon.map((f) => f.predicate)).toEqual(["life_status"]);
    // E13 / E14
    expect(await t.platform.uow.run((tx) => svc.promoteEpisodeFacts(tx, scope, ep, "published_locked", t.owner))).toEqual({ promoted: 2, held: [] });
    expect(await t.platform.uow.run((tx) => svc.demoteEpisodeFacts(tx, scope, ep, t.owner))).toEqual({ demoted: 2 });
  });

  it("never promotes facts citing ambiguous mentions (INV-ONT-07, NFR-QUAL-01) nor slot-conflicting facts (SL-3)", async () => {
    const { scope, tl } = await newNovel();
    const a = await ent(scope, "서준");
    const place1 = await ent(scope, "왕도", "place");
    const place2 = await ent(scope, "북부 성채", "place");
    const ep = "epi_AMB";
    const { mentionIds } = await t.platform.uow.run((tx) =>
      svc.writeMentions(
        tx,
        scope,
        [
          { sourceKind: "user_input", storyPoint: 3001, timelineId: tl, surface: "서준", mentionKind: "named", candidates: [{ entityId: a.id, score: 0.5 }], confidence: 0.5, linkStatus: "ambiguous", linkerVersion: "test" },
          { sourceKind: "user_input", storyPoint: 3001, timelineId: tl, surface: "서준", mentionKind: "named", candidates: [{ entityId: a.id, score: 1 }], linkedEntityId: a.id, confidence: 1, linkStatus: "auto_linked", linkerVersion: "test" },
        ],
        t.owner,
      ),
    );
    await t.platform.uow.run((tx) =>
      svc.writeCandidateFacts(
        tx,
        scope,
        [
          // link-held: subject unresolved (INV-ONT-08)
          draft(tl, { factKind: "state", subjectEntityId: null as unknown as string, predicate: "located_at", objectEntityId: place1.id, argMentions: { subject: mentionIds[0]! }, mentionIds: [mentionIds[0]!], episodeId: ep }, 3001),
          // resolved subject but cites the ambiguous mention
          draft(tl, { factKind: "state", subjectEntityId: a.id, predicate: "age", value: 20, mentionIds: [mentionIds[0]!], episodeId: ep }, 3001),
          // clean fact → promoted
          draft(tl, { factKind: "attribute", subjectEntityId: a.id, predicate: "gender", value: "남", mentionIds: [mentionIds[1]!], episodeId: ep }, 3001),
          // two located_at at the same point (conflict, 06 §6.6) → both held
          draft(tl, { factKind: "state", subjectEntityId: a.id, predicate: "located_at", objectEntityId: place1.id, mentionIds: [mentionIds[1]!], episodeId: ep }, 3001),
          draft(tl, { factKind: "state", subjectEntityId: a.id, predicate: "located_at", objectEntityId: place2.id, mentionIds: [mentionIds[1]!], episodeId: ep }, 3001),
        ],
        t.owner,
      ),
    );
    const r = await t.platform.uow.run((tx) => svc.promoteEpisodeFacts(tx, scope, ep, "approved", t.owner));
    expect(r.promoted).toBe(1);
    expect(r.held).toHaveLength(4);
    const canon = await t.testDb.db.select().from(facts).where(and(eq(facts.novelId, scope.novelId), eq(facts.canonStatus, "approved")));
    expect(canon.map((f) => f.predicate)).toEqual(["gender"]);
    // answer to the disambiguation fills the NULL role (LB-3)
    const dec = await t.platform.uow.run((tx) => svc.decideMention(tx, scope, mentionIds[0]!, { kind: "entity", entityId: a.id }, t.owner));
    expect(dec.filledFactIds).toHaveLength(1);
    const filled = await t.testDb.db.select().from(facts).where(eq(facts.id, dec.filledFactIds[0]!));
    expect(filled[0]!.subjectEntityId).toBe(a.id);
    expect(filled[0]!.slotKey).toBe(`s:${a.id}|located_at`);
    expect(await svc.checkIntegrity(scope)).toEqual([]);
  });

  it("G18 스키마 위반: two biological fathers (CR-09) and marriage after death (CR-11) are found and held", async () => {
    const { scope, tl } = await newNovel();
    const child = await ent(scope, "이안");
    const f1 = await ent(scope, "카인");
    const f2 = await ent(scope, "도르안");
    const wife = await ent(scope, "세라");
    const ep = "epi_G18";
    const w = await t.platform.uow.run((tx) =>
      svc.writeCandidateFacts(
        tx,
        scope,
        [
          draft(tl, { subjectEntityId: f1.id, predicate: "father_of", objectEntityId: child.id, episodeId: ep }),
          draft(tl, { subjectEntityId: f2.id, predicate: "father_of", objectEntityId: child.id, episodeId: ep }),
          draft(tl, { factKind: "state", subjectEntityId: f1.id, predicate: "life_status", value: "dead", episodeId: ep }, 5000),
          draft(tl, { subjectEntityId: f1.id, predicate: "spouse_of", objectEntityId: wife.id, episodeId: ep }, 6000),
          draft(tl, { subjectEntityId: f1.id, predicate: "not_in_schema", objectEntityId: wife.id, episodeId: ep }),
        ],
        t.owner,
      ),
    );
    expect(w.rejected).toEqual([{ index: 4, reason: "unknown_predicate:not_in_schema" }]);
    const v = await svc.findSchemaViolations(scope);
    const rules = v.map((x) => `${x.crRule}:${x.rule}`).sort();
    expect(rules).toContain("CR-09:max_per_object");
    expect(rules).toContain("CR-11:no_new_after_subject_death");
    expect(v.find((x) => x.rule === "max_per_object")!.schemaRuleKey).toBe("base@1:father_of:max_per_object");
    const p = await t.platform.uow.run((tx) => svc.promoteEpisodeFacts(tx, scope, ep, "approved", t.owner));
    expect(p.promoted).toBe(1); // only the life_status fact
    expect(p.held).toHaveLength(3);
  });

  it("recorded-time canon (bitemporal, 06 §6.2)", async () => {
    const { scope, tl } = await newNovel();
    const a = await ent(scope, "하윤");
    await t.platform.uow.run((tx) => svc.writeCandidateFacts(tx, scope, [draft(tl, { factKind: "attribute", subjectEntityId: a.id, predicate: "age", value: 17, canonStatus: "approved" })], t.owner));
    const before = new Date(Date.now() - 60_000);
    const now = new Date(Date.now() + 60_000);
    expect(await svc.getCanonAsRecorded(scope, [a.id], 1000, tl, before)).toEqual([]);
    expect((await svc.getCanonAsRecorded(scope, [a.id], 1000, tl, now)).map((f) => f.value)).toEqual([17]);
  });
});

describe("identity decisions (FR-ONT-16)", () => {
  it("merge moves every reference and revert restores facts, mentions, names, slots and statuses", async () => {
    const { scope, tl } = await newNovel();
    const s = await ent(scope, "레온");
    const l = await ent(scope, "가면 기사");
    await t.platform.uow.run((tx) => svc.addEntityName(tx, scope, s.id, { surface: "레오", nameKind: "alias" }, t.owner));
    await t.platform.uow.run((tx) => svc.addEntityName(tx, scope, l.id, { surface: "레오", nameKind: "alias" }, t.owner));
    const place = await ent(scope, "왕도", "place");
    const place2 = await ent(scope, "변경", "place");
    const { mentionIds } = await t.platform.uow.run((tx) =>
      svc.writeMentions(tx, scope, [{ sourceKind: "user_input", storyPoint: 2001, timelineId: tl, surface: "가면 기사", mentionKind: "named", candidates: [], linkedEntityId: l.id, confidence: 1, linkStatus: "auto_linked", linkerVersion: "test" }], t.owner),
    );
    await t.platform.uow.run((tx) =>
      svc.writeCandidateFacts(
        tx,
        scope,
        [
          draft(tl, { factKind: "state", subjectEntityId: s.id, predicate: "located_at", objectEntityId: place.id, canonStatus: "approved" }, 0),
          // absorbed side canon fact in the same slot → demoted on merge (06 §3.11 step 6)
          draft(tl, { factKind: "state", subjectEntityId: l.id, predicate: "located_at", objectEntityId: place2.id, canonStatus: "approved", mentionIds }, 2000),
        ],
        t.owner,
      ),
    );
    const snapshot = async () => ({
      facts: (await t.testDb.db.select({ id: facts.id, s: facts.subjectEntityId, st: facts.canonStatus, k: facts.slotKey }).from(facts).where(eq(facts.novelId, scope.novelId))).sort((a, b) => a.id.localeCompare(b.id)),
      mentions: await t.testDb.db.select({ id: mentions.id, e: mentions.linkedEntityId, st: mentions.linkStatus }).from(mentions).where(eq(mentions.novelId, scope.novelId)),
      names: (await t.testDb.db.select({ id: entityNames.id, e: entityNames.entityId, st: entityNames.status, p: entityNames.isPreferred, r: entityNames.storyRange }).from(entityNames).where(eq(entityNames.novelId, scope.novelId))).sort((a, b) => a.id.localeCompare(b.id)),
      entities: (await t.testDb.db.select({ id: entities.id, st: entities.status, m: entities.mergedIntoId }).from(entities).where(eq(entities.novelId, scope.novelId))).sort((a, b) => a.id.localeCompare(b.id)),
      slots: (await t.testDb.db.select().from(factCardinalitySlots).where(eq(factCardinalitySlots.novelId, scope.novelId))).map((x) => `${x.factId}|${x.slotKey}|${x.storyRange}`).sort(),
    });
    const before = await snapshot();
    const dec = await t.platform.uow.run((tx) => svc.proposeIdentityDecision(tx, scope, { kind: "merge", entityIds: [s.id, l.id], survivorEntityId: s.id, rationale: "정체 공개" }, t.owner));
    expect(dec.status).toBe("proposed");
    expect((dec.impact as { slotConflicts: unknown[] }).slotConflicts).toHaveLength(1);
    const applied = await t.platform.uow.run((tx) => svc.applyIdentityDecision(tx, scope, dec.id, t.owner));
    expect(applied.status).toBe("applied");
    const mid = await snapshot();
    expect(mid.entities.find((e) => e.id === l.id)).toMatchObject({ st: "merged", m: s.id });
    expect(mid.mentions[0]!.e).toBe(s.id);
    expect(mid.facts.every((f) => f.s === s.id)).toBe(true);
    expect(mid.facts.filter((f) => f.st === "approved")).toHaveLength(1); // absorbed one demoted
    expect(mid.names.filter((n) => n.e === l.id && n.st !== "retired")).toHaveLength(0);
    expect(mid.names.filter((n) => n.st === "retired")).toHaveLength(1); // duplicate alias "레오" retired (INV-ONT-03)
    expect(await svc.resolveEntityId(scope, l.id)).toBe(s.id);
    expect(await svc.checkIntegrity(scope)).toEqual([]);
    const moves = await t.testDb.db.select().from(identityDecisionMoves).where(eq(identityDecisionMoves.decisionId, dec.id));
    expect(moves.length).toBeGreaterThan(3);
    // HTTP: merged id redirects
    const red = await t.http("GET", `/api/novels/${scope.novelId}/entities/${l.id}`);
    expect(red.body).toEqual({ redirectTo: s.id, redirectedFrom: l.id });
    // revert
    const rev = await t.http("POST", `/api/novels/${scope.novelId}/identity-decisions/${dec.id}/revert`, {});
    expect(rev.status).toBe(200);
    expect(rev.body.status).toBe("reverted");
    const after = await snapshot();
    expect(after.entities).toEqual(before.entities);
    expect(after.mentions).toEqual(before.mentions);
    expect(after.names).toEqual(before.names);
    expect(after.facts).toEqual(before.facts);
    expect(after.slots).toEqual(before.slots);
    expect(await svc.checkIntegrity(scope)).toEqual([]);
  });

  it("revert refuses when a moved reference changed afterwards (step 3/5)", async () => {
    const { scope, tl } = await newNovel();
    const a = await ent(scope, "가온");
    const b = await ent(scope, "가온", "character", { disambiguator: "분가" });
    const c = await ent(scope, "누리");
    const { mentionIds } = await t.platform.uow.run((tx) =>
      svc.writeMentions(tx, scope, [{ sourceKind: "user_input", storyPoint: 1001, timelineId: tl, surface: "가온", mentionKind: "named", candidates: [], linkedEntityId: b.id, confidence: 1, linkStatus: "auto_linked", linkerVersion: "t" }], t.owner),
    );
    const dec = await t.platform.uow.run(async (tx) => {
      const d = await svc.proposeIdentityDecision(tx, scope, { kind: "merge", entityIds: [a.id, b.id], rationale: "x" }, t.owner);
      return svc.applyIdentityDecision(tx, scope, d.id, t.owner);
    });
    // a later relink moves the mention elsewhere
    await t.platform.uow.run(async (tx) => {
      const r = await svc.proposeIdentityDecision(tx, scope, { kind: "relink", entityIds: [a.id], relinkToEntityId: c.id, mentionIds, rationale: "오연결" }, t.owner);
      await svc.applyIdentityDecision(tx, scope, r.id, t.owner);
    });
    await expect(t.platform.uow.run((tx) => svc.revertIdentityDecision(tx, scope, dec.id, t.owner))).rejects.toMatchObject({ code: "identity_revert_conflict" });
  });

  it("requires identity_change approval when published facts are touched", async () => {
    const { scope, tl } = await newNovel();
    const a = await ent(scope, "도윤");
    const b = await ent(scope, "도윤", "character", { disambiguator: "2" });
    const ep = "epi_PUB";
    await t.platform.uow.run((tx) => svc.writeCandidateFacts(tx, scope, [draft(tl, { factKind: "attribute", subjectEntityId: b.id, predicate: "gender", value: "남", episodeId: ep })], t.owner));
    await t.platform.uow.run((tx) => svc.promoteEpisodeFacts(tx, scope, ep, "approved", t.owner));
    await t.platform.uow.run((tx) => svc.promoteEpisodeFacts(tx, scope, ep, "published_locked", t.owner));
    const dec = await t.platform.uow.run((tx) => svc.proposeIdentityDecision(tx, scope, { kind: "merge", entityIds: [a.id, b.id], rationale: "x" }, t.owner));
    await expect(t.platform.uow.run((tx) => svc.applyIdentityDecision(tx, scope, dec.id, t.owner))).rejects.toMatchObject({ code: "identity_change_approval_required" });
  });
});

describe("knowledge, names visibility and cards (06 §3.3, §3.12, §7)", () => {
  it("disguise identity is hidden from unaware viewers and split into its own card", async () => {
    const { scope, tl } = await newNovel();
    const leon = await ent(scope, "레온");
    const erin = await ent(scope, "에린");
    const mask = await t.platform.uow.run((tx) =>
      svc.addEntityName(tx, scope, leon.id, { surface: "가면 기사", nameKind: "disguise", identityVisibility: "restricted", readerRevealPoint: 35004 }, t.owner),
    );
    expect(await svc.identityKnownBy(scope, mask.id, erin.id, 20001)).toBe(false);
    expect(await svc.surfaceKnownBy(scope, mask.id, erin.id, 20001)).toBe(true);
    expect(await svc.identityKnownBy(scope, mask.id, "narrator", 20001)).toBe(false);
    expect(await svc.identityKnownBy(scope, mask.id, "narrator", 35004)).toBe(true);
    // Erin learns at 30007 (knows_identity)
    await t.platform.uow.run((tx) =>
      svc.writeCandidateFacts(tx, scope, [draft(tl, { factKind: "knowledge", subjectEntityId: erin.id, predicate: "knows_identity", objectNameId: mask.id, knowledgeStance: "knows", canonStatus: "approved" }, 30007)], t.owner),
    );
    expect(await svc.identityKnownBy(scope, mask.id, erin.id, 30007)).toBe(true);
    expect((await svc.knowledgeOf(scope, erin.id, 30007, tl)).map((f) => f.predicate)).toEqual(["knows_identity"]);
    const cards = await svc.getEntityCards(scope, [leon.id], { storyPoint: 20001, timelineId: tl, povEntityId: erin.id }, "pov");
    expect(cards.map((c) => c.displayName)).toEqual(["레온", "가면 기사"]);
    const canonCards = await svc.getEntityCards(scope, [leon.id], { storyPoint: 20001, timelineId: tl }, "canon");
    expect(canonCards).toHaveLength(1);
  });
});

describe("HTTP + health", () => {
  it("serves entities, schema, timelines and runs ontology_integrity", async () => {
    const { scope } = await newNovel();
    const base = `/api/novels/${scope.novelId}`;
    const c = await t.http("POST", `${base}/entities`, { entityType: "character", preferredName: "한서윤" });
    expect(c.status).toBe(201);
    const id = c.body.entity.id as string;
    expect((await t.http("POST", `${base}/entities/${id}/names`, { surface: "서윤", nameKind: "alias" })).status).toBe(201);
    const list = await t.http("GET", `${base}/entities?type=character&q=서윤`);
    expect(list.body.items.map((i: { preferredName: string }) => i.preferredName)).toEqual(["한서윤"]);
    const detail = await t.http("GET", `${base}/entities/${id}`);
    expect(detail.body.names).toHaveLength(2);
    expect((await t.http("GET", `${base}/entities/${id}/facts?storyPoint=1000`)).body.items).toEqual([]);
    expect((await t.http("GET", `${base}/entities/${id}/mentions`)).body.items).toEqual([]);
    const schema = await t.http("GET", `${base}/schema`);
    expect(schema.body.baseSchemaKey).toBe("base@1");
    expect(schema.body.relationTypes.some((r: { key: string }) => r.key === "holds_title")).toBe(true);
    expect((await t.http("GET", `${base}/timelines`)).body.items).toHaveLength(1);
    expect((await t.http("GET", `${base}/identity-decisions`)).body.items).toEqual([]);
    expect((await t.http("GET", `${base}/entities/ent_00000000000000000000000000`)).status).toBe(404);
    const hc = await t.modules.system.service.runHealthChecks({ kinds: ["ontology_integrity"], novelId: scope.novelId });
    expect(hc.find((r) => r.name === "ontology_integrity")?.status).toBe("pass");
  });
});
