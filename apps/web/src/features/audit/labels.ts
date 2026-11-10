/**
 * Display helpers for audit rows and actor pairs (08 §9.7, 03 §6.1/§6.3).
 * Action names stay raw in the API; the UI shows "<영역> · <동작>" in Korean.
 */
import { formatUsd, labelKo, type EnumName } from "@ncs/shared";

const AREA_KO: Record<string, string> = {
  novel: "작품",
  goal: "목표",
  concept_session: "컨셉 세션",
  concept_brief: "컨셉 브리프",
  series_bible: "기획서",
  arc: "플롯",
  episode: "화",
  manuscript: "원고",
  scene: "씬",
  task: "작업",
  run: "실행",
  question: "질문",
  answer: "답변",
  answer_reflection: "답변 반영",
  approval: "승인",
  channel: "채널",
  budget: "예산",
  cost: "비용",
  fact: "사실",
  entity: "엔티티",
  entity_name: "이름",
  mention: "언급",
  identity: "동일성",
  schema: "온톨로지 스키마",
  glossary: "용어집",
  timeline: "시간선",
  setup: "떡밥",
  continuity_issue: "연속성 이슈",
  settings: "설정",
  secret: "비밀",
  provider_profile: "제공자 프로필",
  model_binding: "모델 연결",
  backup: "백업",
  system: "시스템",
  export: "내보내기",
  image: "이미지 생성",
  character: "캐릭터",
  cast: "캐스트",
  design_sheet: "디자인 시트",
  structure: "전체 구성",
  autopilot: "완전 자율",
};

const VERB_KO: Record<string, string> = {
  created: "생성",
  reordered: "순서 변경",
  draft_requested: "AI 초안 요청",
  draft_applied: "AI 초안 반영",
  confirmed: "확정",
  image_requested: "이미지 생성 요청",
  image_selected: "대표 이미지 지정",
  settings_changed: "설정 변경",
  autonomy_changed: "자율 단계 변경",
  paused: "일시정지",
  resumed: "재개",
  status_changed: "상태 변경",
  deleted: "삭제",
  updated: "수정",
  stage_changed: "단계 변경",
  limit_extended: "한도 연장",
  entry_mode_changed: "진입 방식 변경",
  version_created: "새 버전",
  field_edited: "항목 수정",
  change_proposal_decided: "변경 제안 결정",
  rejected: "반려",
  approved: "승인",
  published: "공개",
  unpublished: "공개 취소",
  blocked: "차단",
  unblocked: "차단 해제",
  human_edited: "사람 수정",
  rhythm_candidate_created: "문체 다듬기 후보",
  rhythm_candidate_decided: "문체 다듬기 결정",
  rhythm_no_change: "문체 다듬기 변경 없음",
  resegmented: "씬 경계 재계산",
  lease_acquired: "임대 획득",
  lease_reclaimed: "임대 회수",
  cancelled: "취소",
  reassigned: "재배정",
  queued: "대기열 등록",
  started: "시작",
  finished: "종료",
  interrupted: "중단",
  sent: "발송",
  reminded: "재알림",
  answered: "답변",
  defaulted: "기본값 적용",
  resolved: "해결",
  late_answer_received: "늦은 답변 수신",
  late_answer_resolved: "늦은 답변 처리",
  interpreted: "해석",
  interpretation_decided: "해석 결정",
  recorded: "기록",
  notified: "알림",
  requested: "요청",
  decided: "결정",
  superseded: "대체",
  binding_issued: "연결 토큰 발급",
  bound: "연결",
  unbound: "연결 해제",
  health_changed: "상태 변화",
  unauthorized_input: "미인가 입력",
  command_received: "명령 수신",
  policy_changed: "정책 변경",
  warning_reached: "경고 도달",
  hard_stop_reached: "강제 중지 도달",
  overrun_recorded: "초과 기록",
  unknown_recorded: "미상 비용 기록",
  restored_carryover: "이월 복원",
  retconned: "설정 변경(레트콘)",
  reverted: "되돌림",
  preferred_name_changed: "대표명 변경",
  added: "추가",
  retired: "폐기",
  batch_linked: "일괄 연결",
  link_decided: "연결 결정",
  relinked: "재연결",
  proposed: "제안",
  applied: "적용",
  change_proposed: "변경 제안",
  change_decided: "변경 결정",
  version_published: "버전 게시",
  term_created: "용어 생성",
  term_updated: "용어 수정",
  narrative_status_changed: "서사 상태 변경",
  canon_status_changed: "캐논 상태 변경",
  due_changed: "기한 변경",
  beat_planned: "비트 계획",
  beat_detected: "비트 감지",
  beat_missing: "비트 누락",
  beat_confirmed: "비트 확정",
  abandoned: "포기",
  opened: "열림",
  waived: "면제",
  changed: "변경",
  set: "설정",
  completed: "완료",
  enabled: "켬",
  disabled: "끔",
  halted: "멈춤",
  approval_decided: "자동 승인",
  question_answered: "자동 응답",
  step: "자동 진행",
  gate_hit: "사람 확인 필요",
  throttled: "하루 상한 도달",
  publish_scheduled: "예약 공개 지정",
  failed: "실패",
  restored: "복원",
  migration_applied: "마이그레이션 적용",
  health_check_failed: "상태 점검 실패",
  regraded: "등급 재조정",
  plan_flagged: "계획 점검 표시",
  plan_flags_cleared: "계획 점검 표시 해제",
  plot_characters_proposed: "플롯 인물 제안",
  plot_characters_confirmed: "플롯 인물 확정",
  first_appearance_set: "첫 등장 지정",
};

