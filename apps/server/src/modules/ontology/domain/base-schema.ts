/**
 * OntologySchema definitions (06 §4.1) and the read-only base schema `base@1` (06 §4.2–4.3).
 *
 * 06 §4.1 places `base@<n>` in packages/shared as install-level read-only data. Shared files are not
 * owned by the ontology agent in this phase, so the data lives here (pure, no I/O) and is exposed via
 * `GET …/schema` and `OntologyService.getSchema()`. Integration may move it to `@ncs/shared` unchanged.
 */
import { z } from "zod";
import { normalizedKey } from "./normalize.js";

export const temporalRuleSchema = z.enum([
  "no_new_after_subject_death",
  "no_new_after_object_death",
  "end_at_or_before_subject_death",
  "range_within_subject_life",
  "monotonic_non_decreasing",
]);
export type TemporalRule = z.infer<typeof temporalRuleSchema>;

export const entityTypeDefSchema = z.object({
  key: z.string(),
  labelKo: z.string(),
  parent: z.string().optional(),
  description: z.string(),
  enabled: z.boolean(),
  attributesAllowed: z.array(z.string()),
});
export type EntityTypeDef = z.infer<typeof entityTypeDefSchema>;

export const relationTypeDefSchema = z.object({
  key: z.string(),
  labelKo: z.string(),
  description: z.string(),
  synonyms: z.array(z.string()),
  parentKey: z.string().optional(),
  domain: z.array(z.string()),
  range: z.union([z.array(z.string()), z.literal("fact"), z.literal("entity_name"), z.literal("value")]),
  maxPerSubject: z.literal(1).optional(),
  maxPerObject: z.union([z.literal(1), z.literal("title.max_holders")]).optional(),
  symmetric: z.boolean(),
  asymmetric: z.boolean(),
  irreflexive: z.boolean(),
  inverseLabelKo: z.string().optional(),
  inverseSynonyms: z.array(z.string()),
  factKind: z.enum(["relation", "knowledge", "state", "event"]),
  temporal: z.array(temporalRuleSchema),
  disjointWith: z.array(z.string()),
  possessionSide: z.enum(["body", "persona"]).optional(),
  posthumousAllowed: z.boolean(),
  defaultSeverity: z.enum(["high", "medium", "low"]),
});
export type RelationTypeDef = z.infer<typeof relationTypeDefSchema>;

export const attributeDefSchema = z.object({
  key: z.string(),
  labelKo: z.string(),
  synonyms: z.array(z.string()).default([]),
  domain: z.array(z.string()),
  valueType: z.enum(["string", "integer", "enum", "json", "positive_int_or_unbounded"]),
  enumValues: z.array(z.string()).optional(),
  singleValued: z.boolean(),
  temporal: z.array(temporalRuleSchema),
  visualAttribute: z.boolean(),
  /** fact_kind used when storing this attribute */
  factKind: z.enum(["attribute", "state", "rule"]),
  possessionSide: z.enum(["body", "persona"]).optional(),
  defaultSeverity: z.enum(["high", "medium", "low"]),
  /** `appearance.*` style keys accept any `<prefix>.<part>` suffix */
  isPrefix: z.boolean().optional(),
});
export type AttributeDef = z.infer<typeof attributeDefSchema>;

export const ontologySchemaDataSchema = z.object({
  key: z.string(),
  entityTypes: z.array(entityTypeDefSchema),
  relationTypes: z.array(relationTypeDefSchema),
  attributes: z.array(attributeDefSchema),
});
export type OntologySchemaData = z.infer<typeof ontologySchemaDataSchema>;

const CH = ["character"];
const R = (d: Partial<RelationTypeDef> & Pick<RelationTypeDef, "key" | "labelKo" | "domain" | "range" | "defaultSeverity">): RelationTypeDef => {
  const symmetric = d.symmetric ?? false;
  return {
    description: d.labelKo,
    synonyms: [],
    inverseSynonyms: [],
    symmetric,
    asymmetric: d.asymmetric ?? !symmetric,
    irreflexive: d.irreflexive ?? true,
    factKind: "relation",
    temporal: [],
    disjointWith: [],
    posthumousAllowed: false,
    ...d,
  };
};
const A = (d: Partial<AttributeDef> & Pick<AttributeDef, "key" | "labelKo" | "domain" | "valueType" | "singleValued">): AttributeDef => ({
  synonyms: [],
  temporal: [],
  visualAttribute: false,
  factKind: "attribute",
  defaultSeverity: "medium",
  ...d,
});

