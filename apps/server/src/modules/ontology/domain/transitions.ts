/**
 * State machines owned by `ontology` (06 §3.1 EN, §3.2 NM, §3.8 MN, §3.11 ID; 03 §4.8 F). Pure, no I/O.
 * Transitions not in a table are rejected with InvalidTransitionError (409).
 */
import type { ActivityAction, CanonStatus, EntityStatus, IdentityDecisionStatus, LinkStatus } from "@ncs/shared";
import { InvalidTransitionError } from "../../../platform/errors.js";

export interface TransitionRule<S extends string> {
  id: string;
  from: readonly S[];
  to: S;
  trigger: string;
  audit: ActivityAction;
}

export const ENTITY_TRANSITIONS: readonly TransitionRule<EntityStatus>[] = [
  { id: "EN3", from: ["candidate"], to: "active", trigger: "기획서 승인 / 화 승격 게이트(동치 판정 통과) / 새 인물·다름 답변", audit: "entity.status_changed" },
  { id: "EN4", from: ["candidate"], to: "merged", trigger: "중복 확인 같음 → IdentityDecision(merge)", audit: "entity.status_changed" },
  { id: "EN5", from: ["candidate"], to: "retired", trigger: "비엔티티 판정·근거 언급 소멸 (참조 0건)", audit: "entity.status_changed" },
  { id: "EN6", from: ["active"], to: "merged", trigger: "병합 적용", audit: "entity.status_changed" },
  { id: "EN7", from: ["merged"], to: "active", trigger: "병합 되돌리기", audit: "entity.status_changed" },
  { id: "EN8", from: ["active"], to: "retired", trigger: "잘못 만든 엔티티 폐기 (참조 0건)", audit: "entity.status_changed" },
];

export type NameStatus = "proposed" | "active" | "retired";
export const NAME_TRANSITIONS: readonly TransitionRule<NameStatus>[] = [
  { id: "NM3", from: ["proposed"], to: "active", trigger: "사용자 수락 / hidden_variant 화 승인 묶음 확정", audit: "entity_name.updated" },
  { id: "NM4", from: ["proposed", "active"], to: "retired", trigger: "기각·폐기 (대표명은 다른 대표명 지정 후)", audit: "entity_name.retired" },
  // RL-2: names created from a relinked mention go back to proposed (06 §3.11 재연결)
  { id: "RL-2", from: ["active"], to: "proposed", trigger: "재연결된 언급에서 나온 이름 → 폐기 제안", audit: "entity_name.updated" },
];

export const MENTION_TRANSITIONS: readonly TransitionRule<LinkStatus>[] = [
  { id: "MN5", from: ["ambiguous", "auto_linked", "new_entity_candidate"], to: "confirmed", trigger: "판별 답변·리포트 수락·사용자 수정", audit: "mention.link_decided" },
  { id: "MN6", from: ["ambiguous"], to: "rejected", trigger: "엔티티 아님 답변", audit: "mention.link_decided" },
  { id: "MN7", from: ["new_entity_candidate"], to: "auto_linked", trigger: "후보 엔티티가 EN3(b)로 활성화", audit: "mention.link_decided" },
  { id: "MN8", from: ["confirmed", "auto_linked"], to: "confirmed", trigger: "사용자 재연결", audit: "mention.relinked" },
  // 06 §3.11 되돌리기 4단계 / 분리: 어느 쪽인지 정하지 않은 언급은 ambiguous로 내림
  { id: "ID4-4", from: ["auto_linked", "confirmed", "new_entity_candidate"], to: "ambiguous", trigger: "병합 되돌리기·분리 후 재링킹 대상", audit: "mention.relinked" },
];

export const FACT_TRANSITIONS: readonly TransitionRule<CanonStatus>[] = [
  { id: "F3", from: ["candidate"], to: "approved", trigger: "화 승인·아크 승인·full_auto 검사 통과·기획서 승인", audit: "fact.status_changed" },
  { id: "F4", from: ["candidate"], to: "rejected", trigger: "사람 기각·재작성으로 근거 소멸", audit: "fact.status_changed" },
  { id: "F5", from: ["approved"], to: "published_locked", trigger: "근거 화 공개(E13)", audit: "fact.status_changed" },
  { id: "F6", from: ["published_locked"], to: "approved", trigger: "근거 화 공개 취소(E14)", audit: "fact.status_changed" },
  { id: "F9", from: ["approved", "published_locked"], to: "retracted", trigger: "캐논 철회(승인 필요)", audit: "fact.status_changed" },
  // 06 §3.11 병합 6단계: 흡수 쪽 슬롯 충돌 사실을 candidate로 강등 / 되돌리기 4단계: 링크 보류로 되돌림
  { id: "ID-6", from: ["approved"], to: "candidate", trigger: "병합 슬롯 충돌 강등 / 되돌리기 후 링크 보류", audit: "fact.status_changed" },
];

export const IDENTITY_TRANSITIONS: readonly TransitionRule<IdentityDecisionStatus>[] = [
  { id: "ID2", from: ["proposed"], to: "applied", trigger: "같음·분리 답변 / identity_change 승인", audit: "identity.applied" },
  { id: "ID3", from: ["proposed"], to: "rejected", trigger: "다름 답변", audit: "identity.rejected" },
  { id: "ID3c", from: ["proposed"], to: "cancelled", trigger: "대상 소멸", audit: "identity.rejected" },
  { id: "ID4", from: ["applied"], to: "reverted", trigger: "되돌리기", audit: "identity.reverted" },
];

export function findTransition<S extends string>(table: readonly TransitionRule<S>[], aggregate: string, from: S, to: S): TransitionRule<S> {
  const rule = table.find((r) => r.to === to && r.from.includes(from));
  if (!rule) throw new InvalidTransitionError(aggregate, from, to);
  return rule;
}

export const assertEntityTransition = (from: EntityStatus, to: EntityStatus) => findTransition(ENTITY_TRANSITIONS, "entity", from, to);
export const assertNameTransition = (from: NameStatus, to: NameStatus) => findTransition(NAME_TRANSITIONS, "entity_name", from, to);
export const assertMentionTransition = (from: LinkStatus, to: LinkStatus) => findTransition(MENTION_TRANSITIONS, "mention", from, to);
export const assertFactTransition = (from: CanonStatus, to: CanonStatus) => findTransition(FACT_TRANSITIONS, "fact", from, to);
export const assertIdentityTransition = (from: IdentityDecisionStatus, to: IdentityDecisionStatus) =>
  findTransition(IDENTITY_TRANSITIONS, "identity_decision", from, to);

export const CANON_STATUSES: readonly CanonStatus[] = ["approved", "published_locked"];
export const isCanon = (s: CanonStatus) => s === "approved" || s === "published_locked";
/** mention statuses that block promotion of facts citing them (INV-ONT-07) */
export const UNRESOLVED_LINK: readonly LinkStatus[] = ["ambiguous", "new_entity_candidate"];
