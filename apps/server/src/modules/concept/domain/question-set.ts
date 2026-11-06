/**
 * MVP-α common question set `common@1` (design/11 §8.2) as `ConceptQuestionDef`-shaped constants (§3.6),
 * required/conditional slot rules (§3.7), field dependencies (§3.7 표) and value coercion. Pure.
 */
import type { AgeRating, CharacterAgeBand, ConceptQuestionRequiredLevel, ConceptStage } from "@ncs/shared";
import { getPath, isEmptyValue, normalizeText, type BriefContent } from "./brief.js";

export const QUESTION_SET_VERSION = "common@1";

export type SlotValueType =
  | "text"
  | "list"
  | "age_rating"
  | "age_band"
  | "int"
  | "characters"
  | "avoid_list"
  | "mood_refs"
  | "tone"
  | "possession_source";

export interface OptionSeed {
  label: string;
  value: string;
  note?: string;
}

export interface ConceptQuestionDef {
  /** `cq-02` … (key), display id `CQ-02` */
  key: string;
  id: string;
  stage: ConceptStage;
  /** primary field path this question fills */
  path: string;
  /** Korean slot label (badges, notices) */
  label: string;
  /** Y → core, C → core when askWhen, — → optional */
  required: "core" | "conditional" | "optional";
  askWhen?: (c: BriefContent) => boolean;
  ask_ko: string;
  why_ko?: string;
  option_seeds: OptionSeed[];
  /** fallback candidates when the model gives none ([추천해 줘]/위임) */
  fallback_candidates: string[];
  valueType: SlotValueType;
  /** 3.5 위임 불가 항목 */
  delegable: boolean;
  safety_flags?: Array<"real_person_risk" | "copyright_risk">;
}

const GENRES_WITH_POWER_RANK = ["무협", "판타지", "현판", "현대판타지", "로판", "로맨스판타지"];
const ROMANCE_WORDS = ["연애", "로맨스", "로판", "사랑", "키스", "결혼", "계약결혼", "연인", "성적", "섹스", "애정"];
const MINOR_CONTEXT_TROPES = ["아카데미", "학원", "육아"];

const lower = (s: string | undefined) => normalizeText(s ?? "");
const tropes = (c: BriefContent) => (c.category?.trope_labels ?? []).map(lower);
const hasTrope = (c: BriefContent, ...names: string[]) => tropes(c).some((t) => names.some((n) => t.includes(lower(n))));
export const genreText = (c: BriefContent) => lower(c.category?.genre_label ?? c.category?.genre_key);

/** 3.7 조건부 필수 (a): 연애·성적 맥락 키워드 또는 아카데미·학원·육아 트로프 */
export function needsAgeBands(c: BriefContent): boolean {
  if (hasTrope(c, ...MINOR_CONTEXT_TROPES)) return true;
  return hasRomanceContext(c);
}

export function hasRomanceContext(c: BriefContent): boolean {
  const text = lower(
    [
      c.category?.genre_label,
      ...(c.category?.trope_labels ?? []),
      ...(c.category?.subgenre_labels ?? []),
      c.seed_notes,
      c.core_hook,
      c.protagonist?.desire,
      c.premise,
      c.logline,
    ]
      .filter(Boolean)
      .join(" "),
  );
  return ROMANCE_WORDS.some((w) => text.includes(lower(w)));
}

