-- 0018_revision_chat — 화별 수정 대화(module revision)와 한 화씩 진행(설계 추가).
-- 원고가 있는 화마다 대화 스레드 하나를 두고, 작가가 고른 구간(anchor)을 묻고, 편집자 에이전트(line_editor)가 근거를 들어
-- 답하거나 최소 범위 본문 수정·설정 변경·영향 범위를 제안합니다. 제안은 작가가 하나씩 적용/거절합니다.
-- "고치지 않고 끝내기"로 남긴 작가 확인 메모는 뒤 화 집필 컨텍스트(constraints)에 들어갑니다.
CREATE TABLE revision_chat_sessions (
  id text NOT NULL,
  novel_id text NOT NULL,
  episode_id text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  CONSTRAINT revision_chat_sessions_status_enum CHECK (status IN ('active', 'closed')),
  outcome text,
  CONSTRAINT revision_chat_sessions_outcome_enum CHECK (outcome IN ('explanation_only', 'patched', 'setting_changed', 'handed_off')),
  in_flight_task_id text,
  last_processed_seq integer NOT NULL DEFAULT 0,
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT revision_chat_sessions_id_format CHECK (id ~ '^rvs_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT revision_chat_sessions_tenant_key UNIQUE (novel_id, id),
  CONSTRAINT revision_chat_sessions_episode_key UNIQUE (novel_id, episode_id)
);
COMMENT ON COLUMN revision_chat_sessions.status IS 'enum:revision_chat_session_status';
COMMENT ON COLUMN revision_chat_sessions.outcome IS 'enum:revision_chat_outcome';
ALTER TABLE revision_chat_sessions ADD CONSTRAINT revision_chat_sessions_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE revision_chat_sessions ADD CONSTRAINT revision_chat_sessions_episode_fk FOREIGN KEY (novel_id, episode_id) REFERENCES episodes (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;

CREATE TABLE revision_chat_messages (
  id text NOT NULL,
  novel_id text NOT NULL,
  session_id text NOT NULL,
  seq integer NOT NULL,
  author_kind text NOT NULL,
  CONSTRAINT revision_chat_messages_author_kind_enum CHECK (author_kind IN ('user', 'agent', 'system')),
  body text NOT NULL,
  run_id text,
  anchor jsonb,
  diagnosis_kind text,
  CONSTRAINT revision_chat_messages_diagnosis_kind_enum CHECK (diagnosis_kind IN ('text_inconsistent_with_setting', 'setting_questionable', 'explanation_only', 'style')),
  question jsonb,
  sources jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT revision_chat_messages_id_format CHECK (id ~ '^rvm_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT revision_chat_messages_tenant_key UNIQUE (novel_id, id),
  CONSTRAINT revision_chat_messages_seq_key UNIQUE (novel_id, session_id, seq),
  CONSTRAINT revision_chat_messages_ck_seq CHECK (seq >= 1)
);
COMMENT ON COLUMN revision_chat_messages.author_kind IS 'enum:revision_chat_author';
COMMENT ON COLUMN revision_chat_messages.diagnosis_kind IS 'enum:revision_diagnosis_kind';
ALTER TABLE revision_chat_messages ADD CONSTRAINT revision_chat_messages_session_fk FOREIGN KEY (novel_id, session_id) REFERENCES revision_chat_sessions (novel_id, id) ON DELETE CASCADE;

CREATE TABLE revision_chat_proposals (
  id text NOT NULL,
  novel_id text NOT NULL,
  session_id text NOT NULL,
  message_id text NOT NULL,
  kind text NOT NULL,
  CONSTRAINT revision_chat_proposals_kind_enum CHECK (kind IN ('text_patch', 'setting_change', 'impact_note')),
  status text NOT NULL DEFAULT 'pending',
  CONSTRAINT revision_chat_proposals_status_enum CHECK (status IN ('pending', 'accepted', 'rejected', 'stale', 'awaiting_approval', 'applied')),
  base_version_id text,
  payload jsonb NOT NULL DEFAULT '{}',
  result_version_id text,
  approval_id text,
  decided_by_user_id text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT revision_chat_proposals_id_format CHECK (id ~ '^rvp_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT revision_chat_proposals_tenant_key UNIQUE (novel_id, id)
);
COMMENT ON COLUMN revision_chat_proposals.kind IS 'enum:revision_proposal_kind';
COMMENT ON COLUMN revision_chat_proposals.status IS 'enum:revision_proposal_status';
ALTER TABLE revision_chat_proposals ADD CONSTRAINT revision_chat_proposals_session_fk FOREIGN KEY (novel_id, session_id) REFERENCES revision_chat_sessions (novel_id, id) ON DELETE CASCADE;
ALTER TABLE revision_chat_proposals ADD CONSTRAINT revision_chat_proposals_message_fk FOREIGN KEY (novel_id, message_id) REFERENCES revision_chat_messages (novel_id, id) ON DELETE CASCADE;
CREATE INDEX revision_chat_proposals_session_idx ON revision_chat_proposals (novel_id, session_id, created_at);
CREATE INDEX revision_chat_proposals_approval_idx ON revision_chat_proposals (novel_id, approval_id) WHERE approval_id IS NOT NULL;

CREATE TABLE episode_author_notes (
  id text NOT NULL,
  novel_id text NOT NULL,
  episode_id text NOT NULL,
  session_id text,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  CONSTRAINT episode_author_notes_status_enum CHECK (status IN ('active', 'retracted')),
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT episode_author_notes_id_format CHECK (id ~ '^ean_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT episode_author_notes_tenant_key UNIQUE (novel_id, id),
  CONSTRAINT episode_author_notes_ck_body CHECK (length(btrim(body)) BETWEEN 1 AND 2000)
);
COMMENT ON COLUMN episode_author_notes.status IS 'enum:author_note_status';
ALTER TABLE episode_author_notes ADD CONSTRAINT episode_author_notes_episode_fk FOREIGN KEY (novel_id, episode_id) REFERENCES episodes (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE episode_author_notes ADD CONSTRAINT episode_author_notes_session_fk FOREIGN KEY (novel_id, session_id) REFERENCES revision_chat_sessions (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX episode_author_notes_episode_idx ON episode_author_notes (novel_id, episode_id) WHERE status = 'active';

-- 작업 종류 revision_chat_turn(line_editor, 대상 episode): 읽기 전용 한 턴이라 원고 작성 작업 동시 실행 제한에 넣지 않음
ALTER TABLE tasks DROP CONSTRAINT tasks_kind_enum;
ALTER TABLE tasks ADD CONSTRAINT tasks_kind_enum CHECK (kind IN ('concept_turn', 'import_concept', 'check_concept_brief', 'plan_series_bible', 'build_initial_ontology', 'plan_arc', 'plan_setups', 'outline_episode', 'draft_episode', 'extract_facts', 'link_mentions', 'check_continuity', 'check_setups', 'polish_episode', 'split_scenes', 'revise_episode', 'check_text_safety', 'plan_rework', 'interpret_answer', 'apply_answer', 'review_setup_due', 'schedule_episodes', 'grade_question', 'dedupe_entities', 'split_shots', 'build_prompt_ir', 'classify_safety', 'render_prompts', 'generate_character_sheet', 'generate_keyframes', 'generate_illustrations', 'generate_clips', 'assemble_scene_video', 'edit_trailer', 'draft_cast', 'draft_design_sheet', 'plan_structure', 'build_world_ontology', 'resolve_entities', 'adjust_length', 'revision_chat_turn'));

-- 한 화씩 진행: 화별 승인(episode_approval)에서 N화가 승인(또는 공개)돼야 N+1화 아웃라인을 시작합니다. 기존 작품 포함 기본 켬.
-- 플롯별 승인·완전 자율에는 영향이 없고, 자율성 수준(autonomy_level)은 바꾸지 않습니다.
ALTER TABLE novels ADD COLUMN sequential_episodes boolean NOT NULL DEFAULT true;
