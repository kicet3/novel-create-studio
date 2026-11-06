/**
 * Cast rules (설계 추가: 캐릭터 설정 단계). Pure — no I/O.
 *  - exactly one protagonist to confirm; sub-protagonists 0..N; antagonist / supporting any count
 *  - field provenance: `user` fields are never overwritten by the agent (same rule as concept INV-CON-03)
 *  - brief → cast seeding (protagonist + main_characters of the approved ConceptBrief)
 */
import type { CharacterFieldOrigin, CharacterRole } from "@ncs/shared";
import { CHARACTER_PROFILE_FIELDS, type CharacterProfileField } from "@ncs/shared";
import type { CharacterRelationshipJson } from "@ncs/db/schema";

export type FieldOrigins = Record<string, CharacterFieldOrigin>;

export interface CharacterProfile {
  name: string;
  aliases: string[];
  age: string;
  gender: string;
  personality: string;
  background: string;
  desire: string;
  weakness: string;
  relationships: CharacterRelationshipJson[];
  notes: string;
}

/** name of a brief protagonist without a name (the agent may fill it; confirm is refused until it changes) */
export const PLACEHOLDER_NAME = "이름 미정";

export const ROLE_ORDER: readonly CharacterRole[] = ["protagonist", "sub_protagonist", "antagonist", "supporting"];

export const EMPTY_PROFILE: CharacterProfile = {
  name: "",
  aliases: [],
  age: "",
  gender: "",
  personality: "",
  background: "",
  desire: "",
  weakness: "",
  relationships: [],
  notes: "",
};

export function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/**
 * Agent patch filter: keeps only fields the agent may write — a field whose origin is not `user`, or a `user`
 * field that is still empty. Returns the accepted values and the fields skipped because the user set them.
 */
export function agentWritable(current: Record<string, unknown>, origins: FieldOrigins, patch: Record<string, unknown>): { accepted: Record<string, unknown>; skipped: string[] } {
  const accepted: Record<string, unknown> = {};
  const skipped: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || isEmptyValue(v)) continue;
    if (origins[k] === "user" && !isEmptyValue(current[k])) {
      skipped.push(k);
      continue;
    }
    if (JSON.stringify(current[k]) === JSON.stringify(v)) continue;
    accepted[k] = v;
  }
  return { accepted, skipped };
}

/** origins after a write: written fields get `origin`, emptied fields lose their origin */
export function mergeOrigins(origins: FieldOrigins, written: Record<string, unknown>, origin: CharacterFieldOrigin): FieldOrigins {
  const out: FieldOrigins = { ...origins };
  for (const [k, v] of Object.entries(written)) {
    if (isEmptyValue(v)) delete out[k];
    else out[k] = origin;
  }
  return out;
}

export function originsFor(profile: Partial<CharacterProfile>, origin: CharacterFieldOrigin): FieldOrigins {
  const out: FieldOrigins = {};
  for (const f of CHARACTER_PROFILE_FIELDS) if (!isEmptyValue(profile[f])) out[f] = origin;
  return out;
}

export const isProfileField = (k: string): k is CharacterProfileField => (CHARACTER_PROFILE_FIELDS as readonly string[]).includes(k);

export function normalizeName(s: string): string {
  return s.normalize("NFC").replace(/\s+/g, "").toLowerCase();
}