export const COMMON_1: readonly ConceptQuestionDef[] = [
  {
    key: "cq-01", id: "CQ-01", stage: "opening", path: "seed_notes", label: "씨앗 메모", required: "optional",
    ask_ko: "떠오른 장면·인물·제목·느낌을 자유롭게 적어 주세요. 아직 없으면 '없음'이라고 적어 주세요.",
    option_seeds: [{ label: "아직 없음", value: "@none" }], fallback_candidates: [], valueType: "text", delegable: false,
  },
  {
    key: "cq-02", id: "CQ-02", stage: "diverging", path: "category.genre_label", label: "장르", required: "core",
    ask_ko: "어떤 장르입니까?",
    option_seeds: ["로맨스", "로판", "판타지", "현판", "무협"].map((g) => ({ label: g, value: g })),
    fallback_candidates: ["현판", "판타지", "무협"], valueType: "text", delegable: true,
  },
  {
    key: "cq-16", id: "CQ-16", stage: "diverging", path: "age_rating", label: "연령 등급", required: "core",
    ask_ko: "연령 등급은 무엇으로 할까요? (이후 제시할 소재가 이 등급에 맞춰집니다)",
    why_ko: "현재는 15세 이용가까지만 지원합니다.",
    option_seeds: [{ label: "전체", value: "all" }, { label: "12세", value: "age_12" }, { label: "15세", value: "age_15" }],
    fallback_candidates: ["age_15"], valueType: "age_rating", delegable: true,
  },
  {
    key: "cq-02a", id: "CQ-02a", stage: "diverging", path: "category.subgenre_labels", label: "하위 장르", required: "optional",
    ask_ko: "더 좁힌 장르나 주 독자 성향이 있습니까?",
    option_seeds: [{ label: "남성향", value: "남성향" }, { label: "여성향", value: "여성향" }], fallback_candidates: [], valueType: "list", delegable: true,
  },
  {
    key: "cq-03", id: "CQ-03", stage: "diverging", path: "category.trope_labels", label: "트로프", required: "optional",
    ask_ko: "쓰고 싶은 장치나 키워드가 있습니까? (여러 개 가능)",
    option_seeds: ["회귀", "빙의", "환생", "상태창", "헌터", "아카데미", "계약결혼", "복수", "육아", "전문직"].map((g) => ({ label: g, value: g })),
    fallback_candidates: [], valueType: "list", delegable: true,
  },
  {
    key: "cq-04", id: "CQ-04", stage: "diverging", path: "protagonist.starting_condition", label: "주인공 출발 조건", required: "core",
    ask_ko: "1화 시작 시점의 주인공은 누구이고 어떤 처지입니까?", option_seeds: [],
    fallback_candidates: ["모든 것을 잃고 밑바닥에서 다시 시작하는 인물", "숨긴 재능을 가진 평범한 하급자", "과거를 기억한 채 같은 시간을 다시 사는 인물"],
    valueType: "text", delegable: true,
  },
  {
    key: "cq-05", id: "CQ-05", stage: "diverging", path: "protagonist.desire", label: "주인공의 욕망", required: "core",
    ask_ko: "주인공이 가장 원하는 것은 무엇입니까?", option_seeds: [],
    fallback_candidates: ["자신을 배신한 자에게 복수", "소중한 사람을 지키기", "세계의 비밀 밝히기"], valueType: "text", delegable: true,
  },
  {
    key: "cq-06", id: "CQ-06", stage: "diverging", path: "protagonist.lack", label: "주인공의 결핍", required: "optional",
    ask_ko: "주인공에게 부족하거나 감춘 것은 무엇입니까?", option_seeds: [], fallback_candidates: [], valueType: "text", delegable: true,
  },
  {
    key: "cq-07", id: "CQ-07", stage: "diverging", path: "opposition", label: "대립", required: "core",
    ask_ko: "그 욕망을 가장 크게 막는 것(사람·세력·규칙)은 무엇입니까?", option_seeds: [],
    fallback_candidates: ["주인공을 배신한 최상위 세력", "세계를 지배하는 가혹한 규칙", "주인공의 과거를 아는 숙적"], valueType: "text", delegable: true,
  },
  {
    key: "cq-08", id: "CQ-08", stage: "diverging", path: "stakes", label: "걸린 것", required: "optional",
    ask_ko: "실패하면 무엇을 잃습니까?", option_seeds: [], fallback_candidates: [], valueType: "text", delegable: true,
  },
  {
    key: "cq-09", id: "CQ-09", stage: "diverging", path: "core_hook", label: "핵심 훅", required: "core",
    ask_ko: "이 이야기의 의외성·훅은 무엇입니까? 흔한 같은 장르 작품과 다른 점은?", option_seeds: [],
    fallback_candidates: ["약점이라 여겨진 능력이 사실 최강의 열쇠", "적이 사실 미래의 자신", "모두가 아는 결말을 주인공만 바꿀 수 있음"],
    valueType: "text", delegable: true,
  },
  {
    key: "cq-10", id: "CQ-10", stage: "diverging", path: "world_rules[item_key=core]", label: "세계 핵심 규칙", required: "optional",
    ask_ko: "이 세계에서 꼭 지켜야 할 규칙 1~3개는?", option_seeds: [], fallback_candidates: [], valueType: "text", delegable: true,
  },
  {
    key: "cq-10a", id: "CQ-10a", stage: "diverging", path: "world_rules[item_key=regression]", label: "회귀 규칙", required: "conditional",
    askWhen: (c) => hasTrope(c, "회귀"),
    ask_ko: "회귀는 언제로, 몇 번, 무엇을 기억한 채 일어납니까?",
    option_seeds: ["1회·기억 전부", "반복 회귀", "기억 일부"].map((g) => ({ label: g, value: g })), fallback_candidates: ["1회·기억 전부"], valueType: "text", delegable: true,
  },
  {
    key: "cq-10b", id: "CQ-10b", stage: "diverging", path: "world_rules[item_key=possession]", label: "빙의 대상", required: "conditional",
    askWhen: (c) => hasTrope(c, "빙의"),
    ask_ko: "누구 몸에 들어갑니까?",
    option_seeds: ["작중 가상 원작의 악역", "작중 가상 원작의 조연", "작중 가상 원작의 엑스트라"].map((g) => ({ label: g, value: g })),
    fallback_candidates: ["작중 가상 원작의 악역"], valueType: "text", delegable: true, safety_flags: ["copyright_risk"],
  },
  {
    key: "cq-10b-src", id: "CQ-10b", stage: "diverging", path: "world_rules[item_key=possession_source]", label: "빙의 원작", required: "conditional",
    askWhen: (c) => hasTrope(c, "빙의"),
    ask_ko: "빙의 대상 원작은 이 작품 안의 가상 소설입니까?",
    why_ko: "실제 출간작을 원작으로 한 빙의는 지원하지 않습니다(D-35).",
    option_seeds: [{ label: "작중 가상 소설", value: "fictional" }, { label: "실제 출간작", value: "real_work" }],
    fallback_candidates: ["fictional"], valueType: "possession_source", delegable: false, safety_flags: ["copyright_risk"],
  },
  {
    key: "cq-10c", id: "CQ-10c", stage: "diverging", path: "world_rules[item_key=status_window]", label: "상태창 규칙", required: "conditional",
    askWhen: (c) => hasTrope(c, "상태창", "시스템"),
    ask_ko: "상태창에 보이는 수치 항목과 보상 규칙은?",
    option_seeds: ["레벨·스탯", "퀘스트 보상", "숨김"].map((g) => ({ label: g, value: g })), fallback_candidates: ["레벨·스탯"], valueType: "text", delegable: true,
  },
  {
    key: "cq-10d", id: "CQ-10d", stage: "diverging", path: "world_rules[item_key=power_rank]", label: "힘·지위 단계", required: "conditional",
    askWhen: (c) => GENRES_WITH_POWER_RANK.some((g) => genreText(c).includes(lower(g))),
    ask_ko: "힘·지위는 어떤 단계로 나뉩니까? (경지·작위·등급)",
    option_seeds: [{ label: "무협: 삼류~화경", value: "삼류~화경" }, { label: "로판: 작위 5등급", value: "작위 5등급" }, { label: "현판: F~S급", value: "F~S급" }],
    fallback_candidates: ["F~S급"], valueType: "text", delegable: true,
  },
  {
    key: "cq-11-age", id: "CQ-11", stage: "diverging", path: "protagonist.age_band", label: "주인공 나이대", required: "conditional",
    askWhen: needsAgeBands,
    ask_ko: "주인공의 나이대는 무엇입니까? (아동·청소년·성인)",
    option_seeds: [{ label: "아동", value: "child" }, { label: "청소년", value: "teen" }, { label: "성인", value: "adult" }],
    fallback_candidates: [], valueType: "age_band", delegable: false,
  },
  {
    key: "cq-11", id: "CQ-11", stage: "diverging", path: "main_characters", label: "주요 인물", required: "optional",
    ask_ko: "꼭 필요한 주요 인물 1~3명은? 나이대(아동·청소년·성인)도 알려 주세요.", option_seeds: [], fallback_candidates: [], valueType: "characters", delegable: true,
  },
  {
    key: "cq-12", id: "CQ-12", stage: "converging", path: "serial_plan.long_conflict_engine", label: "연재 엔진", required: "optional",
    ask_ko: "120화를 끌고 갈 반복 갈등은 무엇입니까? 1화 마지막 장면도 떠오르면 알려 주세요.", option_seeds: [], fallback_candidates: [], valueType: "text", delegable: true,
  },
  {
    key: "cq-13", id: "CQ-13", stage: "converging", path: "ending_direction", label: "결말 방향", required: "core",
    ask_ko: "결말은 어느 방향입니까?", option_seeds: [],
    fallback_candidates: ["목표를 이루지만 큰 대가를 치르는 결말", "모든 갈등을 해소하는 해피엔딩", "새로운 시작을 암시하는 열린 결말"], valueType: "text", delegable: true,
  },
  {
    key: "cq-14", id: "CQ-14", stage: "converging", path: "tone", label: "톤·문체", required: "optional",
    ask_ko: "분위기와 문체는? (1인칭/3인칭 포함)",
    option_seeds: ["가볍게", "진지하게", "어둡게"].map((g) => ({ label: g, value: g })), fallback_candidates: [], valueType: "tone", delegable: true,
  },
  {
    key: "cq-15", id: "CQ-15", stage: "converging", path: "serial_plan.total_episodes_min", label: "화수 초안", required: "optional",
    ask_ko: "대략 몇 화, 주 몇 회 연재를 생각합니까?",
    option_seeds: ["100", "150", "200"].map((g) => ({ label: `${g}화`, value: g })), fallback_candidates: [], valueType: "int", delegable: true,
  },
  {
    key: "cq-17", id: "CQ-17", stage: "converging", path: "target.readers", label: "타깃 독자", required: "optional",
    ask_ko: "주 독자층과 올릴 플랫폼은?", option_seeds: [], fallback_candidates: [], valueType: "text", delegable: true,
  },
  {
    key: "cq-18", id: "CQ-18", stage: "converging", path: "avoid_list", label: "회피 요소", required: "optional",
    ask_ko: "피하고 싶은 소재·전개가 있습니까?", option_seeds: [], fallback_candidates: [], valueType: "avoid_list", delegable: true,
  },
  {
    key: "cq-19", id: "CQ-19", stage: "converging", path: "mood_references", label: "분위기 참고 작품", required: "optional",
    ask_ko: "분위기를 참고할 작품이 있다면, 무엇을 참고하고 무엇은 가져오지 않을까요?", option_seeds: [], fallback_candidates: [], valueType: "mood_refs", delegable: true,
  },
  {
    key: "cq-20", id: "CQ-20", stage: "confirming", path: "title_candidates", label: "제목 후보", required: "optional",
    ask_ko: "제목 후보를 골라 주세요.", option_seeds: [], fallback_candidates: [], valueType: "list", delegable: true,
  },
  {
    key: "cq-21", id: "CQ-21", stage: "confirming", path: "logline", label: "로그라인", required: "core",
    ask_ko: "이 중 가장 가까운 로그라인은 무엇입니까?", option_seeds: [], fallback_candidates: [], valueType: "text", delegable: true,
  },
];

