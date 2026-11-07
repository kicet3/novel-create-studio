/**
 * Default value registry — code representation of design/00 §7 (all values are assumptions).
 * Keys are used verbatim in config files and code (00 §7 "키 이름은 그대로 씁니다").
 *
 * Scope: install (config file / env), novel (per-novel settings), system (code constant), calibrated.
 * Money values with `_usd` suffix are USD; convert with `usdToMicros` (ADR-016).
 */
import type { EnumValue } from "./enum-registry.js";

export type DefaultScope = "install" | "novel" | "system" | "calibrated";

interface Def<T> {
  value: T;
  scope: DefaultScope;
}
const d = <T>(value: T, scope: DefaultScope): Def<T> => ({ value, scope });

/** Time-of-day in the novel timezone, "HH:MM". */
export type WallClock = `${number}:${number}`;

export const DEFAULT_DEFS = {
  // 7.1 예산·비용
  "budget.novel_monthly_hard_limit_usd": d(80, "novel"),
  "budget.soft_warn_ratio": d(0.8, "novel"),
  "budget.text_monthly_hard_limit_usd": d<number | null>(null, "novel"),
  "budget.image_monthly_hard_limit_usd": d(20, "novel"),
  "budget.video_monthly_hard_limit_usd": d(0, "novel"),
  "budget.window": d<EnumValue<"budget_window">>("calendar_month", "novel"),
  "budget.unpriced_usage_policy": d<EnumValue<"unpriced_usage_policy">>("block", "install"),
  "budget.media_quote_retry_margin_ratio": d(0.25, "novel"),
  "budget.reservation_stale_after_minutes": d(30, "system"),
  "budget.input_token_margin_ratio": d(0.1, "system"),

  // 7.2 LLM·실행
  "llm.max_output_tokens.writer": d(16000, "novel"),
  "llm.max_output_tokens.default": d(6000, "novel"),
  "llm.max_output_tokens.concept_partner": d(2500, "novel"),
  // hard cap of one provider call (API lanes; claude_code has its own below). Per-provider override:
  // InstallConfig llm.provider_call_timeout_seconds.<provider>
  "llm.call_timeout_seconds": d(600, "install"),
  // streaming calls: abort when no bytes arrived for this long (armed at the first byte; 0 = off)
  "llm.idle_timeout_seconds": d(300, "install"),
  "llm.claude_code.max_concurrent": d(2, "install"),
  "llm.claude_code.call_timeout_seconds": d(1200, "install"),
  "llm.max_retries_per_call": d(3, "system"),
  "llm.retry_backoff_seconds": d([5, 30, 120] as const, "system"),
  "llm.fallback_model_enabled": d(false, "novel"),
  "llm.rate_limit_max_wait_seconds": d(600, "system"),
  "run.max_concurrent_per_novel": d(2, "install"),
  "run.max_concurrent_global": d(4, "install"),
  "task.max_attempts": d(3, "system"),
  // agent-to-agent repair dialogue: rounds of validator critique → producer correction inside one run before the
  // task falls back to its retry / fail path (agents.callWithRepair)
  "agents.repair_rounds": d(2, "system"),
  // consecutive runs cut off by a server stop / crash / lease loss before the task fails (crash-loop guard);
  // such interruptions never use task.max_attempts
  "task.max_interruptions": d(10, "system"),
  "lease.ttl_seconds": d(300, "system"),
  "lease.renew_interval_seconds": d(30, "system"),
  "reclaim.scan_interval_seconds": d(60, "system"),
  "wake.coalesce_window_seconds": d(10, "system"),
  "context.build_timeout_seconds": d(60, "system"),
  "context.build_p90_target_seconds": d(10, "system"),
  "context.max_input_tokens.writer": d(40000, "novel"),
  "context.max_input_tokens.default": d(24000, "novel"),
  "context.max_input_tokens.concept_partner": d(16000, "novel"),
  "provider.breaker_failures": d(5, "system"),
  "provider.breaker_window_seconds": d(300, "system"),
  "schedule.tick_seconds": d(60, "system"),
  "schedule.max_episodes_in_flight": d(2, "novel"),
  "scheduler.poll_interval_seconds": d(5, "system"),
  "db.tx_retry_max": d(3, "system"),
  "db.statement_timeout_ms": d(30000, "system"),
  "shutdown.grace_seconds": d(60, "system"),
  "prompt.self_consistency_samples": d(3, "calibrated"),

  // 7.3 원고 파이프라인
  "length.default_profile": d({ min_chars: 5000, max_chars: 5500, count_basis: "with_spaces" as const }, "novel"),
  // 설계 추가 0017: 초고(수정본) 분량이 프로필 범위를 벗어나면 줄이기/늘리기 패스를 최대 N회 돌립니다(다듬기 뒤 1회 더).
  "length.adjust_max_rounds": d(2, "system"),
  // 최대 분량을 이 비율까지 넘는 것은 범위 안으로 봅니다(5,500자 × 1.03 = 5,665자). 자동 승인도 이 범위까지만.
  "length.adjust_tolerance_ratio": d(0.03, "system"),
  "episode.max_rejections": d(3, "novel"),
  "continuity.max_auto_rewrites_per_episode": d(2, "novel"),
  "extraction.max_retries": d(2, "system"),
  "quality.max_rewrites": d(2, "novel"),
  "scene.id_retention_overlap_min": d(0.5, "calibrated"),
  "scene.max_per_episode": d(999, "system"),
  "polish.recheck_on_fact_diff": d(true, "system"),
  "reserve.target_episodes": d(5, "novel"),
  "novel.default_narration_mode": d<EnumValue<"narration_mode">>("third_limited", "novel"),

  // 7.4 질문·메신저
  "question.daily_cap_non_blocking": d(10, "novel"),
  "question.digest_window_minutes": d(15, "novel"),
  "question.digest_max_items": d(3, "novel"),
  "question.deadline_hours.blocking": d(12, "novel"),
  "question.deadline_hours.non_blocking": d(24, "novel"),
  /** Reminder offsets after the deadline, minutes (2회: 마감 직후, 24시간 후). */
  "question.reminders.blocking": d([0, 1440] as const, "novel"),
  "question.quiet_hours": d({ start: "23:00" as WallClock, end: "08:00" as WallClock }, "novel"),
  "question.urgent_exception_enabled": d(false, "novel"),
  "question.daily_summary_time": d("08:00" as WallClock, "novel"),
  "question.publish_batch_weekday": d({ weekday: 1 /* Monday */, time: "08:00" as WallClock }, "novel"),
  "question.dispatch_interval_seconds": d(30, "system"),
  "question.preview_max_chars": d(160, "system"),
  "question.messenger_max_entity_options": d(4, "system"),
  "question.buttons_max_options": d(8, "system"),
  "question.option_label_max_chars": d(40, "system"),
  "question.web_confirm_approval_types": d([] as EnumValue<"approval_type">[], "novel"),
  "channel.binding_token_ttl_minutes": d(15, "install"),
  "channel.health_check_interval_minutes": d(15, "install"),
  "channel.degraded_after_consecutive_failures": d(3, "system"),
  "outbox.max_attempts": d(5, "system"),
  "inbox.dedupe_retention_hours": d(72, "system"),
  "inbox.max_attempts": d(5, "system"),
  "setup.due_warning_episodes": d(5, "novel"),
  "setup.overdue_handling_window_episodes": d(3, "novel"),
  "answer_session.ttl_minutes": d(30, "system"),
  "interpretation.max_correction_rounds": d(2, "system"),
  "interpretation.answer_context_messages": d(5, "system"),
  "discord.rate_limit_breaker_429_per_10min": d(100, "system"),
  "messenger.episode_full_text_attachment": d(false, "novel"),
  "telegram.poll_timeout_seconds": d(25, "system"),
  "telegram.poll_backoff_max_seconds": d(60, "system"),

  // 7.5 엔티티 링킹·식별 (calibrated)
  "linking.candidate_top_k": d(8, "calibrated"),
  "linking.tau_auto.named": d(0.9, "calibrated"),
  "linking.tau_auto.title": d(0.92, "calibrated"),
  "linking.tau_auto.address": d(0.95, "calibrated"),
  "linking.tau_auto.pronoun": d(0.95, "calibrated"),
  "linking.tau_auto.descriptive": d(0.95, "calibrated"),
  /** null = auto-link forbidden for zero mentions. */
  "linking.tau_auto.zero": d<number | null>(null, "calibrated"),
  "linking.tau_ask": d(0.6, "calibrated"),
  "linking.margin_delta": d(0.2, "calibrated"),
  "linking.require_unanimous_samples": d(true, "calibrated"),
  "linking.auto_precision_target": d(0.98, "calibrated"),
  "linking.disambiguation_question_grade": d<EnumValue<"question_grade">>("non_blocking", "calibrated"),
  "linking.rule_proposal_min_confirmations": d(2, "calibrated"),
  "linking.max_blocking_identity_questions_per_episode": d(1, "calibrated"),
  "linking.backlog_alert": d(50, "calibrated"),
  "linking.report_hold_digest_days": d(3, "calibrated"),
  "linking.no_name_match_top_n": d(4, "calibrated"),
  "linking.hidden_variant_rule_score_cap": d(0.7, "calibrated"),
  /** 설계 추가 0015: 엔티티 판정 에이전트(작품 설정 novels.entity_agent_resolution / entity_agent_min_confidence의 기본값) */
  "linking.agent_resolution": d(true, "novel"),
  "linking.agent_resolution_min_confidence": d(0.75, "novel"),
  /** 판정 에이전트 LLM 호출 1회에 넣는 표기 묶음 상한 */
  "linking.agent_resolution_batch_max": d(60, "system"),
  "dedup.similar_entity_min_score": d(0.75, "calibrated"),
  "dedup.short_name_max_syllables": d(3, "calibrated"),
  "dedup.equivalence_check_top_k": d(8, "calibrated"),

  // 7.6 미디어 (v1/v2)
  "media.max_main_characters_per_shot": d(2, "novel"),
  "media.illustrations_per_episode": d(1, "novel"),
  "media.keyframe_drafts_per_shot": d(2, "novel"),
  "media.max_generation_retries": d(2, "novel"),
  "media.clip_seconds_range": d({ min: 4, max: 15 }, "system"),
  "media.default_aspect_ratio": d<EnumValue<"aspect_ratio">>("vertical_9_16", "novel"),

  // 7.7 운영·백업
  "backup.interval_hours": d(24, "install"),
  "backup.retention": d({ daily: 7, weekly: 4 }, "install"),
  "backup.restore_rto_minutes": d(60, "system"),
  "platform_profile.recheck_days": d(90, "install"),
  "ui.realtime_p95_seconds": d(5, "system"),
  "ui.poll_interval_seconds": d(5, "system"),
  "onboarding.first_question_target_minutes": d(30, "system"),
  "realtime.gap_wait_ms": d(2000, "system"),
  "realtime.replay_max_events": d(1000, "system"),
  "storage.orphan_gc_grace_hours": d(48, "system"),
  "system.sleep_detect_gap_seconds": d(120, "system"),

  // 7.8 컨셉
  // 설계 변경: 대화는 브리프 필수 항목이 모두 확정될 때까지 이어지고, 확정되면 파트너가 마무리 요약 후 질문을 멈춥니다.
  // max_turns는 숨은 안전 상한(폭주 방지)일 뿐이며, 실제 비용 한도는 concept.session_budget_usd가 지킵니다.
  "concept.max_turns": d(200, "novel"),
  /** 안전 상한까지 남은 턴이 이 값 이하이고 필수 항목이 남았으면 경고 (턴 수 자체는 UI에 상시 노출하지 않음) */
  "concept.turn_soft_warning_remaining": d(20, "system"),
  "concept.turn_extension": d(50, "system"),
  "concept.max_turn_extensions": d(4, "system"),
  "concept.check_reserve_usd": d(0.3, "novel"),
  "concept.slot_flip_limit": d(3, "system"),
  "concept.idle_reminder_hours": d(48, "novel"),
  "concept.session_idle_days": d(14, "system"),
  "concept.session_budget_usd": d(6, "novel"),
  "concept.max_questions_per_turn": d({ web: 2, messenger: 1 }, "system"),
  "concept.max_options_per_question": d(3, "system"),
  "concept.max_template_questions": d(8, "system"),
  "concept.recent_messages_in_context": d(8, "system"),
  "concept.reply_max_chars": d(1200, "system"),
  "concept.messenger_summary_max_chars": d(3500, "system"),
  "concept.import_max_chars": d(20000, "system"),
  "concept.turn_p90_target_seconds": d(30, "system"),
  "concept.question_set_version": d("common@1", "system"),

  // 7.9 장르 템플릿
  "template.max_required_questions": d(6, "system"),
  "template.max_enabled_rules": d(20, "system"),
  "template.source_recheck_days": d(90, "system"),
} as const;

