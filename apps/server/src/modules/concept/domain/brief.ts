/**
 * Working brief / ConceptBrief content model (design/11 §5.4) and pure helpers:
 * field paths, provenance, normalization (INV-CON-03 quote check), value coercion and a stable hash (INV-CON-13).
 * No I/O.
 */
import { z } from "zod";
import { ENUMS } from "@ncs/shared/enums";
import type { ConceptFieldOrigin, ConceptSlotState } from "@ncs/shared";
import type { TitleRefreshMeta, TitleSuggestionsMeta } from "./title.js";
import type { AutoApproveState } from "./auto-approve.js";

// ── content schema (lenient: every field optional, unknown keys kept) ──────
const characterBase = {
  character_key: z.string(),
  name: z.string().optional(),
  name_candidates: z.array(z.string()).optional(),
  aliases: z.array(z.string()).optional(),
  body_name: z.string().optional(),
  persona_name: z.string().optional(),
  age_band: z.enum(ENUMS.character_age_band).optional(),
  age_note: z.string().optional(),
};

export const conceptCharacterSchema = z.looseObject({
  ...characterBase,
  role_label: z.string().optional(),
  relation_to_protagonist: z.string().optional(),
  sketch: z.string().optional(),
});
export type ConceptCharacter = z.infer<typeof conceptCharacterSchema>;

export const worldRuleSchema = z.looseObject({ item_key: z.string().optional(), statement: z.string(), value: z.unknown().optional() });
export type WorldRule = z.infer<typeof worldRuleSchema>;

export const briefContentSchema = z.looseObject({
  category: z
    .looseObject({
      genre_key: z.string().optional(),
      genre_label: z.string().optional(),
      subgenre_labels: z.array(z.string()).optional(),
      trope_labels: z.array(z.string()).optional(),
      audience_facet_labels: z.array(z.string()).optional(),
    })
    .optional(),
  target: z.looseObject({ readers: z.string().optional(), platforms: z.array(z.string()).optional() }).optional(),
  age_rating: z.enum(ENUMS.age_rating).optional(),
  title: z.string().optional(),
  logline: z.string().optional(),
  logline_options: z.array(z.string()).optional(),
  premise: z.string().optional(),
  core_hook: z.string().optional(),
  differentiators: z.array(z.string()).optional(),
  protagonist: z
    .looseObject({
      ...characterBase,
      character_key: z.string().optional(),
      starting_condition: z.string().optional(),
      desire: z.string().optional(),
      lack: z.string().optional(),
      abilities: z.string().optional(),
      advantage: z.string().optional(),
    })
    .optional(),
  opposition: z.string().optional(),
  stakes: z.string().optional(),
  main_characters: z.array(conceptCharacterSchema).optional(),
  world_rules: z.array(worldRuleSchema).optional(),
  tone: z.looseObject({ mood: z.string().optional(), narration_mode: z.enum(ENUMS.narration_mode).optional(), style_notes: z.string().optional() }).optional(),
  serial_plan: z
    .looseObject({
      total_episodes_min: z.number().int().optional(),
      total_episodes_max: z.number().int().optional(),
      cadence_episodes_per_week: z.number().int().optional(),
      length_hint: z.string().optional(),
      episode1_hook: z.string().optional(),
      cider_cycle: z.string().optional(),
      long_conflict_engine: z.string().optional(),
      arc_sketch: z.array(z.string()).optional(),
    })
    .optional(),
  ending_direction: z.string().optional(),
  avoid_list: z.array(z.looseObject({ statement: z.string(), kind: z.enum(["content", "trope", "style"]).optional() })).optional(),
  mood_references: z.array(z.looseObject({ title: z.string(), take: z.string().optional(), not_to_copy: z.string().optional() })).optional(),
  title_candidates: z.array(z.string()).optional(),
  keywords: z.array(z.string()).optional(),
  seed_notes: z.string().optional(),
  source_documents: z.array(z.object({ concept_message_id: z.string(), chars: z.number().int(), kind: z.enum(["synopsis", "bible", "notes"]) })).optional(),
  open_questions: z.array(z.object({ field_path: z.string(), note: z.string() })).optional(),
});
export type BriefContent = z.infer<typeof briefContentSchema>;

