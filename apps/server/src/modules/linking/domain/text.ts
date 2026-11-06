/**
 * Deterministic text helpers (pure):
 *  - offset repair for LLM mentions (07 §4.3 "결정적 검증")
 *  - dictionary L0 supplement: known name surfaces found verbatim in a scene (works without any model)
 *  - quotation / speaker heuristic for L1
 *  - deterministic parse of series bible content for build_initial_ontology (07 B2)
 */
import type { InitialOntology } from "./schemas.js";

export function repairOffsets(text: string, m: { char_start: number; char_end: number; surface: string }): { start: number; end: number } | null {
  if (m.surface === "") return { start: m.char_start, end: m.char_end };
  const nfc = (s: string) => s.normalize("NFC");
  if (nfc(text.slice(m.char_start, m.char_end)) === nfc(m.surface)) return { start: m.char_start, end: m.char_end };
  const first = text.indexOf(m.surface);
  if (first < 0 || text.indexOf(m.surface, first + 1) >= 0) return null; // not found or not unique → drop
  return { start: first, end: first + m.surface.length };
}

/** Hangul syllable / latin letter — used to avoid matching inside a longer word on the left */
const WORDCHAR = /[\p{L}\p{N}]/u;

export interface DictName {
  surface: string;
  nameKind: string;
  /** title entity names produce `title` mentions */
  entityType: string;
}

