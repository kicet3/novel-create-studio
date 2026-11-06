/**
 * State machines owned by `hitl` (03 §4.4 Q1–Q8, §4.5 A1–A5; 05 §5.2 DG1–DG3, §6.3 AS1–AS4,
 * §6.5 AN1–AN3, §7.2 IT1–IT6, §8.3 RF1–RF3, §9.5 QD1–QD6). Pure; tables are the only source of truth.
 */
import type {
  AnswerSessionStatus,
  ApprovalStatus,
  DigestStatus,
  InterpretationStatus,
  LateAnswerResolution,
  QuestionDeliveryState,
  QuestionGrade,
  QuestionStatus,
  ReflectionStatus,
  ResolutionSource,
} from "@ncs/shared";
import { DomainValidationError, InvalidTransitionError } from "../../../platform/errors.js";

export interface Rule<S extends string> {
  id: string;
  from: readonly S[];
  to: S;
  trigger: string;
}

export const QUESTION_TRANSITIONS: readonly Rule<QuestionStatus>[] = [
  { id: "Q2", from: ["pending"], to: "open", trigger: "발송(웹 게시 포함) / 웹 '지금 답하기'" },
  { id: "Q3", from: ["open"], to: "answered", trigger: "첫 유효 답변 채택(CAS)" },
  { id: "Q4", from: ["open"], to: "defaulted", trigger: "비차단형 마감 경과" },
  { id: "Q6", from: ["answered", "defaulted"], to: "resolved", trigger: "반영 기록 완료" },
  { id: "Q7", from: ["open"], to: "resolved", trigger: "정보성 전달 완료" },
  { id: "Q8", from: ["pending", "open"], to: "cancelled", trigger: "대상 소멸·질문 무효·병합" },
];

export const APPROVAL_TRANSITIONS: readonly Rule<ApprovalStatus>[] = [
  { id: "A2", from: ["pending"], to: "approved", trigger: "질문 답 '승인'" },
  { id: "A3", from: ["pending"], to: "rejected", trigger: "질문 답 '반려'" },
  { id: "A4", from: ["pending"], to: "cancelled", trigger: "대상 소멸, 요청 취소" },
  { id: "A5", from: ["pending"], to: "superseded", trigger: "같은 대상의 새 요청" },
];

export const DELIVERY_TRANSITIONS: readonly Rule<QuestionDeliveryState>[] = [
  { id: "QD2", from: ["pending"], to: "posted", trigger: "웹 즉시 / 메신저 OB3" },
  { id: "QD3", from: ["posted", "pending"], to: "answered_here", trigger: "이 채널 답 채택" },
  { id: "QD4", from: ["posted"], to: "closed_elsewhere", trigger: "다른 채널 답 채택·마감 적용" },
  { id: "QD5", from: ["pending"], to: "failed", trigger: "OB6 / OB7(채널 장애)" },
  { id: "QD6", from: ["pending", "posted"], to: "withdrawn", trigger: "질문 취소" },
];

export const SESSION_TRANSITIONS: readonly Rule<AnswerSessionStatus>[] = [
  { id: "AS2", from: ["active"], to: "completed", trigger: "마지막 단계 입력 → acceptAnswer" },
  { id: "AS3", from: ["active"], to: "expired", trigger: "expires_at 경과" },
  { id: "AS4", from: ["active"], to: "cancelled", trigger: "질문이 다른 경로로 닫힘 / 새 세션" },
];

export const DIGEST_TRANSITIONS: readonly Rule<DigestStatus>[] = [
  { id: "DG2", from: ["collecting"], to: "sent", trigger: "닫기 조건 + D4·D5 통과" },
  { id: "DG3", from: ["collecting"], to: "cancelled", trigger: "항목이 모두 닫힘" },
];

export const INTERPRETATION_TRANSITIONS: readonly Rule<InterpretationStatus>[] = [
  { id: "IT2", from: ["proposed"], to: "confirmed", trigger: "T5 '맞습니다'" },
  { id: "IT3", from: ["proposed"], to: "corrected", trigger: "웹 폼 정정 저장" },
  { id: "IT4", from: ["proposed"], to: "rejected", trigger: "T6 새 해석으로 대체 / T7 취소" },
  { id: "IT6", from: ["needs_followup"], to: "rejected", trigger: "후속 답으로 새 해석 생성" },
];

export const REFLECTION_TRANSITIONS: readonly Rule<ReflectionStatus>[] = [
  { id: "RF2", from: ["pending"], to: "applied", trigger: "F6 조건 충족" },
  { id: "RF3", from: ["pending"], to: "not_applied", trigger: "대상 소멸·해석 기각·hold 마감" },
];

export const LATE_TRANSITIONS: readonly Rule<LateAnswerResolution>[] = [
  { id: "AN2", from: ["pending_user_choice"], to: "revision_task_created", trigger: "사용자 '수정 요청'" },
  { id: "AN2", from: ["pending_user_choice"], to: "retcon_question_created", trigger: "사용자 '수정 요청'(공개 화)" },
  { id: "AN2", from: ["pending_user_choice"], to: "dismissed", trigger: "사용자 '무시'" },
  { id: "AN2", from: ["pending_user_choice"], to: "applied_to_hold", trigger: "보류 항목 웹 확정" },
];

export function findRule<S extends string>(table: readonly Rule<S>[], aggregate: string, from: S, to: S): Rule<S> {
  const r = table.find((x) => x.to === to && x.from.includes(from));
  if (!r) throw new InvalidTransitionError(aggregate, from, to);
  return r;
}

export function fromStatuses<S extends string>(table: readonly Rule<S>[], to: S): S[] {
  return [...new Set(table.filter((r) => r.to === to).flatMap((r) => r.from))];
}

/**
 * Q4 guard (INV-Q-02 fail-closed, INV-Q-04, INV-Q-06): blocking questions are never defaulted;
 * hold topics / setup_abandon are never auto-applied.
 */
export function defaultResolution(grade: QuestionGrade, defaultAction: "apply" | "hold", holdTopic: boolean): Extract<ResolutionSource, "default_applied" | "deadline_hold"> {
  if (grade !== "non_blocking") throw new DomainValidationError("fail_closed", "차단형·정보성 질문은 마감이 지나도 자동으로 결정하지 않습니다.");
  return defaultAction === "apply" && !holdTopic ? "default_applied" : "deadline_hold";
}
