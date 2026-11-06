-- 0008_story_structure — 전체 구성(1~4부 + 결말), 플롯(arcs) 확장, 화 계획 필드, 캐릭터 필수 항목, 분량 하한 3000자.
-- 구성은 작품당 1행(revision으로 개정, goals와 같은 방식)이고 부는 ord 1..4의 고정 4행입니다. 플롯 = arcs(part_id).
CREATE TABLE story_structures (
  id text NOT NULL,
  novel_id text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  CONSTRAINT story_structures_status_enum CHECK (status IN ('draft', 'awaiting_approval', 'approved')),
  revision integer NOT NULL DEFAULT 1,
  approved_revision integer,
  ending jsonb NOT NULL DEFAULT '{}',
  ending_field_origins jsonb NOT NULL DEFAULT '{}',
  first_appearances jsonb NOT NULL DEFAULT '[]',
  pending_changes jsonb NOT NULL DEFAULT '{}',
  approval_id text,
  approved_at timestamptz,
  source_bible_id text,
  model_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT story_structures_id_format CHECK (id ~ '^sst_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT story_structures_tenant_key UNIQUE (novel_id, id),
  CONSTRAINT story_structures_novel_key UNIQUE (novel_id),
  CONSTRAINT story_structures_ck_revision CHECK (revision >= 1),
  CONSTRAINT story_structures_ck_approved CHECK (status <> 'approved' OR (approved_at IS NOT NULL AND approved_revision = revision))
);
COMMENT ON COLUMN story_structures.status IS 'enum:story_structure_status';
ALTER TABLE story_structures ADD CONSTRAINT story_structures_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE story_structures ADD CONSTRAINT story_structures_approval_fk FOREIGN KEY (novel_id, approval_id) REFERENCES approvals (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE story_structures ADD CONSTRAINT story_structures_bible_fk FOREIGN KEY (novel_id, source_bible_id) REFERENCES series_bibles (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;

CREATE TABLE story_parts (
  id text NOT NULL,
  novel_id text NOT NULL,
  structure_id text NOT NULL,
  ord integer NOT NULL,
  title text NOT NULL DEFAULT '',
  goal_text text NOT NULL DEFAULT '',
  turning_points jsonb NOT NULL DEFAULT '[]',
  planned_episode_from integer NOT NULL,
  planned_episode_to integer NOT NULL,
  character_states jsonb NOT NULL DEFAULT '[]',
  plot_outline jsonb NOT NULL DEFAULT '[]',
  field_origins jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT story_parts_id_format CHECK (id ~ '^spt_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT story_parts_tenant_key UNIQUE (novel_id, id),
  CONSTRAINT story_parts_ord_key UNIQUE (novel_id, ord),
  CONSTRAINT story_parts_ck_ord CHECK (ord BETWEEN 1 AND 4),
  CONSTRAINT story_parts_ck_range CHECK (planned_episode_from >= 1 AND planned_episode_to >= planned_episode_from)
);
ALTER TABLE story_parts ADD CONSTRAINT story_parts_structure_fk FOREIGN KEY (novel_id, structure_id) REFERENCES story_structures (novel_id, id) ON DELETE CASCADE;

-- 플롯 = arcs (부에 연결)
ALTER TABLE arcs ADD COLUMN part_id text;
ALTER TABLE arcs ADD COLUMN core_event text NOT NULL DEFAULT '';
ALTER TABLE arcs ADD COLUMN involved_character_ids text[] NOT NULL DEFAULT '{}';
ALTER TABLE arcs ADD COLUMN change_text text NOT NULL DEFAULT '';
ALTER TABLE arcs ADD COLUMN setup_plan jsonb NOT NULL DEFAULT '{}';
ALTER TABLE arcs ADD COLUMN plan_flags text[] NOT NULL DEFAULT '{}';
ALTER TABLE arcs ADD CONSTRAINT arcs_plan_flags_enum CHECK (plan_flags <@ ARRAY['ending_changed', 'part_changed']::text[]);
COMMENT ON COLUMN arcs.plan_flags IS 'enum:arc_plan_flag';
ALTER TABLE arcs ADD CONSTRAINT arcs_part_fk FOREIGN KEY (novel_id, part_id) REFERENCES story_parts (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX arcs_part_idx ON arcs (novel_id, part_id);

-- 화 계획
ALTER TABLE episodes ADD COLUMN plan_summary text NOT NULL DEFAULT '';
ALTER TABLE episodes ADD COLUMN planned_scene_count integer;
ALTER TABLE episodes ADD COLUMN target_chars integer;
ALTER TABLE episodes ADD CONSTRAINT episodes_ck_plan_scenes CHECK (planned_scene_count IS NULL OR planned_scene_count BETWEEN 1 AND 20);
ALTER TABLE episodes ADD CONSTRAINT episodes_ck_target_chars CHECK (target_chars IS NULL OR target_chars >= 3000);

-- 캐릭터 필수 항목·첫 등장
ALTER TABLE characters ADD COLUMN appearance text NOT NULL DEFAULT '';
ALTER TABLE characters ADD COLUMN motivation text NOT NULL DEFAULT '';
ALTER TABLE characters ADD COLUMN speech_sample text NOT NULL DEFAULT '';
ALTER TABLE characters ADD COLUMN arc_start text NOT NULL DEFAULT '';
ALTER TABLE characters ADD COLUMN arc_end text NOT NULL DEFAULT '';
ALTER TABLE characters ADD COLUMN story_role text NOT NULL DEFAULT '';
ALTER TABLE characters ADD COLUMN first_appearance_episode_no integer;
ALTER TABLE characters ADD COLUMN introduced_arc_id text;
ALTER TABLE characters ADD CONSTRAINT characters_ck_first_appearance CHECK (first_appearance_episode_no IS NULL OR first_appearance_episode_no >= 1);
ALTER TABLE characters ADD CONSTRAINT characters_introduced_arc_fk FOREIGN KEY (novel_id, introduced_arc_id) REFERENCES arcs (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX characters_introduced_arc_idx ON characters (novel_id, introduced_arc_id) WHERE introduced_arc_id IS NOT NULL;

-- 분량 하한 3000자 (기본 5000/5500은 그대로)
UPDATE length_profiles SET min_chars = 3000, max_chars = GREATEST(max_chars, 3000) WHERE min_chars < 3000;
ALTER TABLE length_profiles ADD CONSTRAINT length_profiles_ck_min_floor CHECK (min_chars >= 3000);

-- task kind plan_structure (목표 필요 → tasks_ck_1 변경 없음)
ALTER TABLE tasks DROP CONSTRAINT tasks_kind_enum;
ALTER TABLE tasks ADD CONSTRAINT tasks_kind_enum CHECK (kind IN ('concept_turn', 'import_concept', 'check_concept_brief', 'plan_series_bible', 'build_initial_ontology', 'plan_arc', 'plan_setups', 'outline_episode', 'draft_episode', 'extract_facts', 'link_mentions', 'check_continuity', 'check_setups', 'polish_episode', 'split_scenes', 'revise_episode', 'check_text_safety', 'plan_rework', 'interpret_answer', 'apply_answer', 'review_setup_due', 'schedule_episodes', 'grade_question', 'dedupe_entities', 'split_shots', 'build_prompt_ir', 'classify_safety', 'render_prompts', 'generate_character_sheet', 'generate_keyframes', 'generate_illustrations', 'generate_clips', 'assemble_scene_video', 'edit_trailer', 'draft_cast', 'draft_design_sheet', 'plan_structure'));

-- approval_type story_structure (부재 위임 금지)
ALTER TABLE approvals DROP CONSTRAINT approvals_approval_type_enum;
ALTER TABLE approvals ADD CONSTRAINT approvals_approval_type_enum CHECK (approval_type IN ('concept_brief', 'series_bible', 'arc_plan', 'episode', 'arc', 'canon_change', 'retcon', 'ending_change', 'budget_resume', 'setup_abandon', 'publish_batch', 'schema_change', 'identity_change', 'character_sheet', 'media_quote', 'safety_review', 'draft_adoption', 'story_structure'));
ALTER TABLE approvals DROP CONSTRAINT approvals_ck_4;
ALTER TABLE approvals ADD CONSTRAINT approvals_ck_4 CHECK (NOT is_absence_delegated OR approval_type NOT IN ('retcon', 'ending_change', 'budget_resume', 'story_structure') /* INV-APR-03 */);

-- continuity_issue_kind plan_deviation
ALTER TABLE continuity_issues DROP CONSTRAINT continuity_issues_kind_enum;
ALTER TABLE continuity_issues ADD CONSTRAINT continuity_issues_kind_enum CHECK (kind IN ('appearance', 'age', 'relationship', 'ability_rule', 'location_travel', 'death_state', 'character_knowledge', 'identity_leak', 'schema_violation', 'published_canon_conflict', 'answer_constraint', 'human_edit_conflict', 'setup_missing', 'setup_contradiction', 'glossary_spelling', 'safety_age_rating', 'safety_minor_sexual', 'safety_real_person', 'plan_deviation'));

-- plan_deviation evidence = the plot (arc) the episode belongs to
ALTER TABLE continuity_issue_evidence DROP CONSTRAINT continuity_issue_evidence_ck_1;
ALTER TABLE continuity_issue_evidence ADD CONSTRAINT continuity_issue_evidence_ck_1 CHECK (ref_type IN ('fact', 'setup', 'setup_beat', 'answer', 'mention', 'entity_name', 'glossary_term', 'arc'));