export interface FieldProvenance {
  origin: ConceptFieldOrigin;
  slot_state: ConceptSlotState;
  evidence_message_ids: string[];
  template_question_ref?: string;
  history_count: number;
}

/**
 * How a proposal left `pending` (domain/change-proposals.ts): button = [제안 수락]/[지금 값 유지],
 * decided_in_chat = the user's words (quote-verified model decision or a yes/no reply),
 * applied_in_chat / form_edit = the user set the proposed value themselves, already_applied = the value
 * got there without a user decision, field_changed = the field moved to another value, replaced = a newer
 * proposal for the same field.
 */
export type ProposalResolution =
  | "button"
  | "decided_in_chat"
  | "applied_in_chat"
  | "form_edit"
  | "already_applied"
  | "field_changed"
  | "replaced"
  /** 설계 추가: accepted by the auto-approve mode the user turned on (domain/auto-approve.ts) */
  | "auto_accepted";

export interface ChangeProposal {
  id: string;
  field_path: string;
  new_value: unknown;
  reason: string;
  status: "pending" | "accepted" | "rejected" | "superseded";
  run_id: string | null;
  /** field value when the proposal was made (absent on proposals stored before this field existed) */
  base_value?: unknown;
  resolution?: ProposalResolution;
  /** user message that settled it (null: settled by the agent turn itself, e.g. replaced) */
  resolved_message_id?: string | null;
}

export interface Conflict {
  field_path: string;
  values: Array<{ value: unknown; channel_id: string; message_id: string }>;
}

export interface BriefChecks {
  working_brief_hash: string | null;
  similarity: {
    blocklist_hits: Array<{ field_path: string; term: string }>;
    copy_requests: Array<{ work_title: string; quote: string; message_id: string; field_paths: string[] }>;
    llm_overlap_signals: Array<{ work_title: string; note: string }>;
    trope_tags: string[];
  };
  safety: {
    age_rating_flags: Array<{ field_path: string | null; keyword: string; message_id: string | null }>;
    minor_flags: Array<{ character_key: string; note: string }>;
    real_person_hits: Array<{ name: string; field_path: string | null; source: "list" | "llm" }>;
  };
  name_duplicates: Array<{ name: string; character_keys: string[] }>;
  checked_by_run_id: string | null;
  /** 설계 추가 0014: the LLM similarity / safety check answered with a valid result in that run (absent = unchecked) */
  llm_checked?: boolean;
}

/** Internal turn state kept with the working brief (not part of the approved content). */
export interface BriefMeta {
  web_channel_id?: string;
  delegate?: { path: string; count: number } | null;
  asked?: { path: string; count: number } | null;
  detail_mode?: boolean;
  conflicts?: Conflict[];
  flip_cards?: Array<{ field_path: string; values: unknown[] }>;
  next_character_no?: number;
  /** cursor: highest user seq already handled by a committed turn */
  processed_seq?: number;
  /** 설계 추가: 추천 제목 (concept_turn / "다른 추천 받기") */
  title_suggestions?: TitleSuggestionsMeta | null;
  /** pending or failed "다른 추천 받기" */
  title_refresh?: TitleRefreshMeta | null;
  /** 설계 추가: 자동 승인 모드 (domain/auto-approve.ts) */
  auto_approve?: AutoApproveState | null;
}

export interface WorkingBrief {
  content: BriefContent;
  field_provenance: Record<string, FieldProvenance>;
  change_proposals: ChangeProposal[];
  checks: BriefChecks;
  meta: BriefMeta;
}

export function emptyChecks(): BriefChecks {
  return {
    working_brief_hash: null,
    similarity: { blocklist_hits: [], copy_requests: [], llm_overlap_signals: [], trope_tags: [] },
    safety: { age_rating_flags: [], minor_flags: [], real_person_hits: [] },
    name_duplicates: [],
    checked_by_run_id: null,
  };
}

