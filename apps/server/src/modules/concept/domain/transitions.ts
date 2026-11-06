/**
 * State machines owned by `concept` (design/11 §5.2 CS1–CS9, §5.4 CB1–CB8; 03 §4.12–4.13). Pure, no I/O.
 * "표에 없는 전이는 거부합니다" — every status change goes through these tables.
 */
import type { ConceptBriefStatus, ConceptSessionStatus, ConceptStage } from "@ncs/shared";
import { InvalidTransitionError } from "../../../platform/errors.js";

export interface ConceptTransitionRule<S extends string> {
  id: string;
  from: readonly S[];
  to: S;
  trigger: string;
}

/** CS1 is creation (no `from`); CS2 is a stage move inside `active` (see STAGE_TRANSITIONS). */
export const SESSION_TRANSITIONS: readonly ConceptTransitionRule<ConceptSessionStatus>[] = [
  { id: "CS3", from: ["active"], to: "awaiting_approval", trigger: "사용자 승인 요청 + 점검 통과" },
  { id: "CS4", from: ["awaiting_approval"], to: "approved", trigger: "브리프 승인(A2)" },
  { id: "CS5", from: ["awaiting_approval"], to: "active", trigger: "브리프 반려(A3)" },
  { id: "CS6", from: ["active"], to: "paused", trigger: "나중에 / 휴면 / 세션 비용 상한" },
  { id: "CS7", from: ["paused"], to: "active", trigger: "이어 하기 / 상한 상향 / 폼으로 마저 입력" },
  { id: "CS8", from: ["active", "paused", "awaiting_approval"], to: "abandoned", trigger: "처음부터 다시 / 작품 보관" },
  { id: "CS9", from: ["awaiting_approval"], to: "active", trigger: "사용자가 대화를 이어 감(승인 요청 취소)" },
];

export const BRIEF_TRANSITIONS: readonly ConceptTransitionRule<ConceptBriefStatus>[] = [
  { id: "CB2", from: ["awaiting_approval"], to: "approved", trigger: "승인(A2), 승인된 기획서 없음" },
  { id: "CB3", from: ["awaiting_approval"], to: "rejected", trigger: "반려(A3)" },
  { id: "CB4", from: ["awaiting_approval"], to: "rejected", trigger: "승인 취소(CS8·CS9)" },
  { id: "CB5", from: ["approved"], to: "superseded", trigger: "새 버전 CB2 또는 CB7" },
  { id: "CB6", from: ["awaiting_approval"], to: "approved_direction", trigger: "승인(A2), 승인된 기획서 있음(MVP-β)" },
  { id: "CB7", from: ["approved_direction"], to: "approved", trigger: "기획서 개정 승인(MVP-β)" },
  { id: "CB8", from: ["approved_direction"], to: "rejected", trigger: "기획서 개정 반려·취소(MVP-β)" },
];

export const STAGE_ORDER: readonly ConceptStage[] = ["opening", "diverging", "converging", "confirming"];

/** CS2: forward moves by the deterministic rules (3.2) and backward moves (rejection → converging, R5 jumps). */
export const STAGE_TRANSITIONS: readonly ConceptTransitionRule<ConceptStage>[] = [
  { id: "CS2-a", from: ["opening"], to: "diverging", trigger: "씨앗 발화 1회 이상" },
  { id: "CS2-b", from: ["opening", "diverging"], to: "converging", trigger: "발산 필수 슬롯 확정 / 가져오기 완료" },
  { id: "CS2-c", from: ["opening", "diverging", "converging"], to: "confirming", trigger: "사용자 선택(R8): 이대로 정리 / 전부 맡기기 / 확인 단계로" },
  { id: "CS2-d", from: ["confirming", "diverging"], to: "converging", trigger: "반려 사유 반영 / 확인 단계에서 되돌아감" },
  { id: "CS2-e", from: ["converging", "confirming"], to: "diverging", trigger: "상위 필드 변경으로 발산 필수 재확인" },
];

function find<S extends string>(table: readonly ConceptTransitionRule<S>[], aggregate: string, from: S, to: S, id?: string) {
  const rule = table.find((r) => r.to === to && r.from.includes(from) && (!id || r.id === id));
  if (!rule) throw new InvalidTransitionError(aggregate, from, to);
  return rule;
}

export const assertSessionTransition = (from: ConceptSessionStatus, to: ConceptSessionStatus, id?: string) =>
  find(SESSION_TRANSITIONS, "concept_session", from, to, id);
export const assertBriefTransition = (from: ConceptBriefStatus, to: ConceptBriefStatus, id?: string) =>
  find(BRIEF_TRANSITIONS, "concept_brief", from, to, id);
export const assertStageTransition = (from: ConceptStage, to: ConceptStage) => find(STAGE_TRANSITIONS, "concept_stage", from, to);

/** "open" sessions for INV-CON-01 (partial unique index concept_sessions_one_open). */
export const OPEN_SESSION_STATUSES: readonly ConceptSessionStatus[] = ["active", "awaiting_approval", "paused"];
