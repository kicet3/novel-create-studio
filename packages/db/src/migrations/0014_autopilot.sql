-- 0014_autopilot — 완전 자율 진행(설계 추가, module novel·hitl·autopilot).
-- full_auto인 작품은 승인 행을 그대로 만들고 autopilot 루프가 조건을 확인해 자동으로 결정합니다(approvals.auto_decided).
-- 항상 사람 승인 목록(기존 승인 사실 변경·리트콘·결말 변경·예산 재개·떡밥 폐기 등)은 DB에서도 자동 결정을 막습니다.
-- 질문 자동 응답은 resolution_source='auto_answer'로 남고, 차단형은 승인 게이트·아크 목표·중요 떡밥 기한(민감도 normal)만 허용합니다.
ALTER TABLE novels ADD COLUMN autopilot_settings jsonb NOT NULL DEFAULT '{}';
ALTER TABLE novels ADD COLUMN autopilot_state jsonb NOT NULL DEFAULT '{}';
ALTER TABLE novels ADD COLUMN autopilot_enabled_by_user_id text;
ALTER TABLE novels ADD COLUMN autopilot_acknowledged_at timestamptz;
ALTER TABLE novels ADD COLUMN autopilot_halted_at timestamptz;
ALTER TABLE novels ADD COLUMN autopilot_halt_reason text;
ALTER TABLE novels ADD CONSTRAINT novels_autopilot_halt_reason_enum CHECK (autopilot_halt_reason IN ('user', 'budget_warning', 'error'));
ALTER TABLE novels ADD CONSTRAINT novels_ck_autopilot_halt CHECK ((autopilot_halted_at IS NULL) = (autopilot_halt_reason IS NULL));
COMMENT ON COLUMN novels.autopilot_halt_reason IS 'enum:autopilot_halt_reason';

ALTER TABLE approvals ADD COLUMN auto_decided boolean NOT NULL DEFAULT false;
-- INV-AUTO-01: 자동 결정은 승인만(반려 없음), 자동 결정이 허용된 종류만
ALTER TABLE approvals ADD CONSTRAINT approvals_ck_auto CHECK (NOT auto_decided OR
  (approval_type IN ('concept_brief', 'series_bible', 'arc_plan', 'episode', 'story_structure') AND status <> 'rejected'));

ALTER TABLE answers ADD COLUMN auto_answered boolean NOT NULL DEFAULT false;

ALTER TABLE questions ADD COLUMN sensitivity text NOT NULL DEFAULT 'normal';
ALTER TABLE questions ADD CONSTRAINT questions_sensitivity_enum CHECK (sensitivity IN ('normal', 'high'));
COMMENT ON COLUMN questions.sensitivity IS 'enum:question_sensitivity';
ALTER TABLE questions DROP CONSTRAINT questions_resolution_source_enum;
ALTER TABLE questions ADD CONSTRAINT questions_resolution_source_enum CHECK (resolution_source IN ('user_answer', 'default_applied', 'deadline_hold', 'absence_delegated', 'notice_only', 'auto_answer'));
ALTER TABLE questions DROP CONSTRAINT questions_ck_4;
ALTER TABLE questions ADD CONSTRAINT questions_ck_4 CHECK (grade <> 'blocking' OR resolution_source IS NULL
  OR resolution_source IN ('user_answer', 'absence_delegated')
  OR (resolution_source = 'auto_answer' AND sensitivity = 'normal' AND blocking_basis IN ('approval_gate', 'arc_goal', 'setup_due_high')) /* INV-Q-02 fail-closed + 완전 자율 */);
-- 기존 질문 민감도 채우기: 0014 전에 만든 행은 기본값 normal이라 그대로 두면 자동 응답 대상이 됩니다.
-- 주제·차단 근거가 항상 사람 몫인 행은 high로 올립니다(서버 questionSensitivity의 HIGH_SENSITIVITY_TOPICS·BASES와 같은 목록).
UPDATE questions SET sensitivity = 'high'
WHERE topic IN ('entity_disambiguation', 'duplicate_entity', 'identity_change', 'interpretation_confirm', 'late_answer_conflict', 'setup_abandon',
                'retcon', 'budget', 'direction', 'schema_change', 'safety_review', 'provider_outage', 'extraction_failure', 'publish_batch',
                'media_gate', 'rewrite_limit')
   OR blocking_basis IN ('ending_direction', 'canon_change', 'published_canon', 'major_character_fate', 'budget', 'safety_review', 'system_failure', 'rewrite_limit');
