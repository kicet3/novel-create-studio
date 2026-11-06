-- 0009_concept_auto_approve — 컨셉 대화 자동 승인 모드(module concept).
-- 자동 승인이 사용자 대신 고른 선택은 사용자(위임한 사람) 메시지로 남기되 auto_approved로 구분합니다.
-- 모드 상태 자체는 concept_sessions.working_brief.meta.auto_approve(jsonb)에 둡니다.
ALTER TABLE concept_messages ADD COLUMN auto_approved boolean NOT NULL DEFAULT false;
ALTER TABLE concept_messages ADD CONSTRAINT concept_messages_ck_auto CHECK (NOT auto_approved OR author_kind = 'user');
