/**
 * ContinuityIssue state machine (03 §4.6 C1–C8) with invariants INV-CI-01..05. Pure — no I/O.
 */
import type { ActivityAction, ContinuityIssueKind, ContinuityIssueStatus, IssueResolutionKind, IssueSeverity } from "@ncs/shared";
import { DomainValidationError, InvalidTransitionError } from "../../../platform/errors.js";
import type { ActorRef } from "../../../platform/types.js";

export interface IssueTransitionRule {
  id: "C2" | "C3" | "C4" | "C5" | "C6" | "C7" | "C8";
  from: readonly ContinuityIssueStatus[];
  to: ContinuityIssueStatus;
  trigger: string;
  action: ActivityAction;
}

export const ISSUE_TRANSITIONS: readonly IssueTransitionRule[] = [
  { id: "C2", from: ["open"], to: "fixing", trigger: "자동 수정 또는 재작성 작업 시작", action: "continuity_issue.status_changed" },
  { id: "C3", from: ["fixing"], to: "resolved", trigger: "새 버전 재검사에서 재현 안 됨", action: "continuity_issue.resolved" },
  { id: "C4", from: ["fixing"], to: "open", trigger: "재검사에서 재현", action: "continuity_issue.status_changed" },
  { id: "C5", from: ["open"], to: "resolved", trigger: "사람 직접 수정 후 재검사 통과, 캐논 변경·리트콘 승인", action: "continuity_issue.resolved" },
  { id: "C6", from: ["open"], to: "waived", trigger: "의도된 설정으로 허용", action: "continuity_issue.waived" },
  { id: "C7", from: ["open"], to: "false_positive", trigger: "오탐 판정", action: "continuity_issue.status_changed" },
  { id: "C8", from: ["open", "fixing"], to: "superseded", trigger: "대상 버전이 아웃라인부터 재작성돼 위치가 사라짐", action: "continuity_issue.status_changed" },
];

export const OPEN_STATUSES: readonly ContinuityIssueStatus[] = ["open", "fixing"];
export const SAFETY_KINDS: readonly ContinuityIssueKind[] = ["safety_age_rating", "safety_minor_sexual", "safety_real_person"];
/** issue kinds produced by check_continuity (07 §5.1: all but safety_* and the setup_* kinds of check_setups) */
export const CHECK_CONTINUITY_KINDS: readonly ContinuityIssueKind[] = [
  "appearance",
  "age",
  "relationship",
  "ability_rule",
  "location_travel",
  "death_state",
  "character_knowledge",
  "identity_leak",
  "schema_violation",
  "published_canon_conflict",
  "answer_constraint",
  "glossary_spelling",
];
export const SETUP_KINDS: readonly ContinuityIssueKind[] = ["setup_missing", "setup_contradiction"];

export interface IssueGuardInput {
  from: ContinuityIssueStatus;
  to: ContinuityIssueStatus;
  kind: ContinuityIssueKind;
  severity: IssueSeverity;
  actor: ActorRef;
  resolutionKind?: IssueResolutionKind | null;
  autoFixDiff?: unknown;
  /** INV-CI-04: approved retcon approval id (verified by the caller) */
  retconApprovalId?: string | null;
  /** C5 by a user: approved canon_change approval id (verified by the caller) */
  canonChangeApprovalId?: string | null;
  /**
   * C5 human_edited by a user: the episode's current version is a human edit made after the version the
   * issue points at (verified by the caller). A recheck that reproduces the issue relinks it to the new
   * version, so an issue still pointing at an older version was not reproduced there.
   */
  humanEditAfterIssue?: boolean;
}

