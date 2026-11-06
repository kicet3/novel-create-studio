/**
 * World ontology proposal (build_world_ontology output) and its mapping onto base@1 (설계 추가: 세계관 온톨로지).
 * Pure: schema of the model output, normalization (keys, names, predicates, source URLs), item kind ↔ entity type.
 */
import { z } from "zod";
import { WORLD_RELATION_PREDICATES, type WorldItemKind } from "@ncs/shared";

const s = () => z.string().default("");
const urls = () => z.array(z.string()).default([]);

/** model output (JSON). `key` = id inside this answer; existing items are referred to by the `X…` keys we list */
export const worldProposalSchema = z.object({
  factions: z.array(z.object({ key: s(), name: s(), aliases: z.array(z.string()).default([]), summary: s(), source_urls: urls() })).default([]),
  places: z.array(z.object({ key: s(), name: s(), aliases: z.array(z.string()).default([]), summary: s(), parent_key: s(), source_urls: urls() })).default([]),
  systems: z
    .array(
      z.object({
        key: s(),
        name: s(),
        /** ability = 능력·힘의 체계(성좌·등급·마법), rule = 사회·자연 법칙 */
        system_kind: z.enum(["ability", "rule"]).default("ability"),
        summary: s(),
        /** 대가 (ability) / 규칙 문장 (rule) */
        cost_or_rule: s(),
        limits: z.array(z.string()).default([]),
        source_urls: urls(),
      }),
    )
    .default([]),
  objects: z.array(z.object({ key: s(), name: s(), aliases: z.array(z.string()).default([]), summary: s(), source_urls: urls() })).default([]),
  history: z
    .array(z.object({ key: s(), name: s(), summary: s(), when: s(), place_key: s(), participant_keys: z.array(z.string()).default([]), source_urls: urls() }))
    .default([]),
  relations: z.array(z.object({ subject_key: s(), predicate: s(), object_key: s(), note: s(), source_urls: urls() })).default([]),
  constraints: z.array(z.object({ key: s(), title: s(), statement: s(), from_brief: z.boolean().default(false), source_urls: urls() })).default([]),
  /** free note; a search source trailer ("출처:") at its end becomes the call's citations */
  sources_note: s(),
});
export type WorldProposal = z.output<typeof worldProposalSchema>;

/** entity-bearing kinds (relation items carry one fact only) */
export type WorldEntityKind = Exclude<WorldItemKind, "relation">;

/** base@1 entity type per item kind (systems pick ability | rule) */
export function entityTypeOf(kind: WorldEntityKind, systemKind: "ability" | "rule" = "ability"): "organization" | "place" | "ability" | "rule" | "item" | "event" {
  switch (kind) {
    case "faction":
      return "organization";
    case "place":
      return "place";
    case "system":
      return systemKind;
    case "object":
      return "item";
    case "history":
      return "event";
    case "constraint":
      return "rule";
  }
}

/** relation predicates the world step may propose (base@1 keys; character endpoints only for existing cast entities) */
export const WORLD_PREDICATES = WORLD_RELATION_PREDICATES;
export type WorldPredicate = (typeof WORLD_PREDICATES)[number];
export const isWorldPredicate = (p: string): p is WorldPredicate => (WORLD_PREDICATES as readonly string[]).includes(p);

export const clip = (v: string, max: number) => {
  const t = v.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** "성좌 (星座)" stays; trims quotes / trailing punctuation the model sometimes adds */
export const cleanName = (v: string) => clip(v.replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, "").replace(/[.。]+$/, ""), 80);

/** http(s) URLs only, deduped, at most `max` */
export function cleanUrls(list: readonly string[], max = 5): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const u = raw.trim().replace(/[.,;)\]]+$/, "");
    if (!/^https?:\/\/[^\s]+$/i.test(u) || out.includes(u)) continue;
    out.push(u);
    if (out.length >= max) break;
  }
  return out;
}

