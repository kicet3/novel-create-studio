/**
 * Working-brief field catalogue for the brief panel (mirrors concept common@1 question set paths +
 * EXTRA_EDITABLE in the server's concept domain). Only display metadata — the server validates edits.
 */
import { labelKo, type EnumName } from "@ncs/shared";

export type FieldValueType = "text" | "list" | "int" | "complex" | "choice";

export interface BriefFieldDef {
  path: string;
  label: string;
  valueType: FieldValueType;
  required?: boolean;
  group: "기본" | "주인공" | "이야기" | "세계" | "연재" | "기타";
  /** valueType=choice: enum whose values are stored and whose Korean labels are shown */
  choice?: { enum: EnumName; values: readonly string[] };
}

export const BRIEF_FIELDS: readonly BriefFieldDef[] = [
  { path: "title", label: "제목", valueType: "text", group: "기본" },
  { path: "title_candidates", label: "제목 후보", valueType: "list", group: "기본" },
  { path: "category.genre_label", label: "장르", valueType: "text", required: true, group: "기본" },
  { path: "category.subgenre_labels", label: "하위 장르", valueType: "list", group: "기본" },
  { path: "category.trope_labels", label: "트로프", valueType: "list", group: "기본" },
  // 15세 이용가까지만 (age_19 is refused by the server)
  { path: "age_rating", label: "연령 등급", valueType: "choice", required: true, group: "기본", choice: { enum: "age_rating", values: ["all", "age_12", "age_15"] } },
  { path: "target.readers", label: "타깃 독자", valueType: "text", group: "기본" },
  { path: "logline", label: "로그라인", valueType: "text", required: true, group: "이야기" },
  { path: "premise", label: "전제", valueType: "text", group: "이야기" },
  { path: "core_hook", label: "핵심 훅", valueType: "text", required: true, group: "이야기" },
  { path: "differentiators", label: "차별점", valueType: "list", group: "이야기" },
  { path: "opposition", label: "대립", valueType: "text", required: true, group: "이야기" },
  { path: "stakes", label: "걸린 것", valueType: "text", group: "이야기" },
  { path: "ending_direction", label: "결말 방향", valueType: "text", required: true, group: "이야기" },
  { path: "protagonist.name", label: "주인공 이름", valueType: "text", group: "주인공" },
  { path: "protagonist.starting_condition", label: "출발 조건", valueType: "text", required: true, group: "주인공" },
  { path: "protagonist.desire", label: "욕망", valueType: "text", required: true, group: "주인공" },
  { path: "protagonist.lack", label: "결핍", valueType: "text", group: "주인공" },
  { path: "protagonist.abilities", label: "능력", valueType: "text", group: "주인공" },
  { path: "protagonist.age_band", label: "나이대", valueType: "text", group: "주인공" },
  { path: "main_characters", label: "주요 인물", valueType: "complex", group: "주인공" },
  { path: "world_rules[item_key=core]", label: "세계 핵심 규칙", valueType: "text", group: "세계" },
  { path: "world_rules[item_key=regression]", label: "회귀 규칙", valueType: "text", group: "세계" },
  { path: "world_rules[item_key=possession]", label: "빙의 대상", valueType: "text", group: "세계" },
  { path: "world_rules[item_key=status_window]", label: "상태창 규칙", valueType: "text", group: "세계" },
  { path: "world_rules[item_key=power_rank]", label: "힘·지위 단계", valueType: "text", group: "세계" },
  { path: "tone", label: "톤·문체", valueType: "complex", group: "연재" },
  { path: "serial_plan.total_episodes_min", label: "화수 초안", valueType: "int", group: "연재" },
  { path: "serial_plan.total_episodes_max", label: "최대 화수", valueType: "int", group: "연재" },
  { path: "serial_plan.cadence_episodes_per_week", label: "주당 연재 횟수", valueType: "int", group: "연재" },
  { path: "serial_plan.long_conflict_engine", label: "연재 엔진", valueType: "text", group: "연재" },
  { path: "serial_plan.episode1_hook", label: "1화 훅", valueType: "text", group: "연재" },
  { path: "serial_plan.length_hint", label: "분량 힌트", valueType: "text", group: "연재" },
  { path: "seed_notes", label: "씨앗 메모", valueType: "text", group: "기타" },
  { path: "avoid_list", label: "회피 요소", valueType: "complex", group: "기타" },
  { path: "mood_references", label: "분위기 참고 작품", valueType: "complex", group: "기타" },
];

const RULE_PATH = /^world_rules\[item_key=([^\]]+)\]$/;

/** Read a brief value by path (dots + `world_rules[item_key=x]`). */
export function getBriefValue(content: Record<string, unknown>, path: string): unknown {
  const rule = RULE_PATH.exec(path);
  if (rule) {
    const rules = content.world_rules;
    if (!Array.isArray(rules)) return undefined;
    const r = rules.find((x) => x && typeof x === "object" && (x as { item_key?: unknown }).item_key === rule[1]) as { statement?: unknown } | undefined;
    return r?.statement;
  }
  let cur: unknown = content;
  for (const part of path.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function isEmptyBriefValue(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);
}

/** Human-readable text for any brief value. */
/** display text of a field value: enum fields show their Korean label (FR-UI-03) */
export function fieldValueText(def: Pick<BriefFieldDef, "choice"> | undefined, v: unknown): string {
  if (def?.choice && typeof v === "string") return labelKo(def.choice.enum, v);
  return briefValueText(v);
}

/** Korean label of a brief field path (chat badges, proposals); falls back to the path */
export function fieldLabel(path: string): string {
  return BRIEF_FIELDS.find((f) => f.path === path)?.label ?? path;
}

export function briefValueText(v: unknown): string {
  if (isEmptyBriefValue(v)) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(briefValueText).filter(Boolean).join(", ");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["name", "statement", "title", "label", "take", "mood"]) {
      if (typeof o[k] === "string" && o[k]) {
        const extra = typeof o.role_label === "string" ? ` (${o.role_label})` : "";
        return `${o[k] as string}${extra}`;
      }
    }
    return Object.entries(o)
      .filter(([k, x]) => !k.endsWith("_key") && !isEmptyBriefValue(x))
      .map(([, x]) => briefValueText(x))
      .join(" · ");
  }
  return "";
}

/** Text in the edit box → value sent to PATCH …/brief. */
export function parseEditValue(type: FieldValueType, raw: string): unknown {
  const t = raw.trim();
  if (t === "") return null;
  if (type === "int") return Number.isFinite(Number(t)) ? Math.trunc(Number(t)) : t;
  if (type === "list") return t.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  return t;
}

export function editText(type: FieldValueType, v: unknown): string {
  if (type === "list" && Array.isArray(v)) return v.map(briefValueText).join("\n");
  return briefValueText(v);
}
