/**
 * Pure display helpers for the audit timeline (08 §9.7): day grouping in the novel's wall clock, relative time,
 * area categories (colour + icon + label) and one natural Korean sentence per event.
 */
import type { NavIconName } from "../../components/layout/icons.js";
import type { Tone } from "../../components/ui/tone.js";
import { actionAreaKo, refTypeKo, safeLabel, verbKo } from "./labels.js";

// ── time ────────────────────────────────────────────────────────────────────
const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(key: string, timeZone: string | undefined, opts: Intl.DateTimeFormatOptions, locale = "ko-KR"): Intl.DateTimeFormat {
  const k = `${key}|${timeZone ?? ""}`;
  let f = dtfCache.get(k);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(locale, { ...opts, timeZone });
    } catch {
      f = new Intl.DateTimeFormat(locale, opts);
    }
    dtfCache.set(k, f);
  }
  return f;
}

function toDate(v: string | Date): Date {
  return typeof v === "string" ? new Date(v) : v;
}

/** `YYYY-MM-DD` of the instant in the given IANA zone ("" for invalid input). */
export function dayKey(value: string | Date, timeZone?: string): string {
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return "";
  // formatToParts: independent of the locale's separator/order (ICU has changed `en-CA` output before)
  const parts = dtf("day", timeZone, { year: "numeric", month: "2-digit", day: "2-digit" }, "en-US").formatToParts(d);
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "";
  const y = get("year");
  const m = get("month").padStart(2, "0");
  const day = get("day").padStart(2, "0");
  return /^\d{4}$/.test(y) && /^\d{2}$/.test(m) && /^\d{2}$/.test(day) ? `${y}-${m}-${day}` : "";
}

function shiftDay(key: string, days: number): string {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];

/** Header for a day group: `{ title: "오늘", sub: "11월 6일 (금)" }` / `{ title: "11월 4일 (수)" }` / with year when not this year. */
export function dayLabelKo(key: string, now: number = Date.now(), timeZone?: string): { title: string; sub?: string } {
  if (!key) return { title: "날짜 미상" };
  const today = dayKey(new Date(now), timeZone);
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  const wd = WEEKDAY[new Date(`${key}T00:00:00Z`).getUTCDay()];
  const md = `${m}월 ${d}일 (${wd})`;
  const full = today.slice(0, 4) === key.slice(0, 4) ? md : `${y}년 ${md}`;
  if (key === today) return { title: "오늘", sub: full };
  if (key === shiftDay(today, -1)) return { title: "어제", sub: full };
  return { title: full };
}

export interface DayGroup<T> {
  key: string;
  items: T[];
}

/**
 * Items (already newest first) bucketed by wall-clock day; group order = first appearance, item order preserved.
 * One group per day even when seq order and occurredAt disagree around midnight (unique keys / heading ids).
 */
export function groupByDay<T extends { occurredAt: string }>(items: readonly T[], timeZone?: string): Array<DayGroup<T>> {
  const out: Array<DayGroup<T>> = [];
  const byKey = new Map<string, DayGroup<T>>();
  for (const it of items) {
    const key = dayKey(it.occurredAt, timeZone);
    const g = byKey.get(key);
    if (g) g.items.push(it);
    else {
      const n = { key, items: [it] };
      byKey.set(key, n);
      out.push(n);
    }
  }
  return out;
}

/** "14:02" in the zone. */
export function clockKo(value: string | Date, timeZone?: string): string {
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return "—";
  return dtf("clock", timeZone, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);
}

/**
 * Short time for a row: "방금 전" / "12분 전" / "3시간 전" — only when the event is on today's date in the zone, so a
 * row under the "어제" header never reads "10분 전"; otherwise the clock "23:55" (the day is in the group header).
 */