/** additional user-editable paths that are not question slots */
export const EXTRA_EDITABLE: Record<string, { label: string; valueType: SlotValueType }> = {
  title: { label: "제목", valueType: "text" },
  premise: { label: "전제", valueType: "text" },
  differentiators: { label: "차별점", valueType: "list" },
  "protagonist.name": { label: "주인공 이름", valueType: "text" },
  "protagonist.age_note": { label: "주인공 나이 설명", valueType: "text" },
  "protagonist.abilities": { label: "주인공 능력", valueType: "text" },
  "serial_plan.total_episodes_max": { label: "최대 화수", valueType: "int" },
  "serial_plan.cadence_episodes_per_week": { label: "주당 연재 횟수", valueType: "int" },
  "serial_plan.episode1_hook": { label: "1화 훅", valueType: "text" },
  "serial_plan.cider_cycle": { label: "사이다 주기", valueType: "text" },
  "serial_plan.length_hint": { label: "분량 힌트", valueType: "text" },
  "category.audience_facet_labels": { label: "독자 성향", valueType: "list" },
  "target.platforms": { label: "타깃 플랫폼", valueType: "list" },
  "tone.narration_mode": { label: "시점", valueType: "text" },
  keywords: { label: "키워드", valueType: "list" },
  logline_options: { label: "로그라인 후보", valueType: "list" },
};