export function actionAreaKo(area: string): string {
  return AREA_KO[area] ?? area;
}

export function verbKo(verb: string): string {
  return VERB_KO[verb] ?? verb.replace(/_/g, " ");
}

export function actionLabelKo(action: string): string {
  const dot = action.indexOf(".");
  if (dot < 0) return action;
  const area = action.slice(0, dot);
  const verb = action.slice(dot + 1);
  return `${AREA_KO[area] ?? area} · ${VERB_KO[verb] ?? verb.replace(/_/g, " ")}`;
}

const REF_TYPE_KO: Record<string, string> = {
  novel: "작품",
  goal: "목표",
  series_bible: "기획서",
  arc: "플롯",
  episode: "화",
  manuscript_version: "원고 버전",
  scene: "씬",
  shot: "샷",
  task: "작업",
  run: "실행",
  question: "질문",
  answer: "답변",
  approval: "승인",
  channel: "채널",
  budget_policy: "예산 정책",
  cost_event: "비용 기록",
  continuity_issue: "연속성 이슈",
  setup: "떡밥",
  setup_beat: "떡밥 비트",
  entity: "엔티티",
  entity_name: "이름",
  mention: "언급",
  fact: "사실",
  timeline: "시간선",
  schema_proposal: "스키마 제안",
  structure: "전체 구성",
  export: "내보내기",
};

/** Korean label for a `ref_type`; prefers shared labels when present. */
export function refTypeKo(type: string): string {
  const shared = safeLabel("ref_type", type);
  return shared !== type ? shared : (REF_TYPE_KO[type] ?? type);
}

export function safeLabel(name: string, value: string): string {
  try {
    return labelKo(name as EnumName, value);
  } catch {
    return value;
  }
}

export interface ActorLike {
  actorType: string;
  actorId: string;
}

/** "사람(민준)" / "writer → 작가" / "스케줄러" (03 §3.1 display_name; ids are never shown raw for agents/system). */
export function actorLabelKo(actor: ActorLike, me?: { id: string; displayName: string } | null): string {
  if (actor.actorType === "user") return me && me.id === actor.actorId ? `사람 · ${me.displayName}` : "사람";
  if (actor.actorType === "agent") return safeLabel("agent_role", actor.actorId);
  if (actor.actorType === "system") return safeLabel("system_component", actor.actorId);
  return actor.actorId;
}

/** One-letter gutter mark so authorship is not conveyed by colour alone (08 §9.9). */
export function actorGlyph(actorType: string): string {
  if (actorType === "user") return "사";
  if (actorType === "agent") return "AI";
  if (actorType === "system") return "시";
  return "·";
}

