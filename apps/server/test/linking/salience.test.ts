/** 설계 추가 0015: pure parts of the entity resolver (salience filter, wording, thresholds, answer check, sensitivity). */
import { describe, expect, it } from "vitest";
import { classifySurface, isCoreferenceOnly } from "../../src/modules/linking/domain/salience.js";
import { asksWho } from "../../src/modules/linking/application/commit.js";
import { contested, planAction } from "../../src/modules/linking/application/agent-resolution.js";
import { checkResolution, type ResolverItem } from "../../src/modules/linking/application/resolver.js";
import { safeExactCandidate } from "../../src/modules/linking/application/linker.js";
import { HIGH_SENSITIVITY_TOPICS, HOLD_TOPICS, questionSensitivity } from "../../src/modules/hitl/domain/grading.js";

describe("salience filter", () => {
  it("pronouns (incl. spaced forms and mention_kind pronoun) are coreference only", () => {
    for (const s of ["그", "그녀", "그들", "이것", "저 사람", "저사람", "당신"]) expect(classifySurface(s, "named"), s).toBe("pronoun");
    expect(classifySurface("녀석들", "pronoun")).toBe("pronoun");
    expect(isCoreferenceOnly("pronoun")).toBe(true);
  });
  it("generic address forms / role + 님 are coreference only; names with 씨 are not", () => {
    expect(classifySurface("선생님", "address")).toBe("address");
    expect(classifySurface("판정관님", "address")).toBe("address");
    expect(classifySurface("협회장님", "title")).toBe("address");
    expect(classifySurface("이온 씨", "address")).toBe("candidate");
    expect(classifySurface("서이온", "named")).toBe("candidate");
  });
  it("common nouns are ignored; generic places (alone or with a modifier) are only a hint", () => {
    for (const s of ["화면", "결승전", "관중"]) expect(classifySurface(s, "descriptive"), s).toBe("generic");
    for (const s of ["센터", "게이트", "판정소", "관리 기구", "재활 센터"]) expect(classifySurface(s, "descriptive"), s).toBe("generic_hint");
    expect(classifySurface("구립 체육관", "named")).toBe("generic_hint");
    expect(classifySurface("구립 체육관", "descriptive")).toBe("generic_hint");
    expect(classifySurface("검은 탑", "descriptive")).toBe("candidate");
    // remembered non-entities (glossary memory) are generic too
    expect(classifySurface("붉은 문", "descriptive", new Set(["붉은문"]))).toBe("generic");
    expect(classifySurface("", "zero")).toBe("candidate");
  });
});

describe("question wording", () => {
  it("누구 only for persons (type, pronoun-like kinds, a person candidate); 무엇 otherwise", () => {
    expect(asksWho({ entityType: "character" })).toBe(true);
    expect(asksWho({ entityType: "place", mentionKind: "address" })).toBe(false);
    expect(asksWho({ mentionKind: "pronoun" })).toBe(true);
    expect(asksWho({ mentionKind: "descriptive", topCandidateType: "character" })).toBe(true);
    expect(asksWho({ mentionKind: "descriptive", topCandidateType: "organization" })).toBe(false);
    expect(asksWho({ mentionKind: "named" })).toBe(false);
  });
});

