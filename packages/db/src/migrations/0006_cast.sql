-- 0006_cast — 캐릭터 설정 단계(module cast, 설계 추가).
-- 컨셉(스토리라인) 승인 뒤 목표·기획서 전에 등장인물을 정합니다: 주인공 정확히 1명, 서브 주인공 0..N명, 적대자·조연 임의.
-- 확정하면 온톨로지 character 엔티티와 승인된 사실(user_input)을 만들고, 기획서·아웃라인·초고 컨텍스트("cast")에 들어갑니다.
-- 캐릭터마다 디자인 시트(외형 스펙)와 이미지 생성 결과(imaging) 연결·대표 이미지를 둡니다.
CREATE TABLE characters (
  id text NOT NULL,
  novel_id text NOT NULL,
  role text NOT NULL,
  CONSTRAINT characters_role_enum CHECK (role IN ('protagonist', 'sub_protagonist', 'antagonist', 'supporting')),
  ord integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft',
  CONSTRAINT characters_status_enum CHECK (status IN ('draft', 'confirmed')),
  name text NOT NULL,
  aliases jsonb NOT NULL DEFAULT '[]',
  age text NOT NULL DEFAULT '',
  gender text NOT NULL DEFAULT '',
  personality text NOT NULL DEFAULT '',
  background text NOT NULL DEFAULT '',
  desire text NOT NULL DEFAULT '',
  weakness text NOT NULL DEFAULT '',
  relationships jsonb NOT NULL DEFAULT '[]',
  notes text NOT NULL DEFAULT '',
  field_origins jsonb NOT NULL DEFAULT '{}',
  proposed boolean NOT NULL DEFAULT false,
  concept_character_key text,
  entity_id text,
  ontology_sync jsonb,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT characters_id_format CHECK (id ~ '^chr_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT characters_tenant_key UNIQUE (novel_id, id),
  CONSTRAINT characters_ck_name CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  CONSTRAINT characters_ck_confirmed CHECK (status <> 'confirmed' OR confirmed_at IS NOT NULL)
);
COMMENT ON COLUMN characters.role IS 'enum:character_role';
COMMENT ON COLUMN characters.status IS 'enum:character_status';
ALTER TABLE characters ADD CONSTRAINT characters_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE characters ADD CONSTRAINT characters_entity_fk FOREIGN KEY (novel_id, entity_id) REFERENCES entities (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
-- 주인공은 작품마다 최대 1명(확정 조건은 정확히 1명 — 앱에서 검사)
CREATE UNIQUE INDEX characters_one_protagonist ON characters (novel_id) WHERE role = 'protagonist';
CREATE INDEX characters_list_idx ON characters (novel_id, ord);

CREATE TABLE character_design_sheets (
  id text NOT NULL,
  novel_id text NOT NULL,
  character_id text NOT NULL,
  spec jsonb NOT NULL DEFAULT '{}',
  field_origins jsonb NOT NULL DEFAULT '{}',
  primary_images jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT character_design_sheets_id_format CHECK (id ~ '^cds_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT character_design_sheets_tenant_key UNIQUE (novel_id, id),
  CONSTRAINT character_design_sheets_character_key UNIQUE (novel_id, character_id)
);
ALTER TABLE character_design_sheets ADD CONSTRAINT character_design_sheets_character_fk FOREIGN KEY (novel_id, character_id) REFERENCES characters (novel_id, id) ON DELETE CASCADE;

CREATE TABLE character_sheet_images (
  id text NOT NULL,
  novel_id text NOT NULL,
  character_id text NOT NULL,
  view text NOT NULL,
  CONSTRAINT character_sheet_images_view_enum CHECK (view IN ('front', 'side', 'back', 'expressions')),
  generation_id text NOT NULL,
  prompt text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT character_sheet_images_id_format CHECK (id ~ '^csi_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT character_sheet_images_tenant_key UNIQUE (novel_id, id),
  CONSTRAINT character_sheet_images_generation_key UNIQUE (generation_id)
);
COMMENT ON COLUMN character_sheet_images.view IS 'enum:character_sheet_view';
ALTER TABLE character_sheet_images ADD CONSTRAINT character_sheet_images_character_fk FOREIGN KEY (novel_id, character_id) REFERENCES characters (novel_id, id) ON DELETE CASCADE;
ALTER TABLE character_sheet_images ADD CONSTRAINT character_sheet_images_generation_fk FOREIGN KEY (generation_id) REFERENCES image_generations (id) ON DELETE CASCADE;
CREATE INDEX character_sheet_images_list_idx ON character_sheet_images (novel_id, character_id, created_at DESC);

-- 작업 종류 draft_cast(concept_partner, 대상 novel) · draft_design_sheet(world_keeper, 대상 character): 목표 전에도 만들 수 있음
ALTER TABLE tasks DROP CONSTRAINT tasks_ck_1;
ALTER TABLE tasks ADD CONSTRAINT tasks_ck_1 CHECK (goal_id IS NOT NULL OR kind IN ('concept_turn', 'import_concept', 'check_concept_brief', 'draft_cast', 'draft_design_sheet') /* INV-CON-08, INV-TSK-01 + cast */);

-- enum 확장: task_kind(+draft_cast, draft_design_sheet), target_type(+character), ref_type(+character)
ALTER TABLE health_check_results DROP CONSTRAINT health_check_results_target_ref_type_enum;
ALTER TABLE health_check_results ADD CONSTRAINT health_check_results_target_ref_type_enum CHECK (target_ref_type IN ('novel', 'goal', 'series_bible', 'arc', 'episode', 'manuscript_version', 'scene', 'shot', 'task', 'run', 'question', 'answer', 'approval', 'channel', 'budget_policy', 'cost_event', 'continuity_issue', 'setup', 'setup_beat', 'entity', 'entity_name', 'mention', 'fact', 'timeline', 'schema_proposal', 'glossary_term', 'identity_decision', 'media_asset', 'scene_prompt_ir', 'media_quote', 'settings', 'concept_session', 'concept_brief', 'concept_message', 'character'));
ALTER TABLE tasks DROP CONSTRAINT tasks_kind_enum;
ALTER TABLE tasks ADD CONSTRAINT tasks_kind_enum CHECK (kind IN ('concept_turn', 'import_concept', 'check_concept_brief', 'plan_series_bible', 'build_initial_ontology', 'plan_arc', 'plan_setups', 'outline_episode', 'draft_episode', 'extract_facts', 'link_mentions', 'check_continuity', 'check_setups', 'polish_episode', 'split_scenes', 'revise_episode', 'check_text_safety', 'plan_rework', 'interpret_answer', 'apply_answer', 'review_setup_due', 'schedule_episodes', 'grade_question', 'dedupe_entities', 'split_shots', 'build_prompt_ir', 'classify_safety', 'render_prompts', 'generate_character_sheet', 'generate_keyframes', 'generate_illustrations', 'generate_clips', 'assemble_scene_video', 'edit_trailer', 'draft_cast', 'draft_design_sheet'));
ALTER TABLE tasks DROP CONSTRAINT tasks_target_type_enum;
ALTER TABLE tasks ADD CONSTRAINT tasks_target_type_enum CHECK (target_type IN ('novel', 'goal', 'arc', 'episode', 'scene', 'shot', 'setup', 'entity', 'question', 'concept_session', 'character'));
ALTER TABLE tasks DROP CONSTRAINT tasks_blocked_ref_type_enum;
ALTER TABLE tasks ADD CONSTRAINT tasks_blocked_ref_type_enum CHECK (blocked_ref_type IN ('novel', 'goal', 'series_bible', 'arc', 'episode', 'manuscript_version', 'scene', 'shot', 'task', 'run', 'question', 'answer', 'approval', 'channel', 'budget_policy', 'cost_event', 'continuity_issue', 'setup', 'setup_beat', 'entity', 'entity_name', 'mention', 'fact', 'timeline', 'schema_proposal', 'glossary_term', 'identity_decision', 'media_asset', 'scene_prompt_ir', 'media_quote', 'settings', 'concept_session', 'concept_brief', 'concept_message', 'character'));
ALTER TABLE wake_requests DROP CONSTRAINT wake_requests_source_ref_type_enum;
ALTER TABLE wake_requests ADD CONSTRAINT wake_requests_source_ref_type_enum CHECK (source_ref_type IN ('novel', 'goal', 'series_bible', 'arc', 'episode', 'manuscript_version', 'scene', 'shot', 'task', 'run', 'question', 'answer', 'approval', 'channel', 'budget_policy', 'cost_event', 'continuity_issue', 'setup', 'setup_beat', 'entity', 'entity_name', 'mention', 'fact', 'timeline', 'schema_proposal', 'glossary_term', 'identity_decision', 'media_asset', 'scene_prompt_ir', 'media_quote', 'settings', 'concept_session', 'concept_brief', 'concept_message', 'character'));
ALTER TABLE question_links DROP CONSTRAINT question_links_ref_type_enum;
ALTER TABLE question_links ADD CONSTRAINT question_links_ref_type_enum CHECK (ref_type IN ('novel', 'goal', 'series_bible', 'arc', 'episode', 'manuscript_version', 'scene', 'shot', 'task', 'run', 'question', 'answer', 'approval', 'channel', 'budget_policy', 'cost_event', 'continuity_issue', 'setup', 'setup_beat', 'entity', 'entity_name', 'mention', 'fact', 'timeline', 'schema_proposal', 'glossary_term', 'identity_decision', 'media_asset', 'scene_prompt_ir', 'media_quote', 'settings', 'concept_session', 'concept_brief', 'concept_message', 'character'));
ALTER TABLE answers DROP CONSTRAINT answers_late_resolution_ref_type_enum;
ALTER TABLE answers ADD CONSTRAINT answers_late_resolution_ref_type_enum CHECK (late_resolution_ref_type IN ('novel', 'goal', 'series_bible', 'arc', 'episode', 'manuscript_version', 'scene', 'shot', 'task', 'run', 'question', 'answer', 'approval', 'channel', 'budget_policy', 'cost_event', 'continuity_issue', 'setup', 'setup_beat', 'entity', 'entity_name', 'mention', 'fact', 'timeline', 'schema_proposal', 'glossary_term', 'identity_decision', 'media_asset', 'scene_prompt_ir', 'media_quote', 'settings', 'concept_session', 'concept_brief', 'concept_message', 'character'));
ALTER TABLE answer_reflection_items DROP CONSTRAINT answer_reflection_items_ref_type_enum;
ALTER TABLE answer_reflection_items ADD CONSTRAINT answer_reflection_items_ref_type_enum CHECK (ref_type IN ('novel', 'goal', 'series_bible', 'arc', 'episode', 'manuscript_version', 'scene', 'shot', 'task', 'run', 'question', 'answer', 'approval', 'channel', 'budget_policy', 'cost_event', 'continuity_issue', 'setup', 'setup_beat', 'entity', 'entity_name', 'mention', 'fact', 'timeline', 'schema_proposal', 'glossary_term', 'identity_decision', 'media_asset', 'scene_prompt_ir', 'media_quote', 'settings', 'concept_session', 'concept_brief', 'concept_message', 'character'));
ALTER TABLE approvals DROP CONSTRAINT approvals_subject_type_enum;
ALTER TABLE approvals ADD CONSTRAINT approvals_subject_type_enum CHECK (subject_type IN ('novel', 'goal', 'series_bible', 'arc', 'episode', 'manuscript_version', 'scene', 'shot', 'task', 'run', 'question', 'answer', 'approval', 'channel', 'budget_policy', 'cost_event', 'continuity_issue', 'setup', 'setup_beat', 'entity', 'entity_name', 'mention', 'fact', 'timeline', 'schema_proposal', 'glossary_term', 'identity_decision', 'media_asset', 'scene_prompt_ir', 'media_quote', 'settings', 'concept_session', 'concept_brief', 'concept_message', 'character'));
ALTER TABLE continuity_issue_evidence DROP CONSTRAINT continuity_issue_evidence_ref_type_enum;
ALTER TABLE continuity_issue_evidence ADD CONSTRAINT continuity_issue_evidence_ref_type_enum CHECK (ref_type IN ('novel', 'goal', 'series_bible', 'arc', 'episode', 'manuscript_version', 'scene', 'shot', 'task', 'run', 'question', 'answer', 'approval', 'channel', 'budget_policy', 'cost_event', 'continuity_issue', 'setup', 'setup_beat', 'entity', 'entity_name', 'mention', 'fact', 'timeline', 'schema_proposal', 'glossary_term', 'identity_decision', 'media_asset', 'scene_prompt_ir', 'media_quote', 'settings', 'concept_session', 'concept_brief', 'concept_message', 'character'));
ALTER TABLE setup_links DROP CONSTRAINT setup_links_ref_type_enum;
ALTER TABLE setup_links ADD CONSTRAINT setup_links_ref_type_enum CHECK (ref_type IN ('novel', 'goal', 'series_bible', 'arc', 'episode', 'manuscript_version', 'scene', 'shot', 'task', 'run', 'question', 'answer', 'approval', 'channel', 'budget_policy', 'cost_event', 'continuity_issue', 'setup', 'setup_beat', 'entity', 'entity_name', 'mention', 'fact', 'timeline', 'schema_proposal', 'glossary_term', 'identity_decision', 'media_asset', 'scene_prompt_ir', 'media_quote', 'settings', 'concept_session', 'concept_brief', 'concept_message', 'character'));
ALTER TABLE activity_log DROP CONSTRAINT activity_log_target_type_enum;
ALTER TABLE activity_log ADD CONSTRAINT activity_log_target_type_enum CHECK (target_type IN ('novel', 'goal', 'series_bible', 'arc', 'episode', 'manuscript_version', 'scene', 'shot', 'task', 'run', 'question', 'answer', 'approval', 'channel', 'budget_policy', 'cost_event', 'continuity_issue', 'setup', 'setup_beat', 'entity', 'entity_name', 'mention', 'fact', 'timeline', 'schema_proposal', 'glossary_term', 'identity_decision', 'media_asset', 'scene_prompt_ir', 'media_quote', 'settings', 'concept_session', 'concept_brief', 'concept_message', 'character'));
ALTER TABLE entity_names DROP CONSTRAINT entity_names_source_ref_type_enum;
ALTER TABLE entity_names ADD CONSTRAINT entity_names_source_ref_type_enum CHECK (source_ref_type IN ('novel', 'goal', 'series_bible', 'arc', 'episode', 'manuscript_version', 'scene', 'shot', 'task', 'run', 'question', 'answer', 'approval', 'channel', 'budget_policy', 'cost_event', 'continuity_issue', 'setup', 'setup_beat', 'entity', 'entity_name', 'mention', 'fact', 'timeline', 'schema_proposal', 'glossary_term', 'identity_decision', 'media_asset', 'scene_prompt_ir', 'media_quote', 'settings', 'concept_session', 'concept_brief', 'concept_message', 'character'));
ALTER TABLE facts DROP CONSTRAINT facts_source_ref_type_enum;
ALTER TABLE facts ADD CONSTRAINT facts_source_ref_type_enum CHECK (source_ref_type IN ('novel', 'goal', 'series_bible', 'arc', 'episode', 'manuscript_version', 'scene', 'shot', 'task', 'run', 'question', 'answer', 'approval', 'channel', 'budget_policy', 'cost_event', 'continuity_issue', 'setup', 'setup_beat', 'entity', 'entity_name', 'mention', 'fact', 'timeline', 'schema_proposal', 'glossary_term', 'identity_decision', 'media_asset', 'scene_prompt_ir', 'media_quote', 'settings', 'concept_session', 'concept_brief', 'concept_message', 'character'));