/** base@1 (06 §4.2, §4.3) */
export const BASE_SCHEMA_V1: OntologySchemaData = {
  key: "base@1",
  entityTypes: [
    { key: "character", labelKo: "인물", description: "인물(동물·영물 포함, 가정)", enabled: true, attributesAllowed: [] },
    { key: "place", labelKo: "장소", description: "장소. 계층은 located_in", enabled: true, attributesAllowed: [] },
    { key: "organization", labelKo: "조직", description: "조직·가문", enabled: true, attributesAllowed: [] },
    { key: "item", labelKo: "사물", description: "사물", enabled: true, attributesAllowed: [] },
    { key: "event", labelKo: "사건", description: "사건", enabled: true, attributesAllowed: [] },
    { key: "rule", labelKo: "규칙·설정", description: "세계 규칙", enabled: true, attributesAllowed: [] },
    { key: "ability", labelKo: "능력·시스템", description: "능력·시스템", enabled: true, attributesAllowed: [] },
    { key: "title", labelKo: "칭호·직위", description: "칭호·직위. 속성 max_holders(기본 1)", enabled: true, attributesAllowed: [] },
    { key: "persona", labelKo: "인격", description: "빙의 모델에서만", enabled: false, attributesAllowed: [] },
    { key: "body", labelKo: "몸", description: "빙의 모델에서만", enabled: false, attributesAllowed: [] },
  ],
  relationTypes: [
    R({ key: "father_of", labelKo: "생부", synonyms: ["아버지", "부친"], inverseSynonyms: ["아들", "딸"], domain: CH, range: CH, maxPerObject: 1, posthumousAllowed: true, defaultSeverity: "high" }),
    R({ key: "mother_of", labelKo: "생모", synonyms: ["어머니", "모친"], inverseSynonyms: ["아들", "딸"], domain: CH, range: CH, maxPerObject: 1, posthumousAllowed: true, defaultSeverity: "high" }),
    R({ key: "adoptive_parent_of", labelKo: "양부모", synonyms: ["의부", "의모", "양부", "양모"], inverseSynonyms: ["양자", "양녀"], domain: CH, range: CH, temporal: ["no_new_after_subject_death"], defaultSeverity: "medium" }),
    R({ key: "sibling_of", labelKo: "형제자매", synonyms: ["형", "누나", "언니", "오빠", "동생", "형제", "자매"], domain: CH, range: CH, symmetric: true, defaultSeverity: "medium" }),
    R({ key: "spouse_of", labelKo: "배우자", synonyms: ["남편", "아내", "혼인", "부부"], domain: CH, range: CH, symmetric: true, maxPerSubject: 1, maxPerObject: 1, temporal: ["no_new_after_subject_death", "no_new_after_object_death"], defaultSeverity: "high" }),
    R({ key: "master_of", labelKo: "사부", synonyms: ["스승"], inverseSynonyms: ["제자"], domain: CH, range: CH, temporal: ["no_new_after_subject_death"], possessionSide: "persona", defaultSeverity: "medium" }),
    R({ key: "subordinate_of", labelKo: "부하", synonyms: ["수하", "휘하", "수족"], inverseSynonyms: ["상관"], domain: CH, range: ["character", "organization"], temporal: ["no_new_after_subject_death"], defaultSeverity: "medium" }),
    R({ key: "member_of", labelKo: "소속", synonyms: ["단원", "문도"], domain: CH, range: ["organization"], temporal: ["range_within_subject_life"], defaultSeverity: "medium" }),
    R({ key: "leader_of", labelKo: "수장", synonyms: ["우두머리"], domain: CH, range: ["organization"], maxPerObject: 1, temporal: ["end_at_or_before_subject_death"], defaultSeverity: "high" }),
    R({ key: "ally_of", labelKo: "동맹", synonyms: ["협력"], domain: ["character", "organization"], range: ["character", "organization"], symmetric: true, defaultSeverity: "low" }),
    R({ key: "enemy_of", labelKo: "적대", synonyms: ["원수"], domain: ["character", "organization"], range: ["character", "organization"], symmetric: true, disjointWith: ["ally_of"], defaultSeverity: "medium" }),
    R({ key: "loves", labelKo: "연모", synonyms: ["짝사랑"], domain: CH, range: CH, asymmetric: false, possessionSide: "persona", defaultSeverity: "low" }),
    R({ key: "holds_title", labelKo: "칭호 보유", synonyms: ["즉위", "취임"], domain: CH, range: ["title"], maxPerObject: "title.max_holders", temporal: ["end_at_or_before_subject_death"], defaultSeverity: "high" }),
    R({ key: "located_in", labelKo: "위치(장소 계층)", domain: ["place"], range: ["place"], maxPerSubject: 1, defaultSeverity: "medium" }),
    R({ key: "located_at", labelKo: "현재 위치", domain: ["character", "item"], range: ["place"], maxPerSubject: 1, factKind: "state", defaultSeverity: "high" }),
    R({ key: "headquartered_in", labelKo: "본거지", domain: ["organization"], range: ["place"], maxPerSubject: 1, defaultSeverity: "low" }),
    R({ key: "part_of", labelKo: "하위 조직", synonyms: ["분가", "지부"], domain: ["organization"], range: ["organization"], maxPerSubject: 1, defaultSeverity: "medium" }),
    R({ key: "owns", labelKo: "소유", synonyms: ["보유"], domain: ["character", "organization"], range: ["item"], maxPerObject: 1, temporal: ["end_at_or_before_subject_death"], defaultSeverity: "medium" }),
    R({ key: "has_ability", labelKo: "능력 보유", synonyms: ["습득"], domain: ["character", "persona"], range: ["ability"], possessionSide: "persona", defaultSeverity: "medium" }),
    R({ key: "participated_in", labelKo: "참여", synonyms: ["가담"], domain: ["character", "organization"], range: ["event"], temporal: ["range_within_subject_life"], factKind: "event", defaultSeverity: "medium" }),
    R({ key: "occurred_at", labelKo: "사건 장소", domain: ["event"], range: ["place"], maxPerSubject: 1, factKind: "event", defaultSeverity: "medium" }),
    R({ key: "inhabits", labelKo: "빙의", domain: ["persona"], range: ["body"], maxPerSubject: 1, maxPerObject: 1, defaultSeverity: "high" }),
    R({ key: "counterpart_of", labelKo: "동위체", domain: CH, range: CH, symmetric: true, defaultSeverity: "low" }),
    R({ key: "knows_fact", labelKo: "앎", domain: ["character", "persona"], range: "fact", asymmetric: false, irreflexive: false, factKind: "knowledge", possessionSide: "persona", defaultSeverity: "high" }),
    R({ key: "knows_identity", labelKo: "정체를 앎", domain: ["character", "persona"], range: "entity_name", asymmetric: false, irreflexive: false, factKind: "knowledge", possessionSide: "persona", defaultSeverity: "high" }),
    R({ key: "believes", labelKo: "믿음·의심·오해", synonyms: ["의심", "오해"], domain: ["character", "persona"], range: "value", asymmetric: false, irreflexive: false, factKind: "knowledge", possessionSide: "persona", defaultSeverity: "high" }),
    R({ key: "retains_memory", labelKo: "이전 시간선 기억 유지", domain: ["character", "persona"], range: "value", maxPerSubject: 1, asymmetric: false, irreflexive: false, factKind: "state", defaultSeverity: "high" }),
  ],
  attributes: [
    A({ key: "life_status", labelKo: "생사", synonyms: ["생존", "사망"], domain: ["character", "body"], valueType: "enum", enumValues: ["alive", "dead", "unknown"], singleValued: true, factKind: "state", defaultSeverity: "high" }),
    A({ key: "age", labelKo: "나이", domain: ["character", "body"], valueType: "integer", singleValued: true, temporal: ["monotonic_non_decreasing"], visualAttribute: true }),
    A({ key: "gender", labelKo: "성별", domain: ["character", "body", "persona"], valueType: "string", singleValued: true }),
    A({ key: "appearance", labelKo: "외형", domain: ["character", "body"], valueType: "string", singleValued: true, visualAttribute: true, isPrefix: true }),
    A({ key: "outfit", labelKo: "의상", domain: ["character", "body"], valueType: "string", singleValued: false, visualAttribute: true, defaultSeverity: "low" }),
    A({ key: "injury", labelKo: "부상", domain: ["character", "body"], valueType: "json", singleValued: false, visualAttribute: true, factKind: "state" }),
    A({ key: "personality", labelKo: "성격", domain: ["character", "persona"], valueType: "string", singleValued: false, possessionSide: "persona", defaultSeverity: "low" }),
    A({ key: "rule_statement", labelKo: "규칙 내용", domain: ["rule"], valueType: "string", singleValued: true, factKind: "rule" }),
    A({ key: "ability_cost", labelKo: "능력 대가", domain: ["ability"], valueType: "string", singleValued: false }),
    A({ key: "ability_limit", labelKo: "능력 한계", domain: ["ability"], valueType: "string", singleValued: false }),
    A({ key: "max_holders", labelKo: "최대 보유자 수", domain: ["title"], valueType: "positive_int_or_unbounded", singleValued: true }),
    A({ key: "travel_time_days", labelKo: "이동 일수", domain: ["place"], valueType: "json", singleValued: false, defaultSeverity: "low" }),
  ],
};

