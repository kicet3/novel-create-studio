/**
 * Deterministic text helpers (pure):
 *  - offset repair for LLM mentions (07 §4.3 "결정적 검증")
 *  - dictionary L0 supplement: known name surfaces found verbatim in a scene (works without any model)
 *  - quotation / speaker heuristic for L1
 *  - deterministic parse of series bible content for build_initial_ontology (07 B2)
 */
import type { InitialOntology } from "./schemas.js";

/**
 * Legacy offset repair (kept for callers that only have offsets): the verbatim span at the hint, else the
 * occurrence of `surface` nearest to the hint (see locateInText). null when it cannot be placed.
 */
export function repairOffsets(text: string, m: { char_start: number; char_end: number; surface: string }): { start: number; end: number } | null {
  const r = locateInText(text, { surface: m.surface, charStart: m.char_start, charEnd: m.char_end, mentionKind: "named" });
  return r.ok ? { start: r.start, end: r.end } : null;
}

// ── mention location (07 §4.3 "결정적 검증", 설계 추가) ─────────────────────
// Models cannot count characters reliably (scene text that starts with "\n", long scenes). The model gives the
// verbatim surface + a short verbatim context quote; its offsets are only hints. The server finds the span.

export interface MentionLocateInput {
  surface: string;
  /** short verbatim context containing the surface (disambiguates repeated names) */
  quote?: string | null;
  /** offsets from the model: hints only */
  charStart?: number | null;
  charEnd?: number | null;
  mentionKind?: string;
}

export type LocateHow = "exact" | "quote" | "unique" | "nearest" | "first";
export type LocateResult =
  | { ok: true; start: number; end: number; surface: string; how: LocateHow; delta: number | null }
  | { ok: false; reason: "empty" | "not_found" | "ambiguous"; occurrences: number[]; surface: string };

