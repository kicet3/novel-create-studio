/**
 * Episode state machine (design/03 §4.1, E1–E16). Pure — no I/O.
 * "표에 없는 전이는 거부합니다": every status change goes through `findEpisodeRule`.
 */
import type { ActivityAction, EpisodeStatus } from "@ncs/shared";
import { InvalidTransitionError } from "../../../platform/errors.js";
import type { EpisodeRuleId } from "../index.js";

export interface EpisodeTransitionRule {
  id: EpisodeRuleId;
  from: readonly EpisodeStatus[];
  to: EpisodeStatus;
  trigger: string;
  /** audit action recorded for this rule (03 §4.1 감사 이벤트 열의 첫 이벤트) */
  action: ActivityAction;
}

export const EPISODE_TRANSITIONS: readonly EpisodeTransitionRule[] = [
  { id: "E1", from: ["planned"], to: "outlining", trigger: "outline_episode 작업 시작", action: "episode.status_changed" },
  { id: "E2", from: ["outlining"], to: "drafting", trigger: "아웃라인 버전 저장", action: "episode.status_changed" },
  { id: "E3", from: ["drafting"], to: "checking", trigger: "초고 버전 저장", action: "episode.status_changed" },
  { id: "E4", from: ["checking"], to: "drafting", trigger: "검사 결과 재작성(GC-6)", action: "episode.status_changed" },
  { id: "E5", from: ["checking"], to: "outlining", trigger: "아웃라인 수준 수정(GC-5)", action: "episode.status_changed" },
  { id: "E6", from: ["checking"], to: "polishing", trigger: "검사 통과(GC-2)", action: "episode.status_changed" },
  { id: "E7", from: ["polishing"], to: "checking", trigger: "다듬은 버전의 사실 diff", action: "episode.status_changed" },
  { id: "E8", from: ["polishing"], to: "awaiting_approval", trigger: "최종 후보 버전 저장", action: "episode.status_changed" },
  { id: "E9", from: ["awaiting_approval"], to: "approved", trigger: "화 승인 / 아크 승인 / full_auto", action: "episode.approved" },
  { id: "E10", from: ["awaiting_approval"], to: "revising", trigger: "화 승인 반려", action: "episode.rejected" },
  { id: "E11", from: ["approved"], to: "revising", trigger: "공개 전 수정 요청", action: "episode.rejected" },
  { id: "E12", from: ["revising"], to: "outlining", trigger: "plan_rework 커밋(outline)", action: "episode.status_changed" },
  { id: "E12", from: ["revising"], to: "drafting", trigger: "plan_rework 커밋(draft)", action: "episode.status_changed" },
  { id: "E12", from: ["revising"], to: "polishing", trigger: "plan_rework 커밋(polish)", action: "episode.status_changed" },
  { id: "E13", from: ["approved"], to: "published", trigger: "공개 처리", action: "episode.published" },
  { id: "E14", from: ["published"], to: "approved", trigger: "공개 취소(정정)", action: "episode.unpublished" },
  { id: "E15", from: ["planned", "outlining"], to: "checking", trigger: "[v1 co_writing] 사람 원고 제출", action: "episode.status_changed" },
  {
    id: "E16",
    from: ["outlining", "drafting", "polishing", "awaiting_approval", "approved"],
    to: "checking",
    trigger: "사람 편집 저장(FR-MAN-07)",
    action: "episode.status_changed",
  },
];

export function findEpisodeRule(from: EpisodeStatus, to: EpisodeStatus, ruleId?: EpisodeRuleId): EpisodeTransitionRule {
  const rule = EPISODE_TRANSITIONS.find((r) => r.to === to && r.from.includes(from) && (!ruleId || r.id === ruleId));
  if (!rule) throw new InvalidTransitionError("episode", from, to);
  return rule;
}

/** statuses in which writing work is in flight (04 §3.4 in_flight) */
export const IN_FLIGHT_STATUSES: readonly EpisodeStatus[] = ["outlining", "drafting", "checking", "polishing", "revising"];

/** E16 is allowed from these statuses (`checking` = no transition, checks restart). */
export const HUMAN_EDITABLE_STATUSES: readonly EpisodeStatus[] = ["outlining", "drafting", "checking", "polishing", "awaiting_approval", "approved"];

/** rework_from → E12 target status */
export const REWORK_TARGET: Readonly<Record<"outline" | "draft" | "polish", EpisodeStatus>> = {
  outline: "outlining",
  draft: "drafting",
  polish: "polishing",
};