/** longest-first, non-overlapping verbatim matches (particles after the surface are allowed, N5) */
export function dictionaryMentions(text: string, names: DictName[]): Array<{ start: number; end: number; surface: string; mentionKind: "named" | "title" }> {
  const uniq = [...new Map(names.filter((n) => n.surface.length >= 2 || /[가-힣]/.test(n.surface)).map((n) => [n.surface, n])).values()].sort((a, b) => b.surface.length - a.surface.length);
  const taken: Array<[number, number]> = [];
  const out: Array<{ start: number; end: number; surface: string; mentionKind: "named" | "title" }> = [];
  for (const n of uniq) {
    let from = 0;
    for (;;) {
      const i = text.indexOf(n.surface, from);
      if (i < 0) break;
      from = i + 1;
      const end = i + n.surface.length;
      if (i > 0 && WORDCHAR.test(text[i - 1]!)) continue;
      if (taken.some(([a, b]) => i < b && end > a)) continue;
      taken.push([i, end]);
      out.push({ start: i, end, surface: n.surface, mentionKind: n.nameKind === "title" || n.entityType === "title" ? "title" : "named" });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** true when the offset lies inside a quoted line ("…", “…”, 「…」) */
export function insideQuote(text: string, offset: number): boolean {
  const before = text.slice(0, offset);
  const opens = (before.match(/[“「『]/g) ?? []).length - (before.match(/[”」』]/g) ?? []).length;
  const straight = (before.match(/"/g) ?? []).length % 2 === 1;
  return opens > 0 || straight;
}

export function excerpt(text: string, start: number, end: number, radius = 40): string {
  const a = Math.max(0, start - radius);
  const b = Math.min(text.length, end + radius);
  return `${a > 0 ? "…" : ""}${text.slice(a, start)}[${text.slice(start, end)}]${text.slice(end, b)}${b < text.length ? "…" : ""}`;
}

// ── bible parse (07 B2 deterministic part) ───────────────────────────────
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function nameOf(o: Obj): string | null {
  return str(o.name) ?? str(o.preferred_name) ?? str(o.preferredName) ?? str(o.title) ?? str(o.label);
}
function aliasesOf(o: Obj): string[] {
  const a = o.aliases ?? o.alias ?? o.nicknames;
  return Array.isArray(a) ? a.map(str).filter((x): x is string => !!x) : typeof a === "string" ? [a] : [];
}

const SECTIONS: Array<{ keys: string[]; type: string }> = [
  { keys: ["protagonist"], type: "character" },
  { keys: ["characters", "main_characters", "mainCharacters", "supporting_characters", "cast"], type: "character" },
  { keys: ["places", "locations", "settings"], type: "place" },
  { keys: ["organizations", "factions", "groups", "families"], type: "organization" },
  { keys: ["items", "artifacts"], type: "item" },
  { keys: ["abilities", "powers", "systems"], type: "ability" },
  { keys: ["titles", "positions"], type: "title" },
];

/** Recognizes common bible content shapes; unknown shapes yield nothing (the LLM output covers them). */
export function parseBibleContent(content: unknown): InitialOntology {
  const out: InitialOntology = { entities: [], facts: [] };
  if (!isObj(content)) return out;
  const roots: Obj[] = [content, ...(isObj(content.world) ? [content.world as Obj] : []), ...(isObj(content.worldbuilding) ? [content.worldbuilding as Obj] : [])];
  let seq = 0;
  const seen = new Set<string>();
  const add = (o: Obj | string, type: string) => {
    const obj: Obj = typeof o === "string" ? { name: o } : o;
    const name = nameOf(obj);
    if (!name || seen.has(`${type}|${name}`)) return;
    seen.add(`${type}|${name}`);
    const key = str(obj.character_key) ?? str(obj.characterKey) ?? str(obj.key) ?? `b${++seq}`;
    out.entities.push({
      key,
      entity_type: str(obj.entity_type) ?? str(obj.type) ?? type,
      name,
      aliases: aliasesOf(obj),
      disambiguator: str(obj.disambiguator),
      summary: str(obj.summary) ?? str(obj.description) ?? str(obj.role),
      character_key: type === "character" ? (str(obj.character_key) ?? str(obj.characterKey)) : null,
    });
    const gender = str(obj.gender);
    if (gender && type === "character") out.facts.push({ subject_key: key, predicate: "gender", value: gender, from_story_point: 0 });
    const age = typeof obj.age === "number" ? obj.age : null;
    if (age !== null && type === "character") out.facts.push({ subject_key: key, predicate: "age", value: age, from_story_point: 0 });
    const holds = str(obj.holds_title) ?? str(obj.title_held);
    if (holds && type === "character") {
      const tk = `t:${holds}`;
      if (!seen.has(`title|${holds}`)) {
        seen.add(`title|${holds}`);
        out.entities.push({ key: tk, entity_type: "title", name: holds, aliases: [], disambiguator: null, summary: null, character_key: null });
      }
      out.facts.push({ subject_key: key, predicate: "holds_title", object_key: tk, from_story_point: 0 });
    }
  };
  for (const root of roots) {
    for (const s of SECTIONS)
      for (const k of s.keys) {
        const v = root[k];
        if (Array.isArray(v)) for (const item of v) if (isObj(item) || typeof item === "string") add(item as Obj | string, s.type);
        if (isObj(v) && nameOf(v)) add(v, s.type);
      }
    const rules = root.world_rules ?? root.worldRules ?? root.rules;
    if (Array.isArray(rules)) {
      for (const r of rules) {
        const text = typeof r === "string" ? r : isObj(r) ? (str(r.statement) ?? str(r.text) ?? str(r.description)) : null;
        const name = isObj(r) ? (str(r.name) ?? str(r.title)) : null;
        if (!text) continue;
        const key = `r${++seq}`;
        out.entities.push({ key, entity_type: "rule", name: name ?? text.slice(0, 20), aliases: [], disambiguator: null, summary: text, character_key: null });
        out.facts.push({ subject_key: key, predicate: "rule_statement", value: text, from_story_point: 0 });
      }
    }
  }
  // relationships: [{from|subject, to|object, predicate|relation|type}] by entity name
  for (const root of roots) {
    const rels = root.relationships ?? root.relations;
    if (!Array.isArray(rels)) continue;
    for (const r of rels) {
      if (!isObj(r)) continue;
      const a = str(r.from) ?? str(r.subject);
      const b = str(r.to) ?? str(r.object);
      const p = str(r.predicate) ?? str(r.relation) ?? str(r.type);
      const ka = out.entities.find((e) => e.name === a || e.key === a)?.key;
      const kb = out.entities.find((e) => e.name === b || e.key === b)?.key;
      if (ka && kb && p) out.facts.push({ subject_key: ka, predicate: p, object_key: kb, from_story_point: 0 });
    }
  }
  return out;
}