/** aliases: trimmed, unique, not equal to the name */
export function cleanAliases(name: string, aliases: readonly string[]): string[] {
  const seen = new Set([normalizeName(name)]);
  const out: string[] = [];
  for (const a of aliases) {
    const t = a.trim().slice(0, 80);
    const k = normalizeName(t);
    if (!t || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out.slice(0, 20);
}

// ── confirmation ─────────────────────────────────────────────────────────
export interface CastMember {
  id: string;
  role: CharacterRole;
  status: "draft" | "confirmed";
  name: string;
  proposed: boolean;
}

export function castCounts(cast: readonly Pick<CastMember, "role">[]) {
  const protagonist = cast.filter((c) => c.role === "protagonist").length;
  const subProtagonist = cast.filter((c) => c.role === "sub_protagonist").length;
  return { protagonist, subProtagonist, other: cast.length - protagonist - subProtagonist };
}

/** Korean reasons the cast cannot be confirmed (empty = can confirm) */
export function castBlockers(cast: readonly CastMember[]): string[] {
  const out: string[] = [];
  const { protagonist } = castCounts(cast);
  if (cast.length === 0) out.push("등장인물이 없습니다. 주인공을 추가하세요.");
  else if (protagonist === 0) out.push("주인공을 1명 정하세요.");
  else if (protagonist > 1) out.push("주인공은 1명만 둘 수 있습니다.");
  const names = new Map<string, number>();
  if (cast.some((c) => c.name.trim() === PLACEHOLDER_NAME)) out.push("이름을 정하지 않은 캐릭터가 있습니다. 이름을 입력하세요.");
  for (const c of cast) {
    if (!c.name.trim()) out.push("이름이 비어 있는 캐릭터가 있습니다.");
    const k = normalizeName(c.name);
    names.set(k, (names.get(k) ?? 0) + 1);
  }
  const dup = [...names.entries()].filter(([, n]) => n > 1).map(([k]) => cast.find((c) => normalizeName(c.name) === k)!.name);
  if (dup.length) out.push(`이름이 겹치는 캐릭터가 있습니다: ${dup.join(", ")}`);
  return out;
}

/** cast step done: exactly one protagonist and every character confirmed */
export function isCastConfirmed(cast: readonly CastMember[]): boolean {
  return castBlockers(cast).length === 0 && cast.every((c) => c.status === "confirmed");
}

/** display order: role group, then ord */
export function sortCast<T extends { role: CharacterRole; ord: number; createdAt?: Date }>(cast: readonly T[]): T[] {
  return [...cast].sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.ord - b.ord);
}

// ── ontology mapping ─────────────────────────────────────────────────────
/** "17", "17세", "17살" → 17; anything else (e.g. "30대 초반") is not written as an `age` fact */
export function parseAge(age: string): number | null {
  const m = /^\s*(\d{1,3})\s*(세|살)?\s*$/.exec(age);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 0 && n <= 999 ? n : null;
}

/** relationship label → base@1 relation predicate (null = kept only in the cast) */
// whole words only: a bare "적" would match 적극적·정치적·정신적·목적, a bare "형" would match 형사 (review3 #4).
// Ally words are checked before enemy words ("정치적 동맹", "적극적인 조력자" → ally).
const W = (words: string) => new RegExp(`(^|[\\s,·/()\\[\\]])(${words})(?=$|[\\s,·/()\\[\\]]|[이가은는을를의과와로도]($|\\s))`);
const ENEMY = "원수|숙적|적대자|적대 ?관계|적대|라이벌|대립 ?관계|대립|적수|천적|정적|앙숙|적";
const ALLY = "동맹|동료|협력자|협력|조력자|조력|파트너|친구|소꿉친구|소꿉|단짝|절친|전우";
const RELATION_KEYWORDS: Array<[RegExp, string]> = [
  [W("배우자|부부|남편|아내|약혼자|약혼녀|약혼"), "spouse_of"],
  [W("형제|자매|남매|쌍둥이|친형|친누나|친언니|친오빠|친동생|형님|형|누나|언니|오빠|동생|여동생|남동생"), "sibling_of"],
  [W("연인|연모|짝사랑|사랑|애인|첫사랑"), "loves"],
  [W(ALLY), "ally_of"],
  [W(ENEMY), "enemy_of"],
];
export function relationPredicate(kind: string): string | null {
  const k = kind.trim();
  for (const [re, p] of RELATION_KEYWORDS) if (re.test(k)) return p;
  return null;
}

// ── brief seeding ────────────────────────────────────────────────────────
export interface BriefCharacterInput {
  character_key?: string;
  name?: string;
  name_candidates?: string[];
  aliases?: string[];
  age_band?: string;
  age_note?: string;
  role_label?: string;
  relation_to_protagonist?: string;
  sketch?: string;
  starting_condition?: string;
  desire?: string;
  lack?: string;
  abilities?: string;
  advantage?: string;
}

const AGE_BAND_KO: Record<string, string> = { child: "어린이", teen: "10대", adult: "성인" };

export function roleFromLabel(label: string | undefined): CharacterRole {
  const l = label ?? "";
  if (/(서브|부주인공|히로인|공동 ?주인공|남주|여주|파트너|동료|조력)/.test(l)) return "sub_protagonist";
  if (W(ALLY).test(l)) return "supporting";
  if (W(`악역|빌런|흑막|최종 ?보스|${ENEMY}`).test(l)) return "antagonist";
  return "supporting";
}

export interface SeedCharacter {
  role: CharacterRole;
  key: string | null;
  profile: CharacterProfile;
  /** the name was missing in the brief (placeholder, agent may fill) */
  namePlaceholder: boolean;
  relationToProtagonist: string | null;
}

/** protagonist + main_characters of an approved brief content (lenient: unknown shapes are skipped) */
/** the main-characters entry that is the (nameless) protagonist: labelled 주인공, else the only one named in the protagonist text */
function protagonistEntry(p: BriefCharacterInput, mains: BriefCharacterInput[], nameOf: (c: BriefCharacterInput) => string): BriefCharacterInput | undefined {
  const isMain = (c: BriefCharacterInput) => /^(주인공|주인공\s*\(.*\))$/u.test(c.role_label?.trim() ?? "") || /^\s*주인공(?![가-힣])/u.test(c.sketch ?? "");
  const labelled = mains.filter((c) => nameOf(c) && isMain(c));
  if (labelled.length === 1) return labelled[0];
  const text = normalizeName([p.starting_condition, p.sketch].filter(Boolean).join(" "));
  const named = mains.filter((c) => nameOf(c).length >= 2 && text.includes(normalizeName(nameOf(c))));
  return named.length === 1 ? named[0] : undefined;
}

export function seedFromBrief(content: { protagonist?: BriefCharacterInput; main_characters?: BriefCharacterInput[] } | null | undefined): SeedCharacter[] {
  const out: SeedCharacter[] = [];
  const nameOf = (c: BriefCharacterInput) => (c.name?.trim() || c.name_candidates?.find((n) => n.trim())?.trim() || "").slice(0, 80);
  const ageOf = (c: BriefCharacterInput) => [c.age_band && c.age_band !== "unknown" ? AGE_BAND_KO[c.age_band] : "", c.age_note?.trim() ?? ""].filter(Boolean).join(", ").slice(0, 40);
  const p = content?.protagonist;
  const mains = Array.isArray(content?.main_characters) ? content!.main_characters!.filter((c): c is BriefCharacterInput => !!c && typeof c === "object") : [];
  if (p && typeof p === "object") {
    // a nameless protagonist listed again among the main characters (e.g. "윤서하: 주인공. …" from an import — live-test
    // regression) takes that entry's name; the entry is then skipped as a duplicate below
    const self = nameOf(p) ? undefined : protagonistEntry(p, mains, nameOf);
    const name = nameOf(p) || (self ? nameOf(self) : "");
    out.push({
      role: "protagonist",
      key: p.character_key ?? null,
      namePlaceholder: !name,
      relationToProtagonist: null,
      profile: {
        ...EMPTY_PROFILE,
        name: name || PLACEHOLDER_NAME,
        aliases: cleanAliases(name, p.aliases ?? []),
        age: ageOf(p),
        desire: p.desire?.trim() ?? "",
        weakness: p.lack?.trim() ?? "",
        background: [p.starting_condition, p.abilities ? `능력: ${p.abilities}` : "", p.advantage ? `강점: ${p.advantage}` : ""]
          .map((x) => x?.trim() ?? "")
          .filter(Boolean)
          .join("\n"),
        personality: (p.sketch?.trim() || self?.sketch?.replace(/^\s*주인공[.,:·]?\s*/u, "").trim()) ?? "",
      },
    });
  }
  for (const c of mains) {
    if (!c || typeof c !== "object") continue;
    const name = nameOf(c);
    if (!name) continue;
    if (out.some((o) => normalizeName(o.profile.name) === normalizeName(name))) continue;
    out.push({
      role: roleFromLabel(c.role_label),
      key: c.character_key ?? null,
      namePlaceholder: false,
      relationToProtagonist: c.relation_to_protagonist?.trim() || null,
      profile: {
        ...EMPTY_PROFILE,
        name,
        aliases: cleanAliases(name, c.aliases ?? []),
        age: ageOf(c),
        personality: c.sketch?.trim() ?? "",
        notes: c.role_label?.trim() ? `역할: ${c.role_label.trim()}` : "",
      },
    });
  }
  return out;
}
