/**
 * Audit `action` catalogue (design/03 §6.3, 11 §5.6, 06 §14). `audit.record()` only accepts these names.
 * Format `<area>.<verb>` (DB CHECK `^[a-z_]+\.[a-z_]+$`). Add new names here (one place) when a design
 * doc adds an event.
 */
export const ACTIVITY_ACTIONS = [
  // 작품
  "novel.created", "novel.settings_changed", "novel.autonomy_changed", "novel.paused", "novel.resumed", "novel.status_changed", "novel.deleted",
  // 목표
  "goal.updated",
  // 컨셉 세션·브리프
  "concept_session.created", "concept_session.status_changed", "concept_session.stage_changed", "concept_session.paused", "concept_session.resumed",
  "concept_session.limit_extended", "concept_session.entry_mode_changed",
  "concept_brief.version_created", "concept_brief.status_changed", "concept_brief.field_edited", "concept_brief.change_proposal_decided",
  // 기획서·아크
  "series_bible.version_created", "series_bible.status_changed",
  "arc.created", "arc.updated", "arc.status_changed", "arc.paused", "arc.resumed",
  // 화·원고
  "episode.created", "episode.status_changed", "episode.rejected", "episode.approved", "episode.published", "episode.unpublished",
  "episode.blocked", "episode.unblocked", "episode.paused", "episode.resumed",
  "manuscript.version_created", "manuscript.human_edited", "scene.resegmented",
  // 작업·실행
  "task.created", "task.status_changed", "task.lease_acquired", "task.lease_reclaimed", "task.blocked", "task.unblocked", "task.paused",
  "task.resumed", "task.cancelled", "task.reassigned",
  "run.queued", "run.started", "run.finished", "run.interrupted",
  // 질문·답변·승인
  "question.created", "question.sent", "question.reminded", "question.answered", "question.defaulted", "question.resolved", "question.cancelled",
  "question.late_answer_received", "question.late_answer_resolved", "question.regraded",
  "answer.interpreted", "answer.interpretation_decided", "answer_reflection.recorded", "answer_reflection.notified",
  "approval.requested", "approval.decided", "approval.cancelled", "approval.superseded",
  // 채널
  "channel.binding_issued", "channel.bound", "channel.unbound", "channel.health_changed", "channel.unauthorized_input", "channel.command_received",
  // 예산·비용
  "budget.policy_changed", "budget.warning_reached", "budget.hard_stop_reached", "budget.resumed",
  "cost.overrun_recorded", "cost.unknown_recorded", "cost.restored_carryover",
  // 온톨로지
  "fact.created", "fact.status_changed", "fact.version_created", "fact.retconned", "fact.reverted",
  "entity.created", "entity.status_changed", "entity.preferred_name_changed",
  "entity_name.added", "entity_name.updated", "entity_name.retired",
  "mention.batch_linked", "mention.link_decided", "mention.relinked",
  "identity.proposed", "identity.applied", "identity.rejected", "identity.reverted",
  "schema.change_proposed", "schema.change_decided", "schema.version_published",
  "glossary.term_created", "glossary.term_updated",
  "timeline.created", "timeline.updated",
  // 떡밥
  "setup.created", "setup.narrative_status_changed", "setup.canon_status_changed", "setup.due_changed", "setup.beat_planned",
  "setup.beat_detected", "setup.beat_missing", "setup.beat_confirmed", "setup.abandoned", "setup.updated",
  // 연속성
  "continuity_issue.opened", "continuity_issue.status_changed", "continuity_issue.resolved", "continuity_issue.waived",
  // 설정·운영
  "settings.changed", "secret.set", "secret.deleted", "provider_profile.changed", "model_binding.changed",
  "backup.completed", "backup.failed", "backup.restored", "system.migration_applied", "system.health_check_failed", "export.created",
  // 이미지 생성 탭
  "image.requested", "image.completed", "image.failed", "image.deleted",
  // 캐릭터 설정 단계(module cast)
  "character.created", "character.updated", "character.deleted", "character.reordered", "character.status_changed",
  "cast.draft_requested", "cast.draft_applied", "cast.confirmed",
  "design_sheet.updated", "design_sheet.draft_requested", "design_sheet.image_requested", "design_sheet.image_selected",
] as const;

export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];

const ACTION_SET: ReadonlySet<string> = new Set(ACTIVITY_ACTIONS);

export function isActivityAction(value: unknown): value is ActivityAction {
  return typeof value === "string" && ACTION_SET.has(value);
}

/** Area prefix of an action ("episode.status_changed" → "episode"). */
export function activityArea(action: ActivityAction): string {
  return action.slice(0, action.indexOf("."));
}