export const BASE_SCHEMAS: Record<string, OntologySchemaData> = { "base@1": BASE_SCHEMA_V1 };

export type PredicateDef = { kind: "relation"; def: RelationTypeDef } | { kind: "attribute"; def: AttributeDef };

/** resolve a stored predicate key (`appearance.hair` resolves to the `appearance` prefix attribute) */
export function lookupPredicate(schema: OntologySchemaData, key: string): PredicateDef | null {
  const rel = schema.relationTypes.find((r) => r.key === key);
  if (rel) return { kind: "relation", def: rel };
  const attr = schema.attributes.find((a) => a.key === key || (a.isPrefix && key.startsWith(`${a.key}.`) && key.length > a.key.length + 1));
  return attr ? { kind: "attribute", def: attr } : null;
}

/**
 * 06 §4.5 step 2(a) / §4.6: map a surface predicate label (key, Korean label, synonym, inverse expression)
 * to a schema key. `inverted` = the caller must swap subject/object (inverse synonyms, e.g. "제자").
 */
export function mapPredicateLabel(schema: OntologySchemaData, label: string): { key: string; inverted: boolean } | null {
  const k = normalizedKey(label);
  const direct = lookupPredicate(schema, label);
  if (direct) return { key: direct.def.key === "appearance" ? label : direct.def.key, inverted: false };
  for (const r of schema.relationTypes) {
    if ([r.labelKo, ...r.synonyms].some((s) => normalizedKey(s) === k)) return { key: r.key, inverted: false };
  }
  for (const r of schema.relationTypes) {
    if ([r.inverseLabelKo ?? "", ...r.inverseSynonyms].some((s) => s && normalizedKey(s) === k)) {
      return { key: r.key, inverted: !r.symmetric };
    }
  }
  for (const a of schema.attributes) {
    if ([a.labelKo, ...a.synonyms].some((s) => normalizedKey(s) === k)) return { key: a.key, inverted: false };
  }
  return null;
}

/** merge base + novel extension (`ontology_schema_versions.extension`; MVP-α extensions are empty) */
export function compileSchema(baseKey: string, extension: unknown): OntologySchemaData {
  const base = BASE_SCHEMAS[baseKey] ?? BASE_SCHEMA_V1;
  const ext = ontologySchemaDataSchema.partial().safeParse(extension ?? {});
  if (!ext.success) return base;
  return {
    key: baseKey,
    entityTypes: [...base.entityTypes, ...(ext.data.entityTypes ?? [])],
    relationTypes: [...base.relationTypes, ...(ext.data.relationTypes ?? [])],
    attributes: [...base.attributes, ...(ext.data.attributes ?? [])],
  };
}
