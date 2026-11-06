-- 0012_world_ontology — 세계관 온톨로지 생성(설계 추가, module world).
-- 컨셉 브리프가 승인되면(N2) world_keeper 작업 build_world_ontology가 브리프(+있으면 캐스트)에서 세력·장소·체계·물건·역사·관계·제약을
-- 온톨로지 후보(entities.status=candidate, facts.canon_status=candidate)로 씁니다. 목표 전에 돌므로 goal_id 없이 만들 수 있습니다.
-- world_ontology_items는 후보 하나(엔티티 + 딸린 사실, 또는 관계 사실 하나)의 분류·출처·검토 상태를 둡니다. 엔티티·사실 자체는 온톨로지 테이블에 있습니다.
ALTER TABLE tasks DROP CONSTRAINT tasks_kind_enum;
ALTER TABLE tasks ADD CONSTRAINT tasks_kind_enum CHECK (kind IN ('concept_turn', 'import_concept', 'check_concept_brief', 'plan_series_bible', 'build_initial_ontology', 'plan_arc', 'plan_setups', 'outline_episode', 'draft_episode', 'extract_facts', 'link_mentions', 'check_continuity', 'check_setups', 'polish_episode', 'split_scenes', 'revise_episode', 'check_text_safety', 'plan_rework', 'interpret_answer', 'apply_answer', 'review_setup_due', 'schedule_episodes', 'grade_question', 'dedupe_entities', 'split_shots', 'build_prompt_ir', 'classify_safety', 'render_prompts', 'generate_character_sheet', 'generate_keyframes', 'generate_illustrations', 'generate_clips', 'assemble_scene_video', 'edit_trailer', 'draft_cast', 'draft_design_sheet', 'plan_structure', 'build_world_ontology'));
ALTER TABLE tasks DROP CONSTRAINT tasks_ck_1;
ALTER TABLE tasks ADD CONSTRAINT tasks_ck_1 CHECK (goal_id IS NOT NULL OR kind IN ('concept_turn', 'import_concept', 'check_concept_brief', 'draft_cast', 'draft_design_sheet', 'build_world_ontology') /* INV-CON-08, INV-TSK-01 + cast + world */);

CREATE TABLE world_ontology_items (
  id text NOT NULL,
  novel_id text NOT NULL,
  kind text NOT NULL,
  CONSTRAINT world_ontology_items_kind_enum CHECK (kind IN ('faction', 'place', 'system', 'object', 'history', 'relation', 'constraint')),
  status text NOT NULL DEFAULT 'pending',
  CONSTRAINT world_ontology_items_status_enum CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
  origin text NOT NULL DEFAULT 'agent',
  CONSTRAINT world_ontology_items_origin_enum CHECK (origin IN ('agent', 'user')),
  user_edited boolean NOT NULL DEFAULT false,
  entity_id text,
  fact_ids text[] NOT NULL DEFAULT '{}',
  task_id text,
  run_id text,
  sources jsonb NOT NULL DEFAULT '[]',
  note text,
  from_brief boolean NOT NULL DEFAULT false,
  held_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT world_ontology_items_id_format CHECK (id ~ '^woi_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT world_ontology_items_tenant_key UNIQUE (novel_id, id),
  CONSTRAINT world_ontology_items_ck_target CHECK (entity_id IS NOT NULL OR cardinality(fact_ids) > 0),
  CONSTRAINT world_ontology_items_ck_relation CHECK ((kind = 'relation') = (entity_id IS NULL))
);
COMMENT ON COLUMN world_ontology_items.kind IS 'enum:world_item_kind';
COMMENT ON COLUMN world_ontology_items.status IS 'enum:world_item_status';
COMMENT ON COLUMN world_ontology_items.origin IS 'enum:world_item_origin';
ALTER TABLE world_ontology_items ADD CONSTRAINT world_ontology_items_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE world_ontology_items ADD CONSTRAINT world_ontology_items_entity_fk FOREIGN KEY (novel_id, entity_id) REFERENCES entities (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX world_ontology_items_novel_idx ON world_ontology_items (novel_id, kind, status);
CREATE UNIQUE INDEX world_ontology_items_entity_uq ON world_ontology_items (novel_id, entity_id) WHERE entity_id IS NOT NULL AND status <> 'superseded' AND status <> 'rejected';