export const DEF_BY_PATH: ReadonlyMap<string, ConceptQuestionDef> = new Map(COMMON_1.map((d) => [d.path, d]));

export function slotLabel(path: string): string {
  return DEF_BY_PATH.get(path)?.label ?? EXTRA_EDITABLE[path]?.label ?? path;
}

export function isKnownPath(path: string): boolean {
  return DEF_BY_PATH.has(path) || path in EXTRA_EDITABLE;
}

export function valueTypeOf(path: string): SlotValueType {
  return DEF_BY_PATH.get(path)?.valueType ?? EXTRA_EDITABLE[path]?.valueType ?? "text";
}

export function requiredLevel(def: ConceptQuestionDef, c: BriefContent): ConceptQuestionRequiredLevel {
  if (def.required === "core") return "core";
  if (def.required === "conditional") return def.askWhen?.(c) ? "core" : "optional";
  return "optional";
}

/** 3.7 필수 + 조건부 필수 paths currently active for this content (INV-CON-05). */
export function requiredPaths(c: BriefContent): string[] {
  return COMMON_1.filter((d) => requiredLevel(d, c) === "core" && (d.required === "core" || d.askWhen?.(c))).map((d) => d.path);
}

/** 3.2 다음 단계 조건: required slots belonging to stages up to and including `stage` */
export function requiredPathsForStage(c: BriefContent, stage: ConceptStage): string[] {
  const order: ConceptStage[] = ["opening", "diverging", "converging", "confirming"];
  const upto = order.indexOf(stage);
  return COMMON_1.filter((d) => order.indexOf(d.stage) <= upto && requiredLevel(d, c) === "core").map((d) => d.path);
}