/** citations of the call by URL → per-item sources: only URLs the call actually reported (no invented links) */
export function pickSources<C extends { url: string }>(itemUrls: readonly string[], citations: readonly C[]): C[] {
  const byUrl = new Map(citations.map((c) => [c.url.replace(/\/$/, ""), c]));
  const out: C[] = [];
  for (const u of cleanUrls(itemUrls)) {
    const c = byUrl.get(u.replace(/\/$/, ""));
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

/** one normalized entity candidate of the proposal */
export interface ProposedEntity {
  key: string;
  kind: WorldEntityKind;
  entityType: ReturnType<typeof entityTypeOf>;
  name: string;
  aliases: string[];
  summary: string;
  /** attribute facts owned by the entity item: [predicate, value] */
  attributes: Array<{ predicate: "ability_cost" | "ability_limit" | "rule_statement"; value: string }>;
  fromBrief: boolean;
  sourceUrls: string[];
}

export interface ProposedRelation {
  subjectKey: string;
  predicate: WorldPredicate;
  objectKey: string;
  note: string;
  sourceUrls: string[];
}

export interface NormalizedProposal {
  entities: ProposedEntity[];
  relations: ProposedRelation[];
}

/** caps per kind (keeps one run reviewable and the prompt context small) */
export const WORLD_LIMITS = { perKind: 12, relations: 40 } as const;

/**
 * Flatten the model output: drop nameless entries, dedupe by kind + name, make keys unique, turn place parents /
 * event places / participants into relations, keep only base@1 predicates of the world step.
 */
export function normalizeProposal(p: WorldProposal): NormalizedProposal {
  const entities: ProposedEntity[] = [];
  const seen = new Set<string>();
  const keys = new Set<string>();
  const keyAlias = new Map<string, string>();
  const add = (raw: { key: string; name: string }, e: Omit<ProposedEntity, "key" | "name">) => {
    const name = cleanName(raw.name);
    if (!name) return;
    const dedupe = `${e.entityType}|${name.replace(/\s+/g, "").toLowerCase()}`;
    let key = clip(raw.key, 40) || `${e.kind}_${entities.length + 1}`;
    if (seen.has(dedupe)) {
      const first = entities.find((x) => `${x.entityType}|${x.name.replace(/\s+/g, "").toLowerCase()}` === dedupe);
      if (first && raw.key) keyAlias.set(raw.key, first.key);
      return;
    }
    if (entities.filter((x) => x.kind === e.kind).length >= WORLD_LIMITS.perKind) return;
    while (keys.has(key)) key = `${key}_`;
    if (raw.key && raw.key !== key) keyAlias.set(raw.key, key);
    seen.add(dedupe);
    keys.add(key);
    entities.push({ key, name, ...e, aliases: e.aliases.map(cleanName).filter((a) => a && a !== name).slice(0, 5), summary: clip(e.summary, 600) });
  };
  for (const f of p.factions) add(f, { kind: "faction", entityType: "organization", aliases: f.aliases, summary: f.summary, attributes: [], fromBrief: false, sourceUrls: f.source_urls });
  for (const pl of p.places) add(pl, { kind: "place", entityType: "place", aliases: pl.aliases, summary: pl.summary, attributes: [], fromBrief: false, sourceUrls: pl.source_urls });
  for (const sy of p.systems) {
    const type = entityTypeOf("system", sy.system_kind);
    const attrs: ProposedEntity["attributes"] = [];
    const main = clip(sy.cost_or_rule, 500);
    if (main) attrs.push({ predicate: type === "rule" ? "rule_statement" : "ability_cost", value: main });
    if (type === "ability") for (const l of sy.limits.map((x) => clip(x, 300)).filter(Boolean).slice(0, 5)) attrs.push({ predicate: "ability_limit", value: l });
    add(sy, { kind: "system", entityType: type, aliases: [], summary: sy.summary, attributes: attrs, fromBrief: false, sourceUrls: sy.source_urls });
  }
  for (const o of p.objects) add(o, { kind: "object", entityType: "item", aliases: o.aliases, summary: o.summary, attributes: [], fromBrief: false, sourceUrls: o.source_urls });
  for (const h of p.history) {
    const summary = h.when.trim() ? `${clip(h.when, 80)} — ${h.summary}` : h.summary;
    add(h, { kind: "history", entityType: "event", aliases: [], summary, attributes: [], fromBrief: false, sourceUrls: h.source_urls });
  }
  for (const c of p.constraints) {
    const statement = clip(c.statement, 500);
    if (!statement) continue;
    add({ key: c.key, name: c.title || statement.slice(0, 30) }, { kind: "constraint", entityType: "rule", aliases: [], summary: "", attributes: [{ predicate: "rule_statement", value: statement }], fromBrief: c.from_brief, sourceUrls: c.source_urls });
  }
  const k = (x: string) => keyAlias.get(x.trim()) ?? x.trim();
  const rels: ProposedRelation[] = [];
  const relSeen = new Set<string>();
  const pushRel = (r: ProposedRelation) => {
    if (!r.subjectKey || !r.objectKey || r.subjectKey === r.objectKey) return;
    const id = `${r.subjectKey}|${r.predicate}|${r.objectKey}`;
    if (relSeen.has(id) || rels.length >= WORLD_LIMITS.relations) return;
    relSeen.add(id);
    rels.push(r);
  };
  for (const pl of p.places) {
    const own = entities.find((e) => e.kind === "place" && e.name === cleanName(pl.name));
    if (own && pl.parent_key.trim()) pushRel({ subjectKey: own.key, predicate: "located_in", objectKey: k(pl.parent_key), note: "", sourceUrls: [] });
  }
  for (const h of p.history) {
    const own = entities.find((e) => e.kind === "history" && e.name === cleanName(h.name));
    if (!own) continue;
    if (h.place_key.trim()) pushRel({ subjectKey: own.key, predicate: "occurred_at", objectKey: k(h.place_key), note: "", sourceUrls: [] });
    for (const pk of h.participant_keys) pushRel({ subjectKey: k(pk), predicate: "participated_in", objectKey: own.key, note: "", sourceUrls: [] });
  }
  for (const r of p.relations) {
    const pred = r.predicate.trim();
    if (!isWorldPredicate(pred)) continue;
    pushRel({ subjectKey: k(r.subject_key), predicate: pred, objectKey: k(r.object_key), note: clip(r.note, 200), sourceUrls: r.source_urls });
  }
  return { entities, relations: rels };
}

/** normalized name key used to match proposals with existing entities (same type) */
export const nameMatchKey = (entityType: string, normalized: string) => `${entityType}|${normalized}`;