// ── before/after diff display (review3 visual #9) ──────────────────────────
const FIELD_KO: Record<string, string> = {
  status: "상태",
  stopReason: "종료 사유",
  errorFamily: "오류 종류",
  errorMessage: "오류 내용",
  kind: "종류",
  agentRole: "역할",
  role: "역할",
  name: "이름",
  title: "제목",
  canonStatus: "캐논 상태",
  provider: "공급자",
  modelId: "모델",
  view: "시점",
  assetId: "이미지",
  generationId: "이미지 생성",
  proposed: "AI 제안",
  fields: "항목",
  count: "개수",
  priority: "우선순위",
  attempt: "시도",
  versionNo: "버전",
  preferredNameId: "대표명",
  enabled: "사용",
  linkStatus: "연결 상태",
  narrativeStatus: "서사 상태",
  amountMicros: "금액",
  age: "나이",
  gender: "성별",
  personality: "성격",
  autonomyLevel: "자율 단계",
  questionThreshold: "질문 빈도",
  ageRating: "연령 등급",
  pauseReason: "멈춤 사유",
  titleSource: "제목 출처",
  limitMicros: "한도",
  targetEpisodes: "목표 화수",
  cadence: "연재 주기",
  purpose: "목적",
  entryMode: "진입 방식",
};
/** enums tried (in order) for the value of a known field */
const FIELD_ENUMS: Record<string, EnumName[]> = {
  status: ["task_status", "run_status", "episode_status", "character_status", "question_status", "approval_status", "entity_status", "image_generation_status"],
  stopReason: ["run_stop_reason"],
  errorFamily: ["error_family"],
  kind: ["task_kind"],
  agentRole: ["agent_role"],
  role: ["character_role", "agent_role"],
  canonStatus: ["canon_status"],
  autonomyLevel: ["autonomy_level"],
  questionThreshold: ["question_threshold"],
  ageRating: ["age_rating"],
  pauseReason: ["pause_reason", "concept_pause_reason"],
  titleSource: ["novel_title_source"],
  purpose: ["concept_session_purpose"],
  entryMode: ["concept_entry_mode"],
};
/** status enum matching the event's target type — tried before the generic list (an issue's `open` ≠ 답변 대기) */
const STATUS_ENUM_BY_TARGET: Record<string, EnumName> = {
  novel: "novel_status",
  series_bible: "series_bible_status",
  arc: "arc_status",
  concept_session: "concept_session_status",
  concept_brief: "concept_brief_status",
  episode: "episode_status",
  task: "task_status",
  run: "run_status",
  question: "question_status",
  approval: "approval_status",
  channel: "channel_status",
  budget_policy: "budget_status",
  continuity_issue: "continuity_issue_status",
  setup: "setup_narrative_status",
  setup_beat: "setup_beat_status",
  entity: "entity_status",
  entity_name: "entity_name_status",
  character: "character_status",
};
const MONEY_FIELDS = new Set(["amountMicros", "limitMicros", "warnMicros", "spentMicros"]);
/** values without a shared Korean label (run_stop_reason is not in labels.ko) */
const VALUE_KO: Record<string, Record<string, string>> = {
  stopReason: {
    completed: "완료",
    paused: "일시정지",
    cancelled_by_user: "사용자 취소",
    budget_blocked: "예산 한도",
    awaiting_human: "사람 응답 대기",
    lease_lost: "작업 점유 끊김",
    error: "오류",
    superseded: "새 작업으로 대체",
  },
};
const ID_RE = /^([a-z]{2,4})_([0-9A-HJKMNP-TV-Z]{16,})$/;

/** `mnv_01J…XYZ` → `mnv_…WXYZ` (full id stays in the tooltip) */
export function shortId(v: string): string {
  const m = ID_RE.exec(v);
  return m ? `${m[1]}_…${m[2]!.slice(-4)}` : v;
}

export function fieldLabelKo(key: string): string {
  return FIELD_KO[key] ?? key;
}

export function fieldValueKo(key: string, raw: string, targetType?: string): string {
  if (raw === "—" || raw === "없음") return raw;
  const local = VALUE_KO[key]?.[raw];
  if (local) return local;
  if (MONEY_FIELDS.has(key) && /^-?\d+$/.test(raw)) return formatUsd(Number(raw));
  const byTarget = key === "status" && targetType ? STATUS_ENUM_BY_TARGET[targetType] : undefined;
  for (const e of byTarget ? [byTarget, ...(FIELD_ENUMS[key] ?? [])] : (FIELD_ENUMS[key] ?? [])) {
    const l = safeLabel(e, raw);
    if (l !== raw) return l;
  }
  if (raw === "true") return "예";
  if (raw === "false") return "아니요";
  return raw
    .split(", ")
    .map((p) => shortId(p))
    .join(", ");
}

/** display rows of a summarizeChange() result: Korean field / value labels, empty→empty pairs dropped */
export function displayChanges(changes: Array<{ key: string; from: string; to: string }>, targetType?: string): Array<{ key: string; label: string; from: string; to: string; fromRaw: string; toRaw: string }> {
  const empty = (v: string) => v === "—" || v === "없음" || v === "";
  return changes
    .filter((c) => !(empty(c.from) && empty(c.to)))
    .map((c) => ({ key: c.key, label: c.key ? fieldLabelKo(c.key) : "", from: fieldValueKo(c.key, c.from, targetType), to: fieldValueKo(c.key, c.to, targetType), fromRaw: c.from, toRaw: c.to }));
}