// ── field dependencies (3.7 표, 결정적 상수) ──────────────────────────────
const TEMPLATE_CHILDREN = ["world_rules[item_key=regression]", "world_rules[item_key=possession]", "world_rules[item_key=status_window]", "world_rules[item_key=power_rank]"];
export const FIELD_DEPENDENCIES: ReadonlyArray<{ parents: (p: string) => boolean; children: string[] }> = [
  {
    parents: (p) => p.startsWith("category."),
    children: ["world_rules[item_key=core]", ...TEMPLATE_CHILDREN, "core_hook", "differentiators", "logline"],
  },
  { parents: (p) => p === "protagonist.starting_condition", children: [...TEMPLATE_CHILDREN, "core_hook", "protagonist.desire", "logline"] },
  { parents: (p) => p === "age_rating", children: ["avoid_list", "tone"] },
  { parents: (p) => ["protagonist.desire", "opposition", "core_hook", "ending_direction"].includes(p), children: ["logline"] },
];

export function dependentsOf(path: string): string[] {
  const out = new Set<string>();
  for (const d of FIELD_DEPENDENCIES) if (d.parents(path)) d.children.forEach((c) => c !== path && out.add(c));
  return [...out];
}

// ── value coercion (free text / option values / form edits) ─────────────
const LIST_SPLIT = /[,，、/\n]+|\s+및\s+|\s*·\s*/;

export function parseAgeRating(text: string): AgeRating | null {
  const t = normalizeText(text);
  if (["all", "age12", "age15", "age19"].includes(t)) return (t === "all" ? "all" : `age_${t.slice(3)}`) as AgeRating;
  if (/19|성인|18|adult/.test(t)) return "age_19";
  if (/15/.test(t)) return "age_15";
  if (/12/.test(t)) return "age_12";
  if (/전체|모두|all|누구나/.test(t)) return "all";
  return null;
}

export function parseAgeBand(text: string): CharacterAgeBand {
  const t = normalizeText(text);
  if (["child", "teen", "adult", "unknown"].includes(t)) return t as CharacterAgeBand;
  if (/아동|어린이|어린|초등|child/.test(t)) return "child";
  if (/청소년|고등|중학|학생|10대|십대|teen/.test(t)) return "teen";
  if (/성인|어른|adult|[2-9]0대|[2-9]\d세/.test(t)) return "adult";
  return "unknown";
}

/**
 * Coerce a user/agent value into the slot's shape. `nextCharKey` issues `chr_<n>` keys (5.4).
 * Returns `undefined` when nothing usable remains.
 */
/**
 * "윤서진: 서하의 언니. 칠 년 전 실종" / "강태오(재개발 조합장)" / "백우진 - 형사" → name + sketch (live-test regression: a model
 * listed main characters as "name: description" strings and the whole line became the name). A head longer than a name
 * (> 12 chars or more than 3 words) is not split.
 */
export function splitCharacterText(text: string): { name: string; sketch: string } {
  const t = text.trim();
  const m = /^([^:：()（）\-–—,.]{1,40}?)\s*(?:[:：]|\s[-–—]\s|[(（])\s*(.*)$/su.exec(t);
  if (!m) return { name: t, sketch: "" };
  const head = m[1]!.trim();
  if (!head || head.length > 12 || head.split(/\s+/).length > 3) return { name: t, sketch: "" };
  return { name: head, sketch: m[2]!.replace(/[)）]\s*$/u, "").trim() };
}

