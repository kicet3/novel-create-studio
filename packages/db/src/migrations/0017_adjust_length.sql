-- 0017_adjust_length — 분량 맞추기 작업(설계 추가, module manuscript).
-- 초고·수정본이 분량 프로필 범위(기본 5,000~5,500자, 최대 +3% 허용)를 벗어나면 writer가 줄이기/늘리기 패스를 돌립니다
-- (최대 2회, 다듬기 뒤 1회 더). 같은 화의 원고 작성 작업과 동시에 돌지 않습니다.
ALTER TABLE tasks DROP CONSTRAINT tasks_kind_enum;
ALTER TABLE tasks ADD CONSTRAINT tasks_kind_enum CHECK (kind IN ('concept_turn', 'import_concept', 'check_concept_brief', 'plan_series_bible', 'build_initial_ontology', 'plan_arc', 'plan_setups', 'outline_episode', 'draft_episode', 'extract_facts', 'link_mentions', 'check_continuity', 'check_setups', 'polish_episode', 'split_scenes', 'revise_episode', 'check_text_safety', 'plan_rework', 'interpret_answer', 'apply_answer', 'review_setup_due', 'schedule_episodes', 'grade_question', 'dedupe_entities', 'split_shots', 'build_prompt_ir', 'classify_safety', 'render_prompts', 'generate_character_sheet', 'generate_keyframes', 'generate_illustrations', 'generate_clips', 'assemble_scene_video', 'edit_trailer', 'draft_cast', 'draft_design_sheet', 'plan_structure', 'build_world_ontology', 'resolve_entities', 'adjust_length'));

DROP INDEX tasks_one_manuscript_writer_per_episode;
CREATE UNIQUE INDEX tasks_one_manuscript_writer_per_episode ON tasks (novel_id, episode_id)
  WHERE status = 'running' AND episode_id IS NOT NULL
    AND kind IN ('outline_episode', 'draft_episode', 'revise_episode', 'polish_episode', 'adjust_length');
