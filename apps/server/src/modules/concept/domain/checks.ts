/**
 * X-9 deterministic per-commit checks (design/11 §2.5 X-9, §6.3–6.5) and the CS3 guard
 * (INV-CON-05, 10, 11, 12, 13, 15). Pure — install lists (blocklist / real persons / keywords) are inputs.
 */
import {
  emptyChecks,
  getPath,
  normalizeText,
  slotState,
  valueToText,
  workingBriefHash,
  type BriefChecks,
  type BriefContent,
  type WorkingBrief,
} from "./brief.js";
import { hasRomanceContext, hasUsableValue, needsAgeBands, requiredPaths, slotLabel } from "./question-set.js";

export interface InstallSafetyLists {
  /** `safety.age_rating_keywords` (shared with 07 PR-10; assumption: local list until the install data exists) */
  ageKeywords: readonly string[];
  /** famous-work proper-noun blocklist (6.3, install data; empty in MVP-α) */
  properNounBlocklist: readonly string[];
  /** real-person list (6.5, install data; empty in MVP-α) */
  realPersons: readonly string[];
}

/** Over-`age_15` keywords (assumed install data `safety.age_rating_keywords`). */
export const DEFAULT_AGE_KEYWORDS: readonly string[] = [
  "19금", "성인물", "섹스", "성관계", "정사", "야한 장면", "노골적인 성", "강간", "고어", "신체 절단", "사지 절단", "내장", "잔혹한 고문", "마약 제조",
];

export const DEFAULT_SAFETY_LISTS: InstallSafetyLists = { ageKeywords: DEFAULT_AGE_KEYWORDS, properNounBlocklist: [], realPersons: [] };

/** text-bearing paths scanned by X-9 */
export const SCANNED_PATHS = [
  "seed_notes", "category.genre_label", "category.trope_labels", "protagonist.starting_condition", "protagonist.desire", "protagonist.lack",
  "opposition", "stakes", "core_hook", "world_rules[item_key=core]", "world_rules[item_key=regression]", "world_rules[item_key=possession]",
  "world_rules[item_key=status_window]", "world_rules[item_key=power_rank]", "main_characters", "serial_plan.long_conflict_engine",
  "ending_direction", "tone", "logline", "title_candidates", "title", "premise",
];

export function findKeywords(text: string, keywords: readonly string[]): string[] {
  const t = normalizeText(text);
  return keywords.filter((k) => t.includes(normalizeText(k)));
}

/** keyword hits of one value (used to keep a flagged value `proposed`) */
export function valueIsFlagged(value: unknown, lists: InstallSafetyLists): boolean {
  const text = valueToText(value);
  return findKeywords(text, lists.ageKeywords).length > 0 || findKeywords(text, lists.properNounBlocklist).length > 0;
}

/**
 * A model's `real_person` flag counts only when it names someone that actually appears in the brief (live-test
 * regression: the check flagged invented characters with a generic note). Names are matched after normalization.
 */
export function groundedRealPersonName(c: BriefContent, name: string): string | null {
  const n = normalizeText(name);
  if (n.length < 2 || /^(실존인물|realperson|unknown|없음)$/.test(n)) return null;
  const text = normalizeText(valueToText(c as unknown));
  return text.includes(n) ? name.trim() : null;
}

function characterNames(c: BriefContent): Array<{ key: string; names: string[] }> {
  const all = [{ ...(c.protagonist ?? {}), character_key: c.protagonist?.character_key ?? "protagonist" }, ...(c.main_characters ?? [])];
  return all.map((ch) => ({
    key: ch.character_key,
    names: [ch.name, ...(ch.aliases ?? []), ch.body_name, ch.persona_name].filter((x): x is string => !!x && !!x.trim()),
  }));
}

/**
 * Recompute deterministic checks. Message-level hits (user text) are passed in `userTexts`; previous
 * copy requests / LLM signals are carried over (they come from the model, not from code).
 */