export function coerceValue(path: string, raw: unknown, nextCharKey: () => string): unknown {
  const type = valueTypeOf(path);
  const text = typeof raw === "string" ? raw.trim() : raw;
  switch (type) {
    case "text":
      return typeof text === "string" ? (text || undefined) : isEmptyValue(text) ? undefined : String(Array.isArray(text) ? text.join(", ") : JSON.stringify(text));
    case "list": {
      const items = Array.isArray(text) ? text.map((x) => String(x).trim()) : typeof text === "string" ? text.split(LIST_SPLIT).map((x) => x.trim()) : [];
      const out = [...new Set(items.filter(Boolean))];
      return out.length ? (path === "category.subgenre_labels" ? out.slice(0, 2) : out) : undefined;
    }
    case "age_rating":
      return typeof text === "string" ? parseAgeRating(text) ?? undefined : undefined;
    case "age_band":
      return typeof text === "string" ? parseAgeBand(text) : undefined;
    case "int": {
      const n = typeof text === "number" ? text : typeof text === "string" ? Number(/\d+/.exec(text)?.[0]) : NaN;
      return Number.isFinite(n) && n > 0 ? Math.trunc(n) : undefined;
    }
    case "possession_source": {
      const t = normalizeText(String(text ?? ""));
      if (!t) return undefined;
      if (t === "fictional" || /가상|작중|오리지널/.test(t)) return "fictional";
      if (t === "realwork" || /실제|출간|실존|real/.test(t)) return "real_work";
      return String(text);
    }
    case "characters": {
      if (Array.isArray(text) && text.every((x) => x && typeof x === "object")) {
        return (text as Array<Record<string, unknown>>).slice(0, 6).map((x) => {
          const split = typeof x.name === "string" ? splitCharacterText(x.name) : null;
          const sketch = typeof x.sketch === "string" && x.sketch.trim() ? x.sketch : split?.sketch || x.sketch;
          return {
            ...x,
            ...(split ? { name: split.name } : {}),
            ...(sketch !== undefined ? { sketch } : {}),
            character_key: typeof x.character_key === "string" ? x.character_key : nextCharKey(),
            age_band: typeof x.age_band === "string" ? parseAgeBand(x.age_band) : "unknown",
          };
        });
      }
      const parts = (Array.isArray(text) ? text.map(String) : String(text ?? "").split(/[,，、\n]+/)).map((x) => x.trim()).filter(Boolean);
      if (!parts.length) return undefined;
      return parts.slice(0, 6).map((p) => {
        const band = parseAgeBand(p);
        const split = splitCharacterText(p);
        const name = (split.sketch ? split.name : p.replace(/\((.*?)\)|아동|어린이|청소년|성인|10대|[2-9]0대/g, "").trim()) || p;
        return { character_key: nextCharKey(), name, name_candidates: [], aliases: [], age_band: band, sketch: split.sketch || p };
      });
    }
    case "avoid_list": {
      const items = Array.isArray(text) ? text : String(text ?? "").split(LIST_SPLIT);
      const out = items
        .map((x) => (typeof x === "object" && x ? (x as { statement: string }) : { statement: String(x).trim(), kind: "content" as const }))
        .filter((x) => x.statement);
      return out.length ? out : undefined;
    }
    case "mood_refs": {
      const items = Array.isArray(text) ? text : String(text ?? "").split(/[,，、\n]+/);
      const out = items
        .map((x) => (typeof x === "object" && x ? (x as { title: string }) : { title: String(x).trim(), take: "", not_to_copy: "설정·고유명" }))
        .filter((x) => x.title);
      return out.length ? out : undefined;
    }
    case "tone": {
      if (text && typeof text === "object" && !Array.isArray(text)) return text;
      const s = String(text ?? "").trim();
      if (!s) return undefined;
      const narration = /1인칭/.test(s) ? "first_person" : /3인칭|삼인칭/.test(s) ? (/전지/.test(s) ? "third_omniscient" : "third_limited") : undefined;
      return { mood: s, ...(narration ? { narration_mode: narration } : {}), style_notes: "" };
    }
  }
}

/** required content value is "present" (age_band must be known) */
export function hasUsableValue(c: BriefContent, path: string): boolean {
  const v = getPath(c, path);
  if (isEmptyValue(v)) return false;
  if (path.endsWith("age_band")) return v !== "unknown";
  return true;
}
