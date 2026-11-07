-- 0019_episode_handoff — 화 사이 이어짐(설계 추가, module manuscript + continuity).
-- 화가 승인되면(또는 다음 화가 이미 시작된 뒤 원고가 바뀌면) continuity_editor가 그 화를 한 번 정리합니다:
--   직전 화 끝 상태(handoff: 장소·시간·등장 인물·몸/마음 상태·열린 행동/훅·마지막 문장) + 3~5줄 줄거리(summary).
-- 다음 화 아웃라인·초고 컨텍스트에 "직전 화 끝 상태"·"지금까지의 줄거리"로 들어가고, 연속성 검사가 N화 첫 장면을 비교합니다.
-- 기존 episode_recaps(layer canon)를 씁니다. 정리 뒤 원본 화 원고가 바뀌면 stale_at을 채우고 새 버전으로 다시 정리합니다.
ALTER TABLE episode_recaps ADD COLUMN handoff jsonb;
ALTER TABLE episode_recaps ADD COLUMN stale_at timestamptz;
CREATE INDEX episode_recaps_episode_idx ON episode_recaps (novel_id, episode_id, created_at);

-- 작업 종류 summarize_episode(continuity_editor, 대상 episode): 원고를 쓰지 않는 읽기 전용 정리라 원고 작성 동시 실행 제한에 넣지 않음
ALTER TABLE tasks DROP CONSTRAINT tasks_kind_enum;
ALTER TABLE tasks ADD CONSTRAINT tasks_kind_enum CHECK (kind IN ('concept_turn', 'import_concept', 'check_concept_brief', 'plan_series_bible', 'build_initial_ontology', 'plan_arc', 'plan_setups', 'outline_episode', 'draft_episode', 'extract_facts', 'link_mentions', 'check_continuity', 'check_setups', 'polish_episode', 'split_scenes', 'revise_episode', 'check_text_safety', 'plan_rework', 'interpret_answer', 'apply_answer', 'review_setup_due', 'schedule_episodes', 'grade_question', 'dedupe_entities', 'split_shots', 'build_prompt_ir', 'classify_safety', 'render_prompts', 'generate_character_sheet', 'generate_keyframes', 'generate_illustrations', 'generate_clips', 'assemble_scene_video', 'edit_trailer', 'draft_cast', 'draft_design_sheet', 'plan_structure', 'build_world_ontology', 'resolve_entities', 'adjust_length', 'revision_chat_turn', 'summarize_episode'));

-- 연속성 이슈 종류 opening_continuity: N화 첫 장면이 N-1화 끝 상태와 이어지지 않음. 근거 = N-1화 원고 버전
ALTER TABLE continuity_issues DROP CONSTRAINT continuity_issues_kind_enum;
ALTER TABLE continuity_issues ADD CONSTRAINT continuity_issues_kind_enum CHECK (kind IN ('appearance', 'age', 'relationship', 'ability_rule', 'location_travel', 'death_state', 'character_knowledge', 'identity_leak', 'schema_violation', 'published_canon_conflict', 'answer_constraint', 'human_edit_conflict', 'setup_missing', 'setup_contradiction', 'glossary_spelling', 'safety_age_rating', 'safety_minor_sexual', 'safety_real_person', 'plan_deviation', 'opening_continuity'));
ALTER TABLE continuity_issue_evidence DROP CONSTRAINT continuity_issue_evidence_ck_1;
ALTER TABLE continuity_issue_evidence ADD CONSTRAINT continuity_issue_evidence_ck_1 CHECK (ref_type IN ('fact', 'setup', 'setup_beat', 'answer', 'mention', 'entity_name', 'glossary_term', 'arc', 'manuscript_version'));