export function emptyWorkingBrief(meta: BriefMeta = {}): WorkingBrief {
  return { content: {}, field_provenance: {}, change_proposals: [], checks: emptyChecks(), meta };
}

/** Parse the jsonb column defensively (old/empty rows become an empty brief). */
export function parseWorkingBrief(raw: unknown): WorkingBrief {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<WorkingBrief>;
  const content = briefContentSchema.safeParse(r.content ?? {});
  return {
    content: content.success ? content.data : ((r.content as BriefContent) ?? {}),
    field_provenance: { ...(r.field_provenance ?? {}) },
    change_proposals: [...(r.change_proposals ?? [])],
    checks: { ...emptyChecks(), ...(r.checks ?? {}) },
    meta: { ...(r.meta ?? {}) },
  };
}

export function cloneBrief(b: WorkingBrief): WorkingBrief {
  return structuredClone(b);
}

// ── paths ────────────────────────────────────────────────────────────────
const ITEM_PATH = /^world_rules\[item_key=([a-z_]+)\]$/;

export function getPath(content: BriefContent, path: string): unknown {
  const m = ITEM_PATH.exec(path);
  if (m) return content.world_rules?.find((r) => r.item_key === m[1])?.statement;
  let cur: unknown = content;
  for (const k of path.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

export function setPath(content: BriefContent, path: string, value: unknown): void {
  const m = ITEM_PATH.exec(path);
  if (m) {
    const rules = (content.world_rules ??= []);
    const i = rules.findIndex((r) => r.item_key === m[1]);
    if (value === undefined || value === null || value === "") {
      if (i >= 0) rules.splice(i, 1);
    } else if (i >= 0) rules[i] = { ...rules[i]!, statement: String(value) };
    else rules.push({ item_key: m[1]!, statement: String(value) });
    return;
  }
  const keys = path.split(".");
  let cur = content as Record<string, unknown>;
  for (const k of keys.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  const last = keys[keys.length - 1]!;
  if (value === undefined) delete cur[last];
  else cur[last] = value;
}

export function isEmptyValue(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);
}

export function slotState(b: WorkingBrief, path: string): ConceptSlotState {
  const p = b.field_provenance[path];
  if (p) return p.slot_state;
  return isEmptyValue(getPath(b.content, path)) ? "empty" : "proposed";
}

// ── normalization (06 §3.4-style: NFKC, lower, strip spaces/punctuation) ──
export function normalizeText(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

export function valueToText(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(valueToText).join(", ");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.statement === "string") return o.statement;
    if (typeof o.name === "string") return o.name;
    if (typeof o.title === "string") return o.title;
    if (typeof o.mood === "string") return o.mood;
    return Object.values(o).map(valueToText).filter(Boolean).join(", ");
  }
  return "";
}

export function sameValue(a: unknown, b: unknown): boolean {
  return normalizeText(valueToText(a)) === normalizeText(valueToText(b));
}

// ── stable hash (INV-CON-13) ─────────────────────────────────────────────
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

/** FNV-1a 64-bit over the canonical JSON of content + provenance (checks/meta excluded). */
export function workingBriefHash(b: WorkingBrief): string {
  const s = stableStringify({ content: b.content, field_provenance: b.field_provenance });
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

// ── contribution summary (D-4, 6.2) ──────────────────────────────────────
export function contributionSummary(b: WorkingBrief) {
  const filled = Object.entries(b.field_provenance).filter(([path, p]) => p.slot_state !== "empty" && p.slot_state !== "deferred" && !isEmptyValue(getPath(b.content, path)));
  const by: Record<string, { count: number; ratio: number }> = {};
  for (const [, p] of filled) by[p.origin] = { count: (by[p.origin]?.count ?? 0) + 1, ratio: 0 };
  for (const k of Object.keys(by)) by[k]!.ratio = filled.length ? Math.round((by[k]!.count / filled.length) * 1000) / 1000 : 0;
  return { by_origin: by, filled_count: filled.length };
}