export function relativeTimeKo(value: string | Date, now: number = Date.now(), timeZone?: string): string {
  const d = toDate(value);
  const t = d.getTime();
  if (Number.isNaN(t)) return "—";
  if (dayKey(d, timeZone) !== dayKey(new Date(now), timeZone)) return clockKo(d, timeZone);
  const diff = now - t;
  if (diff < 60_000) return "방금 전";
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min}분 전`;
  return `${Math.floor(min / 60)}시간 전`;
}

/** Full timestamp for tooltips: "2026년 11월 6일 (금) 14:02:33". */
export function exactTimeKo(value: string | Date, timeZone?: string): string {
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return "—";
  const key = dayKey(d, timeZone);
  const [y, m, day] = key.split("-").map(Number);
  const wd = WEEKDAY[new Date(`${key}T00:00:00Z`).getUTCDay()];
  const clock = dtf("exact", timeZone, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(d);
  return `${y}년 ${m}월 ${day}일 (${wd}) ${clock}`;
}

// ── areas ───────────────────────────────────────────────────────────────────
export interface AreaGroup {
  id: string;
  label: string;
  tone: Tone;
  icon: NavIconName | null;
  /** text glyph when there is no icon */
  glyph?: string;
}

const GROUPS: Record<string, AreaGroup> = {
  plan: { id: "plan", label: "작품·기획", tone: "accent", icon: "concept" },
  manuscript: {
    id: "manuscript",
    label: "원고",
    tone: "violet",
    icon: "manuscript",
  },
  task: { id: "task", label: "작업", tone: "info", icon: "board" },
  ask: { id: "ask", label: "질문·승인", tone: "warn", icon: "inbox" },
  lore: { id: "lore", label: "세계관 자료", tone: "ok", icon: "ontology" },
  setup: { id: "setup", label: "떡밥", tone: "ok", icon: "foreshadow" },
  cast: { id: "cast", label: "캐릭터", tone: "violet", icon: "cast" },
  image: { id: "image", label: "이미지", tone: "violet", icon: "image" },
  budget: {
    id: "budget",
    label: "예산",
    tone: "danger",
    icon: null,
    // amounts are USD (formatUsd)
    glyph: "$",
  },
  system: { id: "system", label: "시스템", tone: "neutral", icon: "gear" },
};

const AREA_GROUP: Record<string, keyof typeof GROUPS> = {
  novel: "plan",
  goal: "plan",
  concept_session: "plan",
  concept_brief: "plan",
  series_bible: "plan",
  arc: "plan",
  structure: "plan",
  episode: "manuscript",
  manuscript: "manuscript",
  scene: "manuscript",
  export: "manuscript",
  task: "task",
  run: "task",
  question: "ask",
  answer: "ask",
  answer_reflection: "ask",
  approval: "ask",
  fact: "lore",
  entity: "lore",
  entity_name: "lore",
  mention: "lore",
  identity: "lore",
  schema: "lore",
  glossary: "lore",
  timeline: "lore",
  continuity_issue: "lore",
  setup: "setup",
  character: "cast",
  cast: "cast",
  design_sheet: "cast",
  image: "image",
  budget: "budget",
  cost: "budget",
};

export function actionArea(action: string): string {
  const dot = action.indexOf(".");
  return dot < 0 ? action : action.slice(0, dot);
}

export function areaGroupOf(action: string): AreaGroup {
  return GROUPS[AREA_GROUP[actionArea(action)] ?? "system"]!;
}

// ── actor ───────────────────────────────────────────────────────────────────
export interface ActorView {
  /** sentence subject, e.g. "작가 에이전트" / "나" / "스케줄러" */
  name: string;
  /** chip text */
  label: string;
  /** "에이전트" / "사용자" / "시스템" — kind shown next to the chip */
  kind: string;
  /** avatar initials */
  initials: string;
  tone: Tone;
  isMe: boolean;
}

export function actorView(a: { actorType: string; actorId: string }, me?: { id: string; displayName: string } | null): ActorView {
  if (a.actorType === "user") {
    const isMe = !!me && me.id === a.actorId;
    return {
      name: isMe ? "나" : "사용자",
      label: isMe ? `나 (${me!.displayName})` : "사용자",
      kind: "사용자",
      initials: isMe ? "나" : "사",
      tone: "warn",
      isMe,
    };
  }
  if (a.actorType === "agent") {
    const role = safeLabel("agent_role", a.actorId);
    return {
      name: `${role} 에이전트`,
      label: role,
      kind: "에이전트",
      initials: role.slice(0, 1) || "AI",
      tone: "info",
      isMe: false,
    };
  }
  if (a.actorType === "system") {
    const c = safeLabel("system_component", a.actorId);
    return {
      name: c,
      label: c,
      kind: "시스템",
      initials: "시",
      tone: "neutral",
      isMe: false,
    };
  }
  return {
    name: a.actorId,
    label: a.actorId,
    kind: a.actorType,
    initials: "·",
    tone: "neutral",
    isMe: false,
  };
}

// ── Korean particles ─────────────────────────────────────────────────────────
/** true/false when the last char decides 받침, null when unknown (latin, symbols). */
function hasBatchim(word: string): boolean | null {
  const s = word.replace(/[\s)\]’'"」』.…]+$/u, "");
  const ch = s.charCodeAt(s.length - 1);
  if (ch >= 0xac00 && ch <= 0xd7a3) return (ch - 0xac00) % 28 !== 0;
  const c = s.slice(-1);
  if (/[0-9]/.test(c)) return "013678".includes(c);
  return null;
}

/** Attach 이/가, 을/를, 은/는, 와/과 to a word (unknown final → "이(가)" style). */
export function josa(word: string, pair: "이가" | "을를" | "은는" | "와과"): string {
  if (pair === "이가" && word === "나") return "내가";
  const [withB, withoutB] = pair === "이가" ? ["이", "가"] : pair === "을를" ? ["을", "를"] : pair === "은는" ? ["은", "는"] : ["과", "와"];
  const b = hasBatchim(word);
  if (b === null) return `${word}${withB}(${withoutB})`;
  return `${word}${b ? withB : withoutB}`;
}

// ── sentence ────────────────────────────────────────────────────────────────
export type SentencePart = { kind: "actor"; text: string } | { kind: "target"; text: string } | { kind: "text"; text: string };

/**
 * Predicate templates by verb. `{T}` target, `{T을}` / `{T이}` target + particle.
 * Verbs not listed fall back to `{T을} <동작>했습니다` / `{T}의 <동작>`.
 */
const PREDICATE: Record<string, string> = {
  created: "{T을} 만들었습니다",
  updated: "{T을} 수정했습니다",
  deleted: "{T을} 삭제했습니다",
  status_changed: "{T}의 상태를 바꿨습니다",
  settings_changed: "{T}의 설정을 바꿨습니다",
  autonomy_changed: "{T}의 자율 단계를 바꿨습니다",
  stage_changed: "{T}의 단계를 바꿨습니다",
  entry_mode_changed: "{T}의 진입 방식을 바꿨습니다",
  limit_extended: "{T}의 한도를 늘렸습니다",
  paused: "{T을} 일시정지했습니다",
  resumed: "{T을} 다시 시작했습니다",
  version_created: "{T}의 새 버전을 만들었습니다",
  field_edited: "{T}의 항목을 고쳤습니다",
  change_proposal_decided: "{T}의 변경 제안을 결정했습니다",
  human_edited: "{T을} 직접 고쳤습니다",
  rhythm_candidate_created: "{T}의 문체 다듬기 후보를 만들었습니다",
  rhythm_candidate_decided: "{T}의 문체 다듬기 후보를 정리했습니다",
  rhythm_no_change: "{T}의 문체 다듬기에서 고칠 수 있는 문단을 찾지 못했습니다",
  resegmented: "{T}의 씬 경계를 다시 나눴습니다",
  reordered: "{T}의 순서를 바꿨습니다",
  approved: "{T을} 승인했습니다",
  rejected: "{T을} 반려했습니다",
  published: "{T을} 공개했습니다",
  unpublished: "{T}의 공개를 취소했습니다",
  blocked: "{T을} 막았습니다",
  unblocked: "{T}의 차단을 풀었습니다",
  lease_acquired: "{T을} 맡았습니다",
  lease_reclaimed: "{T}의 점유를 회수했습니다",
  cancelled: "{T을} 취소했습니다",
  reassigned: "{T을} 다시 배정했습니다",
  queued: "{T을} 대기열에 올렸습니다",
  started: "{T을} 시작했습니다",
  finished: "{T을} 마쳤습니다",
  interrupted: "{T을} 중단했습니다",
  sent: "{T을} 보냈습니다",
  reminded: "{T을} 다시 알렸습니다",
  answered: "{T}에 답했습니다",
  defaulted: "{T}에 기본값을 적용했습니다",
  resolved: "{T을} 해결했습니다",
  regraded: "{T}의 등급을 다시 매겼습니다",
  late_answer_received: "{T}에 대한 늦은 답변을 받았습니다",
  late_answer_resolved: "{T}의 늦은 답변을 처리했습니다",
  interpreted: "{T을} 해석했습니다",
  interpretation_decided: "{T}의 해석을 확정했습니다",
  recorded: "{T을} 기록했습니다",
  notified: "{T을} 알렸습니다",
  requested: "{T을} 요청했습니다",
  decided: "{T을} 결정했습니다",
  superseded: "{T을} 새 요청으로 대체했습니다",
  binding_issued: "{T}의 연결 토큰을 발급했습니다",
  bound: "{T을} 연결했습니다",
  unbound: "{T}의 연결을 해제했습니다",
  health_changed: "{T}의 연결 상태가 바뀌었다고 기록했습니다",
  unauthorized_input: "{T}에서 허용되지 않은 입력을 받았습니다",
  command_received: "{T}에서 명령을 받았습니다",
  policy_changed: "{T}의 정책을 바꿨습니다",
  warning_reached: "{T}의 경고 기준 도달을 알렸습니다",
  hard_stop_reached: "{T}의 강제 중지 한도 도달로 작업을 멈췄습니다",
  overrun_recorded: "{T}의 한도 초과를 기록했습니다",
  unknown_recorded: "{T}에 금액 미상 비용을 기록했습니다",
  restored_carryover: "{T}의 이월분을 복원했습니다",
  retconned: "{T을} 레트콘으로 바꿨습니다",
  reverted: "{T을} 되돌렸습니다",
  preferred_name_changed: "{T}의 대표명을 바꿨습니다",
  added: "{T을} 추가했습니다",
  retired: "{T을} 폐기했습니다",
  batch_linked: "{T을} 일괄 연결했습니다",
  link_decided: "{T}의 연결을 결정했습니다",
  relinked: "{T을} 다시 연결했습니다",
  proposed: "{T을} 제안했습니다",
  applied: "{T을} 적용했습니다",
  change_proposed: "{T} 변경을 제안했습니다",
  change_decided: "{T} 변경을 결정했습니다",
  version_published: "{T}의 새 버전을 게시했습니다",
  term_created: "{T}에 용어를 추가했습니다",
  term_updated: "{T}의 용어를 고쳤습니다",
  narrative_status_changed: "{T}의 서사 상태를 바꿨습니다",
  canon_status_changed: "{T}의 캐논 상태를 바꿨습니다",
  due_changed: "{T}의 회수 기한을 바꿨습니다",
  beat_planned: "{T}의 비트를 계획했습니다",
  beat_detected: "{T}의 비트를 원고에서 찾았습니다",
  beat_missing: "{T}의 비트가 빠졌다고 표시했습니다",
  beat_confirmed: "{T}의 비트를 확정했습니다",
  abandoned: "{T을} 포기했습니다",
  opened: "{T을} 열었습니다",
  waived: "{T을} 면제했습니다",
  changed: "{T을} 바꿨습니다",
  set: "{T을} 설정했습니다",
  completed: "{T을} 완료했습니다",
  failed: "{T} 실패를 기록했습니다",
  restored: "{T을} 복원했습니다",
  migration_applied: "{T}에 마이그레이션을 적용했습니다",
  health_check_failed: "{T}의 연결 점검 실패를 기록했습니다",
  confirmed: "{T을} 확정했습니다",
  draft_requested: "{T}의 AI 초안을 요청했습니다",
  draft_applied: "{T}에 AI 초안을 반영했습니다",
  image_requested: "{T}의 이미지 생성을 요청했습니다",
  image_selected: "{T}의 대표 이미지를 골랐습니다",
  plan_flagged: "{T}의 계획에 점검 표시를 남겼습니다",
  plan_flags_cleared: "{T}의 계획 점검 표시를 지웠습니다",
  plot_characters_proposed: "{T}에 플롯 인물을 제안했습니다",
  plot_characters_confirmed: "{T}의 플롯 인물을 확정했습니다",
  first_appearance_set: "{T}의 첫 등장을 지정했습니다",
};

/** Area-specific target noun when the ref type alone is vague (e.g. `manuscript.*` targets an episode → "3화 원고"). */
const AREA_TARGET_SUFFIX: Record<string, string> = {
  manuscript: "원고",
  cast: "캐스트",
  design_sheet: "디자인 시트",
};

/**
 * Many areas record the novel itself as the target (`structure.*`, `export.created`, `character.reordered`, …).
 * "작품" alone would misstate what changed, so name the thing: "작품 전체 구성", "작품 내보내기 파일".
 */
const NOVEL_TARGET_NOUN: Record<string, string> = {
  structure: "전체 구성",
  export: "내보내기 파일",
  character: "캐릭터",
  cast: "캐스트",
  settings: "설정",
  budget: "예산",
  cost: "비용",
};

/** Areas whose events target a generic record type better named by the area (`image.*` → media_asset). */
const AREA_TARGET_BASE: Record<string, string> = {
  image: "이미지",
};

/** Whole-action templates where the verb-level one reads wrong for that area. */
const ACTION_PREDICATE: Record<string, string> = {
  "image.requested": "{T} 생성을 요청했습니다",
  "image.completed": "{T} 생성을 마쳤습니다",
  "image.failed": "{T} 생성에 실패했다고 기록했습니다",
};

export interface TargetInfo {
  type: string;
  /** episode number when the target is an episode */
  episodeNo?: number;
  /** human name / title of the target when known (from before/after) */
  name?: string;
  /** bulk event size */
  count?: number;
}

/** "3화" / "작업 ‘아웃라인 작성’" / "엔티티" / "언급 12건". */
export function targetTextKo(action: string, t: TargetInfo): string {
  const area = actionArea(action);
  if (t.type === "novel" && area !== "novel") {
    // the novel is only the container here; a bulk count (e.g. exported episodes, reordered characters) does not
    // count novels, so it is left to 자세히
    const noun = NOVEL_TARGET_NOUN[area] ?? actionAreaKo(area);
    return noun === refTypeKo("novel") ? noun : `작품 ${noun}`;
  }
  let base =
    AREA_TARGET_BASE[area] ?? (t.type === "episode" ? (t.episodeNo !== undefined ? `${t.episodeNo}화` : "회차") : refTypeKo(t.type));
  if (t.name) base = `${base} ‘${t.name}’`;
  const suffix = AREA_TARGET_SUFFIX[area];
  if (suffix && !base.includes(suffix) && refTypeKo(t.type) !== suffix) base = `${base} ${suffix}`;
  if (t.count !== undefined && t.count > 1) base = `${base} ${t.count}건`;
  return base;
}

/** Best-effort display name of the target from before/after payloads (title / name / displayName). */
export function targetNameOf(before: unknown, after: unknown): string | undefined {
  for (const v of [after, before]) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const o = v as Record<string, unknown>;
    for (const k of ["title", "name", "displayName", "term"]) {
      const s = o[k];
      if (typeof s === "string" && s.trim()) {
        const t = s.trim();
        return t.length > 24 ? `${t.slice(0, 24)}…` : t;
      }
    }
  }
  return undefined;
}

/**
 * One Korean sentence as parts, e.g.
 * `[actor "작가 에이전트"] "가 " [target "3화 원고"] "를 직접 고쳤습니다"`.
 */
export function buildSentence(action: string, actorName: string, target: string): SentencePart[] {
  const verb = action.slice(action.indexOf(".") + 1);
  const tpl = ACTION_PREDICATE[action] ?? PREDICATE[verb] ?? `{T}에서 ‘${verbKo(verb)}’ 동작을 기록했습니다`;
  const isMe = actorName === "나";
  const parts: SentencePart[] = [
    { kind: "actor", text: isMe ? "내가" : actorName },
    {
      kind: "text",
      text: `${isMe ? "" : josa(actorName, "이가").slice(actorName.length)} `,
    },
  ];
  const m = /\{T(을|이)?\}/.exec(tpl);
  if (!m) {
    parts.push({ kind: "text", text: tpl });
    return parts;
  }
  const pre = tpl.slice(0, m.index);
  const post = tpl.slice(m.index + m[0].length);
  if (pre) parts.push({ kind: "text", text: pre });
  parts.push({ kind: "target", text: target });
  const particle = m[1] ? josa(target, m[1] === "을" ? "을를" : "이가").slice(target.length) : "";
  parts.push({ kind: "text", text: `${particle}${post}` });
  return parts;
}

export function sentenceText(parts: readonly SentencePart[]): string {
  return parts.map((p) => p.text).join("");
}

/**
 * Area name for filter chips / options. `episode` reads "회차" here — the row label "화 · 상태 변경" stays as is, but a
 * lone "화" chip next to "원고" was unclear.
 */
export function areaLabelKo(area: string): string {
  return area === "episode" ? "회차" : actionAreaKo(area);
}
