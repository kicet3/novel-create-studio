/**
 * Deterministic check of an extract_facts answer (07 §4.3 "결정적 검증", 설계 추가) — pure.
 * Every mention is located by the server (surface + quote; the model's offsets are hints): own scene first,
 * then the neighbouring scenes. What cannot be located becomes an issue for the validator critique
 * (agents.callWithRepair) and, if still open after the repair rounds, is dropped individually.
 */
import type { RepairIssueDto } from "@ncs/shared";
import type { ExtractionResult } from "./schemas.js";
import { findAll, locateInText, type LocateHow } from "./text.js";

export interface CheckScene {
  sceneOrd: number;
  text: string;
  /** offset of the scene inside the version (neighbour lookup maps hints through it) */
  charOffset: number;
}

export interface LocatedMention {
  /** index into extraction.mentions */
  index: number;
  sceneOrd: number;
  start: number;
  end: number;
  /** the verbatim span (particles / quotes the model left on the surface removed) */
  surface: string;
  how: LocateHow | "neighbour_scene";
}

export interface ExtractionCheck {
  located: LocatedMention[];
  /** indexes of mentions that could not be located */
  unlocated: number[];
  issues: RepairIssueDto[];
  stats: { mentions: number; located: number; exact: number; relocated: number; neighbourScene: number; unlocated: number; danglingFactRefs: number };
}

const show = (s: string) => s.replace(/\r?\n/g, "↵");

export function contextExcerpt(text: string, start: number, end: number, radius = 18): string {
  const a = Math.max(0, start - radius);
  const b = Math.min(text.length, end + radius);
  return show(`${a > 0 ? "…" : ""}${text.slice(a, start)}[${text.slice(start, end)}]${text.slice(end, b)}${b < text.length ? "…" : ""}`);
}

/** common model spellings of the base schema entity types (the model is told the keys; this catches the rest) */
const TYPE_ALIASES: Record<string, string> = {
  location: "place", locale: "place", area: "place", region: "place", building: "place", 장소: "place",
  person: "character", people: "character", human: "character", creature: "character", 인물: "character",
  org: "organization", organisation: "organization", group: "organization", faction: "organization", guild: "organization", agency: "organization", institution: "organization", 조직: "organization",
  object: "item", artifact: "item", thing: "item", weapon: "item", 사물: "item",
  skill: "ability", power: "ability", system: "ability", magic: "ability",
  position: "title", rank: "title", role: "title",
  incident: "event",
};

/**
 * entity_type_hint → an enabled schema entity type key; null when absent; `false` when it names no known type
 * (the critique asks the producer to use a schema key; never passed to entity creation).
 */
export function normalizeEntityType(hint: string | null | undefined, enabled: ReadonlySet<string>): string | null | false {
  if (!hint || !hint.trim()) return null;
  const k = hint.trim().toLowerCase();
  if (enabled.has(k)) return k;
  const a = TYPE_ALIASES[k];
  return a && enabled.has(a) ? a : false;
}

