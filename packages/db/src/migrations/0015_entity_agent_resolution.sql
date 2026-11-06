-- 0015_entity_agent_resolution — 엔티티 판정 에이전트(설계 추가, module linking·hitl·novel).
-- 원고에서 나온 언급 가운데 대명사·흔한 명사는 엔티티 후보나 질문으로 만들지 않고, 남은 모호한 언급은 world_keeper 판정 에이전트가
-- 기존 엔티티 연결·별칭 추가·새 엔티티·무시·병합 가운데 하나로 정합니다. 신뢰도가 기준 이상이면 바로 적용하고(감사 기록, 되돌릴 수 있음),
-- 기준 미만이면서 중요한 경우만 인박스에 질문으로 올립니다. 작품별 설정(기본 켬)으로 끌 수 있습니다.
ALTER TABLE novels ADD COLUMN entity_agent_resolution boolean NOT NULL DEFAULT true;
ALTER TABLE novels ADD COLUMN entity_agent_min_confidence real NOT NULL DEFAULT 0.75;
ALTER TABLE novels ADD CONSTRAINT novels_ck_entity_agent_min_confidence CHECK (entity_agent_min_confidence >= 0 AND entity_agent_min_confidence <= 1);

-- 에이전트가 처리한 질문은 resolution_source='agent_resolved'로 남습니다(차단형 질문은 questions_ck_4가 그대로 막습니다).
ALTER TABLE questions DROP CONSTRAINT questions_resolution_source_enum;
ALTER TABLE questions ADD CONSTRAINT questions_resolution_source_enum CHECK (resolution_source IN ('user_answer', 'default_applied', 'deadline_hold', 'absence_delegated', 'notice_only', 'auto_answer', 'agent_resolved'));

-- 백로그 정리 작업(resolve_entities, world_keeper). 목표가 없는 작품에서도 열린 질문을 정리할 수 있게 goal_id 없이 만들 수 있습니다.
ALTER TABLE tasks DROP CONSTRAINT tasks_kind_enum;
ALTER TABLE tasks ADD CONSTRAINT tasks_kind_enum CHECK (kind IN ('concept_turn', 'import_concept', 'check_concept_brief', 'plan_series_bible', 'build_initial_ontology', 'plan_arc', 'plan_setups', 'outline_episode', 'draft_episode', 'extract_facts', 'link_mentions', 'check_continuity', 'check_setups', 'polish_episode', 'split_scenes', 'revise_episode', 'check_text_safety', 'plan_rework', 'interpret_answer', 'apply_answer', 'review_setup_due', 'schedule_episodes', 'grade_question', 'dedupe_entities', 'split_shots', 'build_prompt_ir', 'classify_safety', 'render_prompts', 'generate_character_sheet', 'generate_keyframes', 'generate_illustrations', 'generate_clips', 'assemble_scene_video', 'edit_trailer', 'draft_cast', 'draft_design_sheet', 'plan_structure', 'build_world_ontology', 'resolve_entities'));
ALTER TABLE tasks DROP CONSTRAINT tasks_ck_1;
ALTER TABLE tasks ADD CONSTRAINT tasks_ck_1 CHECK (goal_id IS NOT NULL OR kind IN ('concept_turn', 'import_concept', 'check_concept_brief', 'draft_cast', 'draft_design_sheet', 'build_world_ontology', 'resolve_entities') /* INV-CON-08, INV-TSK-01 + cast + world + entity backlog */);

-- 새 엔티티 판별·중복 질문은 판정 에이전트의 판단이 추천안일 때만 민감도 normal로 만듭니다(완전 자율에서 자동 응답 가능).
-- 이미 열린 질문(0014가 high로 올린 행)은 추천안이 링커 1위·"보류"·첫 선택지라서 high로 둡니다. 부팅 때 등록되는
-- resolve_entities 작업이 에이전트 판정으로 처리하고, 확신이 낮고 다툼이 있는 것만 사람에게 남깁니다.