const WRAP_QUOTES = /^[\s"'“”‘’「」『』《》〈〉()（）[\]]+|[\s"'“”‘’「」『』《》〈〉()（）[\]]+$/gu;
/** particles that a model sometimes leaves on the surface (longest first) */
const JOSA = ["으로부터", "에게서는", "에게서", "께서는", "에서는", "으로는", "이라는", "에게는", "에게", "에서", "께서", "으로", "까지", "부터", "처럼", "보다", "이나", "이랑", "하고", "라는", "은", "는", "이", "가", "을", "를", "의", "에", "와", "과", "도", "로", "만", "아", "야", "여"];
/** mention kinds whose surfaces are short / common: only placed near the hint or by quote */
const LOOSE_KINDS = new Set(["pronoun", "address", "zero", "descriptive"]);
const NEAR_TOLERANCE = 3;

const cleanSurface = (s: string) => s.replace(WRAP_QUOTES, "");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** all match spans of `needle` in `text` (NFC / NFD forms; runs of whitespace match any whitespace) */
export function findAll(text: string, needle: string): Array<{ start: number; end: number }> {
  if (!needle) return [];
  const out = new Map<number, number>();
  for (const form of new Set([needle, needle.normalize("NFC"), needle.normalize("NFD")])) {
    let i = text.indexOf(form);
    while (i >= 0) {
      out.set(i, i + form.length);
      i = text.indexOf(form, i + 1);
    }
  }
  if (out.size === 0 && /\s/.test(needle.trim())) {
    const parts = needle.normalize("NFC").trim().split(/\s+/).map(escapeRe);
    const re = new RegExp(parts.join("\\s+"), "gu");
    for (const m of text.normalize("NFC") === text ? text.matchAll(re) : []) out.set(m.index!, m.index! + m[0].length);
  }
  return [...out.entries()].sort((a, b) => a[0] - b[0]).map(([start, end]) => ({ start, end }));
}

function stripJosa(s: string): string | null {
  for (const j of JOSA) if (s.endsWith(j) && s.length - j.length >= 2) return s.slice(0, -j.length);
  return null;
}

/** occurrences of the surface; tolerant of quotes around it and particles left on it */
function surfaceSpans(text: string, raw: string): { surface: string; spans: Array<{ start: number; end: number }> } {
  const s = cleanSurface(raw);
  let spans = findAll(text, s);
  if (spans.length) return { surface: s, spans };
  const stem = stripJosa(s);
  if (stem) {
    // the stem is a guess: only where it ends a word (or a particle follows) — never inside a longer name
    // ("서진이" must not land on "서진우")
    spans = findAll(text, stem).filter((x) => endsWord(text, x.end));
    if (spans.length) return { surface: stem, spans };
  }
  return { surface: s, spans: [] };
}

/** suffixes that may follow a name inside the same word (particles, honorifics, plural) */
const NAME_SUFFIX = [...JOSA, "씨", "님", "들", "께", "한테", "이었", "이다", "이야", "이지", "이란", "이랑"];
/** true when the span ends a word or is followed by a particle / honorific (not inside a longer name) */
function endsWord(text: string, end: number): boolean {
  if (end >= text.length || !WORDCHAR.test(text[end]!)) return true;
  const tail = text.slice(end, end + 4);
  return NAME_SUFFIX.some((j) => tail.startsWith(j));
}

/** prefer occurrences that are whole words (not inside a longer name, e.g. "레온" in "흑레온", "서진" in "서진우") */
function boundaryFirst(text: string, spans: Array<{ start: number; end: number }>) {
  const left = spans.filter((x) => x.start === 0 || !WORDCHAR.test(text[x.start - 1]!));
  const l = left.length ? left : spans;
  const both = l.filter((x) => endsWord(text, x.end));
  return both.length ? both : l;
}

function nearest(spans: Array<{ start: number; end: number }>, hint: number) {
  let best = spans[0]!;
  for (const x of spans) if (Math.abs(x.start - hint) < Math.abs(best.start - hint)) best = x; // tie → earlier
  return best;
}

/** place one mention in one text (scene). Offsets of the model are hints only. */
export function locateInText(text: string, m: MentionLocateInput): LocateResult {
  const hint = typeof m.charStart === "number" && m.charStart >= 0 ? m.charStart : null;
  const kind = m.mentionKind ?? "named";
  if (m.surface === "" || kind === "zero") {
    // zero mention: no surface — keep the hinted point (clamped) or the quote start
    const q = m.quote ? findAll(text, cleanSurface(m.quote))[0] : undefined;
    const at = hint !== null && hint <= text.length ? hint : q ? q.start : null;
    if (at === null) return { ok: false, reason: "empty", occurrences: [], surface: "" };
    const end = typeof m.charEnd === "number" && m.charEnd >= at && m.charEnd <= text.length ? m.charEnd : at;
    return { ok: true, start: at, end, surface: m.surface, how: "exact", delta: 0 };
  }
  const { surface, spans: all } = surfaceSpans(text, m.surface);
  if (!surface) return { ok: false, reason: "empty", occurrences: [], surface };
  if (all.length === 0) return { ok: false, reason: "not_found", occurrences: [], surface };
  // (1) verbatim at the hint
  if (hint !== null) {
    const hit = all.find((x) => x.start === hint);
    if (hit) return { ok: true, ...hit, surface: text.slice(hit.start, hit.end), how: "exact", delta: 0 };
  }
  const spans = boundaryFirst(text, all);
  const done = (x: { start: number; end: number }, how: LocateHow): LocateResult => ({ ok: true, start: x.start, end: x.end, surface: text.slice(x.start, x.end), how, delta: hint === null ? null : x.start - hint });
  // (2) the quote pins the occurrence
  const quote = m.quote ? cleanSurface(m.quote) : "";
  if (quote && quote.length > surface.length) {
    const inQuote: Array<{ start: number; end: number }> = [];
    for (const q of findAll(text, quote)) for (const x of all) if (x.start >= q.start && x.end <= q.end) inQuote.push(x);
    if (inQuote.length === 1) return done(inQuote[0]!, "quote");
    if (inQuote.length > 1) return done(hint === null ? inQuote[0]! : nearest(inQuote, hint), "quote");
  }
  // (3) the only occurrence
  if (spans.length === 1) return done(spans[0]!, "unique");
  // (4) nearest to the hint; short / common surfaces only right next to it
  const loose = LOOSE_KINDS.has(kind) || [...surface].length < 2;
  if (hint !== null) {
    const x = nearest(spans, hint);
    if (!loose || Math.abs(x.start - hint) <= NEAR_TOLERANCE) return done(x, "nearest");
    return { ok: false, reason: "ambiguous", occurrences: spans.map((s) => s.start), surface };
  }
  if (!loose) return done(spans[0]!, "first");
  return { ok: false, reason: "ambiguous", occurrences: spans.map((s) => s.start), surface };
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