export function checkExtraction(scenes: readonly CheckScene[], extraction: ExtractionResult, opts: { entityTypes?: ReadonlySet<string> } = {}): ExtractionCheck {
  const byOrd = new Map(scenes.map((s) => [s.sceneOrd, s]));
  const ords = scenes.map((s) => s.sceneOrd).sort((a, b) => a - b);
  const located: LocatedMention[] = [];
  const unlocated: number[] = [];
  const issues: RepairIssueDto[] = [];
  let exact = 0;
  let neighbourScene = 0;

  extraction.mentions.forEach((m, index) => {
    const label = `scene_ord=${m.scene_ord} ${m.local_key} "${m.surface}"`;
    const sc = byOrd.get(m.scene_ord);
    if (!sc) {
      unlocated.push(index);
      issues.push({ item: label, problem: `scene_ord=${m.scene_ord} 씬이 없습니다(있는 씬: ${ords.join(", ")}).` });
      return;
    }
    const input = { surface: m.surface, quote: m.quote ?? null, charStart: m.char_start ?? null, charEnd: m.char_end ?? null, mentionKind: m.mention_kind };
    const r = locateInText(sc.text, input);
    if (r.ok) {
      if (r.how === "exact") exact++;
      located.push({ index, sceneOrd: sc.sceneOrd, start: r.start, end: r.end, surface: m.mention_kind === "zero" ? "" : r.surface, how: r.how });
      return;
    }
    if (r.reason === "not_found") {
      // the model sometimes files a mention under the neighbouring scene
      for (const ord of [m.scene_ord - 1, m.scene_ord + 1]) {
        const nb = byOrd.get(ord);
        if (!nb) continue;
        const hint = typeof m.char_start === "number" ? m.char_start + sc.charOffset - nb.charOffset : null;
        const r2 = locateInText(nb.text, { ...input, charStart: hint !== null && hint >= 0 ? hint : null, charEnd: null });
        if (r2.ok) {
          neighbourScene++;
          located.push({ index, sceneOrd: nb.sceneOrd, start: r2.start, end: r2.end, surface: r2.surface, how: "neighbour_scene" });
          return;
        }
      }
    }
    unlocated.push(index);
    if (r.reason === "ambiguous") {
      const ex = r.occurrences.slice(0, 3).map((p) => contextExcerpt(sc.text, p, p + r.surface.length));
      issues.push({
        item: label,
        problem: `같은 씬에 ${r.occurrences.length}번 나와 어느 언급인지 정할 수 없습니다(위치 ${r.occurrences.slice(0, 8).join(", ")}). quote에 이 언급을 포함한 앞뒤 문맥을 원문 그대로 넣으세요.`,
        excerpt: ex.join(" / "),
      });
    } else if (r.reason === "empty") {
      issues.push({ item: label, problem: "surface가 비어 있습니다. 원문에 적힌 표기를 그대로 쓰세요(생략된 주어는 mention_kind=zero)." });
    } else {
      const elsewhere = scenes.filter((s) => s.sceneOrd !== sc.sceneOrd && findAll(s.text, r.surface).length > 0).map((s) => s.sceneOrd);
      const at = typeof m.char_start === "number" && m.char_start < sc.text.length ? contextExcerpt(sc.text, m.char_start, Math.min(sc.text.length, Math.max(m.char_start, m.char_end ?? m.char_start)), 14) : null;
      issues.push({
        item: label,
        problem: `씬 ${sc.sceneOrd} 원문에 "${r.surface}" 표기가 없습니다.${elsewhere.length ? ` 이 표기는 씬 ${elsewhere.join(", ")}에 있습니다.` : " 원문에 없는 표기라면 이 언급과 이를 가리키는 사실을 빼세요."}`,
        ...(at ? { excerpt: `지정한 위치의 원문 ${at}` } : {}),
      });
    }
  });

  // entity_type_hint must name a schema entity type (else entity creation for a new name fails)
  if (opts.entityTypes?.size) {
    const keys = [...opts.entityTypes].join(", ");
    extraction.mentions.forEach((m) => {
      if (normalizeEntityType(m.entity_type_hint, opts.entityTypes!) === false) issues.push({ item: `scene_ord=${m.scene_ord} ${m.local_key} "${m.surface}"`, problem: `entity_type_hint "${m.entity_type_hint}"는 스키마에 없는 유형입니다. 다음 중 하나를 쓰세요: ${keys}.` });
    });
  }

  // facts must point at mentions of this answer
  const keys = new Set(extraction.mentions.map((m) => m.local_key));
  let danglingFactRefs = 0;
  for (const f of extraction.facts) {
    for (const k of [f.subject_mention_key, f.object_mention_key ?? null]) {
      if (k === null || keys.has(k)) continue;
      danglingFactRefs++;
      issues.push({ item: `fact ${f.local_key}`, problem: `없는 언급 local_key "${k}"를 가리킵니다. mentions에 그 언급을 넣거나 사실을 빼세요.` });
    }
  }

  return {
    located,
    unlocated,
    issues,
    stats: {
      mentions: extraction.mentions.length,
      located: located.length,
      exact,
      relocated: located.length - exact,
      neighbourScene,
      unlocated: unlocated.length,
      danglingFactRefs,
    },
  };
}