export type DefaultKey = keyof typeof DEFAULT_DEFS;
export type DefaultValue<K extends DefaultKey> = (typeof DEFAULT_DEFS)[K]["value"];

/** Flat map key → value. */
export const DEFAULTS: { readonly [K in DefaultKey]: DefaultValue<K> } = Object.fromEntries(
  Object.entries(DEFAULT_DEFS).map(([k, v]) => [k, v.value]),
) as never;

export function defaultValue<K extends DefaultKey>(key: K): DefaultValue<K> {
  return DEFAULT_DEFS[key].value;
}

export function defaultScope(key: DefaultKey): DefaultScope {
  return DEFAULT_DEFS[key].scope;
}

// ── 설치 기본값 (fixed implementation decisions; override design/08 §5.2 where they differ) ──
export const INSTALL_DEFAULTS = {
  /** Install home; env NCS_HOME overrides. */
  home: "~/.ncs",
  /** Embedded PG data dir; relative to home: `<home>/data/pg`. */
  embeddedDataDir: "~/.ncs/data/pg",
  embeddedPort: 54329,
  serverHost: "127.0.0.1",
  serverPort: 3100,
  timezone: "Asia/Seoul",
} as const;

// ── Default Claude model ids (LLM role bindings) ──
export const DEFAULT_MODELS = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
} as const;

// ── Money (ADR-016): micro-USD integers ──
export const MICROS_PER_USD = 1_000_000;

export function usdToMicros(usd: number): number {
  if (!Number.isFinite(usd)) throw new RangeError(`usd must be finite: ${usd}`);
  return Math.round(usd * MICROS_PER_USD);
}

export function microsToUsd(micros: number): number {
  return micros / MICROS_PER_USD;
}

/** Format micros as "$12.34" (rounded to cents unless `digits` is given). */
export function formatUsd(micros: number, digits = 2): string {
  const v = microsToUsd(micros);
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toFixed(digits)}`;
}
