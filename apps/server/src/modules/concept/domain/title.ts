/**
 * Novel title helpers (설계 추가: 대화하면서 추천 제목·가제 만들기). Pure.
 */
import type { BriefContent, WorkingBrief } from "./brief.js";

export const TITLE_SUGGESTION_MIN = 3;
export const TITLE_SUGGESTION_MAX = 5;

export interface TitleSuggestion {
  title: string;
  reason: string;
}

/** stored in working brief meta (not part of the approved content) */
export interface TitleSuggestionsMeta {
  items: TitleSuggestion[];
  generated_at: string;
  run_id: string | null;
  source: "turn" | "refresh";
}

/** pending "다른 추천 받기" request */
export interface TitleRefreshMeta {
  task_id: string;
  requested_at: string;
  /** set when the last refresh failed (Korean, user-facing) */
  error?: string | null;
}

/** Normalizes a model/user title: strips quotes/brackets, collapses spaces, rejects placeholders. */
export function cleanTitle(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v
    .replace(/[\r\n\t]+/g, " ")
    .replace(/^[\s"'“”‘’「」『』《》<>\[\]]+|[\s"'“”‘’「」『』《》<>\[\]]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 80);
  if (!t || /^(제목\s*미정|무제|없음|null|미정)$/i.test(t)) return null;
  return t;
}

const key = (t: string) => t.replace(/\s+/g, "").toLowerCase();

/**
 * Cleans, de-duplicates and caps model suggestions. Titles in `exclude` (e.g. the previous set on refresh)
 * are dropped. Returns null when fewer than TITLE_SUGGESTION_MIN usable titles remain.
 */
export function normalizeTitleSuggestions(
  raw: ReadonlyArray<{ title: unknown; reason?: unknown }>,
  opts: { exclude?: readonly string[]; min?: number } = {},
): TitleSuggestion[] | null {
  const seen = new Set((opts.exclude ?? []).map(key));
  const out: TitleSuggestion[] = [];
  for (const r of raw) {
    const t = cleanTitle(r.title);
    if (!t || seen.has(key(t))) continue;
    seen.add(key(t));
    out.push({ title: t, reason: typeof r.reason === "string" ? r.reason.replace(/\s+/g, " ").trim().slice(0, 200) : "" });
    if (out.length >= TITLE_SUGGESTION_MAX) break;
  }
  return out.length >= (opts.min ?? TITLE_SUGGESTION_MIN) ? out : null;
}

const FILLED_FOR_TITLE: ReadonlyArray<(c: BriefContent) => unknown> = [
  (c) => c.seed_notes,
  (c) => c.category?.genre_key ?? c.category?.genre_label,
  (c) => c.logline,
  (c) => c.premise,
  (c) => c.core_hook,
  (c) => c.protagonist?.name ?? c.protagonist?.starting_condition ?? c.protagonist?.desire,
  (c) => c.opposition,
];

/** enough material for title suggestions: at least one story field (seed notes, genre, hook, protagonist …) */
export function hasTitleMaterial(b: WorkingBrief): boolean {
  return FILLED_FOR_TITLE.some((f) => {
    const v = f(b.content);
    return typeof v === "string" ? v.trim().length > 0 : v != null;
  });
}
