/**
 * State machines owned by `messaging` (05 §6.1 IN1–IN7, §9.4 OB1–OB7, §9.6 CH1–CH7 / BT1–BT4).
 * Pure: no I/O. Transitions not in a table are rejected (InvalidTransitionError → 409).
 */
import type { BindingTokenStatus, ChannelStatus, InboxStatus, OutboxStatus } from "@ncs/shared";
import { InvalidTransitionError } from "../../../platform/errors.js";

export interface Rule<S extends string> {
  id: string;
  from: readonly S[];
  to: S;
  trigger: string;
}

export const CHANNEL_TRANSITIONS: readonly Rule<ChannelStatus>[] = [
  { id: "CH2", from: ["pending_binding"], to: "active", trigger: "바인딩 완료" },
  { id: "CH3", from: ["active"], to: "degraded", trigger: "점검 fail / 연속 발송 실패 / 409" },
  { id: "CH4", from: ["degraded"], to: "active", trigger: "점검 pass" },
  { id: "CH5", from: ["active", "degraded"], to: "disconnected", trigger: "401 / 403" },
  { id: "CH6", from: ["disconnected"], to: "active", trigger: "토큰 재설정·차단 해제 후 점검 pass" },
  { id: "CH7", from: ["pending_binding", "active", "degraded", "disconnected"], to: "revoked", trigger: "사용자 연결 해제" },
];

export const BINDING_TOKEN_TRANSITIONS: readonly Rule<BindingTokenStatus>[] = [
  { id: "BT2", from: ["issued"], to: "consumed", trigger: "/start <token>" },
  { id: "BT3", from: ["issued"], to: "expired", trigger: "TTL 경과" },
  { id: "BT4", from: ["issued"], to: "revoked", trigger: "새 토큰 발급·사용자 취소" },
];

export const INBOX_TRANSITIONS: readonly Rule<InboxStatus>[] = [
  { id: "IN2", from: ["received", "retry"], to: "processing", trigger: "worker CAS" },
  { id: "IN3", from: ["processing"], to: "processed", trigger: "I6 완료" },
  { id: "IN4", from: ["received", "processing"], to: "ignored", trigger: "I3~I5 거부, unknown_question" },
  { id: "IN5", from: ["processing"], to: "retry", trigger: "일시 오류" },
  { id: "IN6", from: ["processing"], to: "failed", trigger: "상한 초과" },
  { id: "IN7", from: ["processing"], to: "retry", trigger: "재시작 회수(attempt 유지)" },
];

export const OUTBOX_TRANSITIONS: readonly Rule<OutboxStatus>[] = [
  { id: "OB2", from: ["pending", "retry"], to: "sending", trigger: "worker CAS" },
  { id: "OB3", from: ["sending"], to: "sent", trigger: "공급자 성공" },
  { id: "OB4", from: ["sending"], to: "retry", trigger: "429 / 일시 오류" },
  { id: "OB5", from: ["sending"], to: "delivery_unknown", trigger: "요청 후 결과 미확인" },
  { id: "OB6", from: ["sending"], to: "failed", trigger: "영구 오류 / 횟수 초과" },
  { id: "OB7", from: ["pending", "retry", "sending"], to: "cancelled", trigger: "대상 닫힘, 채널 해제·장애" },
];

export function findRule<S extends string>(table: readonly Rule<S>[], aggregate: string, from: S, to: S): Rule<S> {
  const r = table.find((x) => x.to === to && x.from.includes(from));
  if (!r) throw new InvalidTransitionError(aggregate, from, to);
  return r;
}

export function canTransition<S extends string>(table: readonly Rule<S>[], from: S, to: S): boolean {
  return table.some((x) => x.to === to && x.from.includes(from));
}

/** statuses a transition into `to` may come from (for CAS `WHERE status IN (…)`) */
export function fromStatuses<S extends string>(table: readonly Rule<S>[], to: S): S[] {
  return [...new Set(table.filter((r) => r.to === to).flatMap((r) => r.from))];
}

/** backoff for inbox/outbox/poller: 1s, 2s, 4s … capped */
export function backoffMs(attempt: number, maxSec = 60): number {
  return Math.min(maxSec, 2 ** Math.max(0, attempt - 1)) * 1000;
}

export const CHANNEL_DELIVERABLE: readonly ChannelStatus[] = ["active"];