export function runDeterministicChecks(
  b: WorkingBrief,
  lists: InstallSafetyLists,
  userTexts: Array<{ messageId: string; text: string }> = [],
): BriefChecks {
  const prev = b.checks ?? emptyChecks();
  const c = b.content;
  const out: BriefChecks = {
    ...emptyChecks(),
    working_brief_hash: prev.working_brief_hash,
    checked_by_run_id: prev.checked_by_run_id,
    similarity: { ...emptyChecks().similarity, copy_requests: prev.similarity.copy_requests, llm_overlap_signals: prev.similarity.llm_overlap_signals },
  };
  out.similarity.trope_tags = [...(c.category?.trope_labels ?? [])];
  for (const path of SCANNED_PATHS) {
    const text = valueToText(getPath(c, path));
    if (!text) continue;
    for (const k of findKeywords(text, lists.ageKeywords)) out.safety.age_rating_flags.push({ field_path: path, keyword: k, message_id: null });
    for (const k of findKeywords(text, lists.properNounBlocklist)) out.similarity.blocklist_hits.push({ field_path: path, term: k });
  }
  for (const m of userTexts) {
    for (const k of findKeywords(m.text, lists.ageKeywords)) {
      if (!out.safety.age_rating_flags.some((f) => f.keyword === k)) out.safety.age_rating_flags.push({ field_path: null, keyword: k, message_id: m.messageId });
    }
  }
  // real persons: list hits on character names (6.5); LLM hits carried over
  const chars = characterNames(c);
  for (const ch of chars) for (const n of ch.names) if (findKeywords(n, lists.realPersons).length) out.safety.real_person_hits.push({ name: n, field_path: "main_characters", source: "list" });
  for (const h of prev.safety.real_person_hits.filter((x) => x.source === "llm")) out.safety.real_person_hits.push(h);
  // minors in romance/sexual context (NFR-SAFE-01)
  if (hasRomanceContext(c) || out.safety.age_rating_flags.length) {
    for (const ch of [{ character_key: "protagonist", age_band: c.protagonist?.age_band }, ...(c.main_characters ?? [])]) {
      if (ch.age_band === "child" || ch.age_band === "teen") out.safety.minor_flags.push({ character_key: ch.character_key, note: "미성년 인물과 연애·성적 맥락이 함께 있습니다." });
    }
  }
  // duplicate names / aliases across character objects (5.4)
  const byName = new Map<string, Set<string>>();
  for (const ch of chars) for (const n of ch.names) byName.set(normalizeText(n), (byName.get(normalizeText(n)) ?? new Set()).add(ch.key));
  for (const [n, keys] of byName) if (keys.size > 1) out.name_duplicates.push({ name: n, character_keys: [...keys] });
  return out;
}

export type SubmitBlockerCode =
  | "missing_required"
  | "age_rating_exceeded"
  | "minor_in_romance"
  | "age_band_unknown"
  | "real_person"
  | "copy_request"
  | "possession_real_work"
  | "invalid_age_rating";

export interface SubmitBlocker {
  code: SubmitBlockerCode;
  message: string;
  fieldPaths: string[];
}

/** CS3 guard minus the hash check (INV-CON-05, 06, 10, 11, 12, 15). */
export function submitBlockers(b: WorkingBrief): SubmitBlocker[] {
  const c = b.content;
  const out: SubmitBlocker[] = [];
  const missing = requiredPaths(c).filter((p) => slotState(b, p) !== "confirmed" || !hasUsableValue(c, p));
  if (missing.length) {
    out.push({ code: "missing_required", message: `필수 항목이 확정되지 않았습니다: ${missing.map(slotLabel).join(", ")}`, fieldPaths: missing });
  }
  if (c.age_rating === "age_19") out.push({ code: "invalid_age_rating", message: "현재는 15세 이용가까지만 지원합니다.", fieldPaths: ["age_rating"] });
  const flags = b.checks.safety.age_rating_flags;
  if (c.age_rating === "age_15" && flags.length) {
    out.push({
      code: "age_rating_exceeded",
      message: `15세 등급을 넘는 내용이 있습니다(${[...new Set(flags.map((f) => f.keyword))].join(", ")}). 내용을 고쳐 주세요.`,
      fieldPaths: flags.map((f) => f.field_path).filter((x): x is string => !!x),
    });
  }
  if (b.checks.safety.minor_flags.length) {
    out.push({ code: "minor_in_romance", message: "미성년 인물과 연애·성적 맥락을 함께 둘 수 없습니다.", fieldPaths: ["protagonist.age_band", "main_characters"] });
  }
  if (needsAgeBands(c)) {
    const unknown = [
      ...(c.protagonist?.age_band && c.protagonist.age_band !== "unknown" ? [] : ["protagonist.age_band"]),
      ...((c.main_characters ?? []).some((m) => !m.age_band || m.age_band === "unknown") ? ["main_characters"] : []),
    ];
    if (unknown.length) out.push({ code: "age_band_unknown", message: "나이대를 모르는 인물이 있습니다. 인물별 나이대를 정해 주세요.", fieldPaths: unknown });
  }
  if (b.checks.safety.real_person_hits.length) {
    out.push({ code: "real_person", message: "실존 인물을 주요 인물로 둘 수 없습니다. 가상 인물로 바꿔 주세요.", fieldPaths: ["main_characters"] });
  }
  for (const req of b.checks.similarity.copy_requests) {
    const title = normalizeText(req.work_title);
    const remaining = (req.field_paths.length ? req.field_paths : SCANNED_PATHS).filter((p) => title && normalizeText(valueToText(getPath(c, p))).includes(title));
    const blockHits = b.checks.similarity.blocklist_hits.map((h) => h.field_path);
    if (remaining.length || (req.field_paths.length && blockHits.some((p) => req.field_paths.includes(p)))) {
      out.push({ code: "copy_request", message: `'${req.work_title}'의 고유 설정이 남아 있습니다. 해당 필드를 고쳐 주세요.`, fieldPaths: remaining });
    }
  }
  if (getPath(c, "world_rules[item_key=possession_source]") === "real_work") {
    out.push({ code: "possession_real_work", message: "실제 출간작을 원작으로 한 빙의는 지원하지 않습니다. 원작을 작중 가상 소설로 바꿔 주세요.", fieldPaths: ["world_rules[item_key=possession_source]"] });
  }
  return out;
}

/** INV-CON-13 */
export function hashMatches(b: WorkingBrief, expected: string | null): boolean {
  return !!expected && workingBriefHash(b) === expected;
}