describe("decisions", () => {
  const d = (action: "link_existing" | "add_alias" | "create_entity" | "ignore", confidence: number) => ({ action, entityId: "E", entityType: "place", canonicalName: null, mergeWithId: null, confidence, rationale: "" });
  it("applies at/above the threshold; below it asks only when contested, else holds (pronouns never asked)", () => {
    const o = { salience: "candidate" as const, minConfidence: 0.75, asked: true, contested: true };
    expect(planAction(d("link_existing", 0.75), o)).toBe("link");
    expect(planAction(d("add_alias", 0.9), o)).toBe("alias");
    expect(planAction(d("add_alias", 0.9), { ...o, salience: "address" })).toBe("link");
    expect(planAction(d("create_entity", 0.9), { ...o, salience: "pronoun" })).toBe("hold");
    expect(planAction(d("ignore", 0.8), o)).toBe("ignore");
    expect(planAction(d("link_existing", 0.5), o)).toBe("ask");
    expect(planAction(d("link_existing", 0.5), { ...o, contested: false })).toBe("hold");
    expect(planAction(d("link_existing", 0.5), { ...o, salience: "pronoun" })).toBe("hold");
    // a new name the resolver is unsure about stays a candidate entity (old path)
    expect(planAction(d("ignore", 0.4), { ...o, asked: false, contested: false })).toBe("keep");
    // model failure: names keep the old path, pronoun-like / backdrop surfaces are held
    expect(planAction(undefined, o)).toBe("keep");
    expect(planAction(undefined, { ...o, salience: "pronoun" })).toBe("hold");
  });
  it("contested = two or more active, name-matched entities", () => {
    const st = (id: string) => (id === "C" ? "candidate" : "active");
    expect(contested([{ entityId: "A", via: "exact" }, { entityId: "B", via: "exact" }], st)).toBe(true);
    expect(contested([{ entityId: "A", via: "exact" }, { entityId: "C", via: "exact" }], st)).toBe(false);
    expect(contested([{ entityId: "A", via: "scene" }, { entityId: "B", via: "scene" }], st)).toBe(false);
  });
  it("safe exact alias link needs exactly one live (active or candidate) exact candidate without flags", () => {
    const c = (f: Record<string, unknown>) => ({ entityId: "A", label: "A", ruleScore: 1, features: { matchKind: "exact" as const, baseScore: 1, candidateEntityStatus: "active" as const, ...f } });
    expect(safeExactCandidate([c({})])).toBe("A");
    expect(safeExactCandidate([c({}), { ...c({}), entityId: "B" }])).toBeNull();
    expect(safeExactCandidate([c({ confusable: true })])).toBeNull();
    expect(safeExactCandidate([c({ candidateEntityStatus: "candidate" })])).toBe("A"); // alias memory on a candidate entity
    expect(safeExactCandidate([c({ hiddenVariant: true })])).toBeNull();
    expect(safeExactCandidate([c({ matchKind: "jamo" })])).toBeNull();
  });
  it("answer check: unknown handles / types and missing items become repair issues", () => {
    const items: ResolverItem[] = [
      { key: "a", surface: "이온 씨", mentionKind: "address", contexts: [], candidateIds: [], salience: "candidate" },
      { key: "b", surface: "탑", mentionKind: "named", contexts: [], candidateIds: [], salience: "candidate" },
      { key: "c", surface: "", mentionKind: "named", contexts: [], candidateIds: ["X", "Y"], salience: "candidate", pair: { a: "X", b: "Y" } },
    ];
    const ents = new Map([
      ["K1", "X"],
      ["K2", "Y"],
    ]);
    const types = new Set(["character", "place"]);
    const ok = checkResolution(
      {
        resolutions: [
          { mention: "M1", action: "add_alias", entity: "K1", confidence: 0.9, rationale: "" },
          { mention: "M2", action: "create_entity", entity_type: "location", confidence: 0.8, rationale: "" },
          { mention: "M3", action: "merge", merge_with: "K2", confidence: 0.9, rationale: "" },
        ],
      },
      items,
      ents,
      types,
    );
    expect(ok.issues).toEqual([]);
    expect(ok.result.decisions.get(1)).toMatchObject({ action: "create_entity", entityType: "place", canonicalName: "탑" });
    expect(ok.result.decisions.get(2)).toMatchObject({ action: "merge", mergeWithId: "Y" });
    const bad = checkResolution({ resolutions: [{ mention: "M1", action: "link_existing", entity: "E9", confidence: 0.9, rationale: "" }, { mention: "M7", action: "ignore", confidence: 1, rationale: "" }] }, items, ents, types);
    expect(bad.issues.map((i) => i.item)).toEqual(["M1 link_existing", "M7 ignore", 'M2 "탑"', 'M3 ""']);
  });
});

describe("question sensitivity (hitl grading)", () => {
  it("entity_disambiguation / duplicate_entity are normal (auto-answerable) but still never applied at the deadline", () => {
    expect(HIGH_SENSITIVITY_TOPICS.has("entity_disambiguation")).toBe(false);
    expect(HIGH_SENSITIVITY_TOPICS.has("duplicate_entity")).toBe(false);
    expect(HIGH_SENSITIVITY_TOPICS.has("interpretation_confirm")).toBe(true);
    expect(HOLD_TOPICS.has("entity_disambiguation")).toBe(true);
    expect(questionSensitivity({ topic: "duplicate_entity", basis: "none" })).toBe("normal");
    expect(questionSensitivity({ topic: "duplicate_entity", basis: "none", hints: { touchesPublishedCanon: true } })).toBe("high");
  });
});