export function assertIssueTransition(g: IssueGuardInput): IssueTransitionRule {
  const rule = ISSUE_TRANSITIONS.find((r) => r.to === g.to && r.from.includes(g.from));
  if (!rule) throw new InvalidTransitionError("continuity_issue", g.from, g.to);
  const isUser = g.actor.type === "user";

  if (rule.id === "C6" || rule.id === "C7") {
    // INV-CI-05: text-safety issues can never be waived / marked false positive
    if (SAFETY_KINDS.includes(g.kind)) {
      throw new DomainValidationError("issue_safety_not_waivable", "텍스트 안전 이슈는 허용하거나 오탐으로 닫을 수 없습니다. 재작성하거나 직접 고친 뒤 재검사하세요.");
    }
    // INV-CI-03: high → user only; medium/low → user or the designated agent
    if (!isUser) {
      const allowedRole = rule.id === "C6" ? "showrunner" : "continuity_editor";
      if (g.severity === "high" || g.actor.type !== "agent" || g.actor.id !== allowedRole) {
        throw new DomainValidationError(
          "issue_waive_actor",
          g.severity === "high" ? "심각도 높음 이슈는 사용자만 허용하거나 오탐으로 닫을 수 있습니다." : "이 이슈를 닫을 권한이 없습니다.",
          { rule: rule.id, actor: g.actor.type },
        );
      }
    }
    // INV-CI-04: published canon conflicts need a retcon approval to be waived (and cannot be "false positive")
    if (g.kind === "published_canon_conflict") {
      if (rule.id === "C7" || !g.retconApprovalId) {
        throw new DomainValidationError("issue_retcon_required", "공개 사실과 충돌하는 이슈는 리트콘 승인 없이 허용할 수 없습니다.");
      }
    }
  }
  if (rule.id === "C3") {
    if (!g.resolutionKind) throw new DomainValidationError("issue_resolution_required", "해결 방식이 필요합니다.");
    if (g.resolutionKind === "auto_fixed" && g.autoFixDiff == null) {
      throw new DomainValidationError("issue_auto_fix_diff_required", "자동 수정은 수정 전후 diff를 남겨야 합니다(FR-AGT-10).");
    }
  }
  if (rule.id === "C5") {
    if (!g.resolutionKind || !["human_edited", "canon_updated", "retconned"].includes(g.resolutionKind)) {
      throw new DomainValidationError("issue_resolution_kind", "직접 해결은 사람 수정·캐논 변경·리트콘 중 하나여야 합니다.");
    }
    if (isUser) {
      // INV-CI-05: text-safety issues close only through a rewrite or a human edit followed by a recheck
      if (SAFETY_KINDS.includes(g.kind)) {
        throw new DomainValidationError("issue_safety_recheck_only", "텍스트 안전 이슈는 직접 해결로 닫을 수 없습니다. 재작성하거나 직접 고친 뒤 재검사에서 해소돼야 합니다.");
      }
      if (g.resolutionKind === "human_edited" && !g.humanEditAfterIssue) {
        throw new DomainValidationError("issue_human_edit_required", "이슈가 난 버전 뒤에 직접 고친 버전이 있어야 사람 수정으로 해결할 수 있습니다.");
      }
      if (g.resolutionKind === "retconned" && !g.retconApprovalId) {
        throw new DomainValidationError("issue_retcon_required", "리트콘으로 해결하려면 승인된 리트콘 승인이 필요합니다.");
      }
      if (g.resolutionKind === "canon_updated" && !g.canonChangeApprovalId) {
        throw new DomainValidationError("issue_canon_change_required", "캐논 변경으로 해결하려면 승인된 캐논 변경 승인이 필요합니다.");
      }
      // INV-CI-04: published canon conflicts close only with a retcon / canon change approval
      if (g.kind === "published_canon_conflict" && !g.retconApprovalId && !g.canonChangeApprovalId) {
        throw new DomainValidationError("issue_retcon_required", "공개 사실과 충돌하는 이슈는 리트콘 승인 없이 닫을 수 없습니다.");
      }
    }
  }
  if ((rule.id === "C2" || rule.id === "C8") && isUser) {
    throw new DomainValidationError("issue_system_only", "이 전이는 시스템만 할 수 있습니다.");
  }
  return rule;
}

/** transitions a user may request from the web (C5/C6/C7) for the current state */
export function userTransitionsFrom(issue: { status: ContinuityIssueStatus; kind: ContinuityIssueKind }): ContinuityIssueStatus[] {
  if (issue.status !== "open") return [];
  // INV-CI-05: safety issues have no user transition (rewrite or human edit + recheck only)
  if (SAFETY_KINDS.includes(issue.kind)) return [];
  const out: ContinuityIssueStatus[] = ["resolved", "waived"];
  if (issue.kind !== "published_canon_conflict") out.push("false_positive");
  return out;
}

export const formatIssueNo = (n: number) => `CI-${n}`;
