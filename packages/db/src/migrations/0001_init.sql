-- 0001_init: MVP-α schema (design/03 §3, §6, §7; design/06 §2.4–2.5, §4.5, §5, §6.1; design/11 §5)
-- Conventions:
--   * enums are text + CHECK; every enum column has COMMENT 'enum:<name>' (checked against @ncs/shared ENUMS by test)
--   * IDs: text '<prefix>_<ULID>' with format CHECK (ADR-018)
--   * tenant rules: novel-scoped tables have novel_id NOT NULL, UNIQUE (novel_id, id) and composite FKs (T-1, T-2)
--   * all FKs are DEFERRABLE (INITIALLY IMMEDIATE unless noted) so a tx may SET CONSTRAINTS ... DEFERRED
--   * btree_gist EXCLUDE constraints are created only when the extension is available (runtime requires it,
--     tests on PGlite load it when the contrib is available)

DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS btree_gist;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'btree_gist not available: %', SQLERRM;
END $$;

DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'pg_trgm not available: %', SQLERRM;
END $$;

-- append-only guard for ledger/log/version tables
CREATE FUNCTION ncs_forbid_update() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'table % is append-only (UPDATE forbidden)', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END
$fn$;

-- novel
CREATE TABLE users (
  id text NOT NULL,
  display_name text NOT NULL,
  role text NOT NULL DEFAULT 'owner',
  CONSTRAINT users_role_enum CHECK (role IN ('owner')),
  auth jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT users_id_format CHECK (id ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$')
);

-- novel — novel_id NULL = install preset
CREATE TABLE length_profiles (
  id text NOT NULL,
  novel_id text,
  name text NOT NULL,
  min_chars integer NOT NULL DEFAULT 5000,
  max_chars integer NOT NULL DEFAULT 5500,
  count_basis text NOT NULL DEFAULT 'with_spaces',
  CONSTRAINT length_profiles_count_basis_enum CHECK (count_basis IN ('with_spaces', 'without_spaces')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT length_profiles_id_format CHECK (id ~ '^lpf_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT length_profiles_tenant_key UNIQUE (novel_id, id),
  CONSTRAINT length_profiles_ck_1 CHECK (min_chars > 0 AND max_chars >= min_chars)
);

-- llm
CREATE TABLE provider_profiles (
  id text NOT NULL,
  provider_kind text NOT NULL,
  CONSTRAINT provider_profiles_provider_kind_enum CHECK (provider_kind IN ('llm', 'image', 'video')),
  provider text NOT NULL,
  version_no integer NOT NULL,
  models jsonb NOT NULL DEFAULT '[]',
  price_source_url text NOT NULL,
  verified_at timestamptz NOT NULL,
  retention_policy_url text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT provider_profiles_id_format CHECK (id ~ '^prv_[0-9A-HJKMNP-TV-Z]{26}$'),
  UNIQUE (provider_kind, provider, version_no),
  CONSTRAINT provider_profiles_ck_1 CHECK (version_no >= 1)
);

-- messaging
CREATE TABLE messenger_bots (
  id text NOT NULL,
  kind text NOT NULL,
  CONSTRAINT messenger_bots_kind_enum CHECK (kind IN ('telegram', 'discord', 'slack', 'kakao', 'web')),
  label text NOT NULL,
  token_secret_id text NOT NULL,
  receive_mode text,
  CONSTRAINT messenger_bots_receive_mode_enum CHECK (receive_mode IN ('polling', 'webhook')),
  webhook_secret_id text,
  telegram_update_offset bigint,
  status text NOT NULL DEFAULT 'active',
  CONSTRAINT messenger_bots_status_enum CHECK (status IN ('pending_binding', 'active', 'degraded', 'disconnected', 'revoked')),
  last_connected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT messenger_bots_id_format CHECK (id ~ '^bot_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT messenger_bots_ck_1 CHECK (kind <> 'web'),
  CONSTRAINT messenger_bots_ck_2 CHECK (kind <> 'telegram' OR receive_mode IS NOT NULL),
  CONSTRAINT messenger_bots_ck_3 CHECK (receive_mode IS DISTINCT FROM 'webhook' OR webhook_secret_id IS NOT NULL)
);

-- system — id = secret reference key (free-form, e.g. 'llm.anthropic')
CREATE TABLE secrets (
  id text NOT NULL,
  provider text NOT NULL DEFAULT 'local_encrypted',
  CONSTRAINT secrets_provider_enum CHECK (provider IN ('local_encrypted')),
  label text,
  ciphertext text NOT NULL,
  nonce text NOT NULL,
  auth_tag text NOT NULL,
  key_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

-- system
CREATE TABLE backup_records (
  id text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  CONSTRAINT backup_records_status_enum CHECK (status IN ('running', 'succeeded', 'failed')),
  trigger text NOT NULL,
  CONSTRAINT backup_records_trigger_enum CHECK (trigger IN ('scheduled', 'pre_migration', 'pre_restore', 'manual')),
  mode text NOT NULL DEFAULT 'full',
  CONSTRAINT backup_records_mode_enum CHECK (mode IN ('full', 'files_only')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  storage_key text,
  size_bytes bigint,
  content_hash text,
  app_version text NOT NULL,
  last_migration_id text,
  error_message text,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT backup_records_id_format CHECK (id ~ '^bkp_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT backup_records_ck_1 CHECK (status <> 'succeeded' OR (finished_at IS NOT NULL AND storage_key IS NOT NULL)),
  CONSTRAINT backup_records_ck_2 CHECK (status <> 'failed' OR error_message IS NOT NULL)
);

-- system
CREATE TABLE health_check_results (
  id text NOT NULL,
  novel_id text,
  kind text NOT NULL,
  CONSTRAINT health_check_results_kind_enum CHECK (kind IN ('llm_key', 'bot_token', 'channel_reach', 'database', 'ontology_integrity', 'backup_location', 'storage')),
  status text NOT NULL,
  CONSTRAINT health_check_results_status_enum CHECK (status IN ('pass', 'warn', 'fail')),
  target_ref_type text,
  CONSTRAINT health_check_results_target_ref_type_enum CHECK (target_ref_type IN ('novel', 'goal', 'series_bible', 'arc', 'episode', 'manuscript_version', 'scene', 'shot', 'task', 'run', 'question', 'answer', 'approval', 'channel', 'budget_policy', 'cost_event', 'continuity_issue', 'setup', 'setup_beat', 'entity', 'entity_name', 'mention', 'fact', 'timeline', 'schema_proposal', 'glossary_term', 'identity_decision', 'media_asset', 'scene_prompt_ir', 'media_quote', 'settings', 'concept_session', 'concept_brief', 'concept_message')),
  target_ref_id text,
  message text NOT NULL,
  details jsonb,
  checked_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT health_check_results_id_format CHECK (id ~ '^hck_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT health_check_results_tenant_key UNIQUE (novel_id, id)
);

-- novel
CREATE TABLE novels (
  id text NOT NULL,
  title text NOT NULL,
  genre text NOT NULL DEFAULT '',
  approved_concept_brief_id text,
  category jsonb NOT NULL DEFAULT '{}',
  template_refs jsonb NOT NULL DEFAULT '[]',
  target_audience text,
  age_rating text NOT NULL,
  CONSTRAINT novels_age_rating_enum CHECK (age_rating IN ('all', 'age_12', 'age_15', 'age_19')),
  status text NOT NULL DEFAULT 'concept',
  CONSTRAINT novels_status_enum CHECK (status IN ('concept', 'onboarding', 'planning', 'serializing', 'completed', 'archived')),
  autonomy_level text NOT NULL DEFAULT 'episode_approval',
  CONSTRAINT novels_autonomy_level_enum CHECK (autonomy_level IN ('episode_approval', 'arc_approval', 'full_auto', 'co_writing')),
  question_threshold text NOT NULL DEFAULT 'normal',
  CONSTRAINT novels_question_threshold_enum CHECK (question_threshold IN ('minimal', 'normal', 'detailed')),
  media_autonomy text NOT NULL DEFAULT 'review_all',
  CONSTRAINT novels_media_autonomy_enum CHECK (media_autonomy IN ('review_all', 'quote_only')),
  media_target_basis text NOT NULL DEFAULT 'published',
  CONSTRAINT novels_media_target_basis_enum CHECK (media_target_basis IN ('published', 'approved', 'arc_completed')),
  publish_policy text NOT NULL DEFAULT 'manual',
  CONSTRAINT novels_publish_policy_enum CHECK (publish_policy IN ('manual', 'batch_question', 'scheduled')),
  multi_timeline_enabled boolean NOT NULL DEFAULT false,
  possession_mode_enabled boolean NOT NULL DEFAULT false,
  default_narration_mode text NOT NULL DEFAULT 'third_limited',
  CONSTRAINT novels_default_narration_mode_enum CHECK (default_narration_mode IN ('first_person', 'third_limited', 'third_omniscient')),
  timezone text NOT NULL DEFAULT 'Asia/Seoul',
  length_profile_id text NOT NULL,
  active_schema_version_id text NOT NULL,
  paused_at timestamptz,
  pause_reason text,
  CONSTRAINT novels_pause_reason_enum CHECK (pause_reason IN ('user', 'budget_hard_limit', 'ontology_integrity', 'maintenance')),
  style_preset_asset_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT novels_id_format CHECK (id ~ '^nov_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT novels_ck_1 CHECK (autonomy_level = 'full_auto' OR publish_policy = 'manual'),
  CONSTRAINT novels_ck_2 CHECK (paused_at IS NULL OR pause_reason IS NOT NULL),
  CONSTRAINT novels_ck_3 CHECK (status = 'concept' OR approved_concept_brief_id IS NOT NULL)
);

-- novel
CREATE TABLE goals (
  id text NOT NULL,
  novel_id text NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  total_episodes_min integer NOT NULL,
  total_episodes_max integer,
  cadence_episodes_per_week integer NOT NULL,
  reserve_target_episodes integer NOT NULL DEFAULT 5,
  ending_direction text NOT NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT goals_id_format CHECK (id ~ '^gol_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT goals_tenant_key UNIQUE (novel_id, id),
  UNIQUE (novel_id),
  CONSTRAINT goals_ck_1 CHECK (total_episodes_min >= 1),
  CONSTRAINT goals_ck_2 CHECK (total_episodes_max IS NULL OR total_episodes_max >= total_episodes_min),
  CONSTRAINT goals_ck_3 CHECK (cadence_episodes_per_week >= 1),
  CONSTRAINT goals_ck_4 CHECK (reserve_target_episodes >= 0)
);

-- novel
CREATE TABLE series_bibles (
  id text NOT NULL,
  novel_id text NOT NULL,
  version_no integer NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  CONSTRAINT series_bibles_status_enum CHECK (status IN ('draft', 'awaiting_approval', 'approved', 'superseded')),
  logline text NOT NULL,
  synopsis text NOT NULL,
  content jsonb NOT NULL DEFAULT '{}',
  content_md text NOT NULL,
  author_actor_type text NOT NULL,
  CONSTRAINT series_bibles_author_actor_type_enum CHECK (author_actor_type IN ('user', 'agent', 'system')),
  author_actor_id text NOT NULL,
  concept_brief_id text NOT NULL,
  approval_id text,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT series_bibles_id_format CHECK (id ~ '^bib_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT series_bibles_tenant_key UNIQUE (novel_id, id),
  UNIQUE (novel_id, version_no),
  CONSTRAINT series_bibles_ck_1 CHECK (status <> 'approved' OR approved_at IS NOT NULL),
  CONSTRAINT series_bibles_ck_2 CHECK (version_no >= 1)
);

-- novel
CREATE TABLE arcs (
  id text NOT NULL,
  novel_id text NOT NULL,
  ord integer NOT NULL,
  title text NOT NULL,
  goal_text text NOT NULL,
  conflict_text text NOT NULL,
  end_condition text NOT NULL,
  planned_episode_from integer NOT NULL,
  planned_episode_to integer NOT NULL,
  status text NOT NULL DEFAULT 'planned',
  CONSTRAINT arcs_status_enum CHECK (status IN ('planned', 'plan_awaiting_approval', 'active', 'awaiting_approval', 'completed', 'cancelled')),
  plan_approval_id text,
  arc_approval_id text,
  paused_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT arcs_id_format CHECK (id ~ '^arc_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT arcs_tenant_key UNIQUE (novel_id, id),
  UNIQUE (novel_id, ord),
  CONSTRAINT arcs_ck_1 CHECK (planned_episode_from >= 1 AND planned_episode_to >= planned_episode_from)
);

-- novel
CREATE TABLE notification_policies (
  id text NOT NULL,
  novel_id text NOT NULL,
  quiet_hours_start time,
  quiet_hours_end time,
  urgent_exception_enabled boolean NOT NULL DEFAULT false,
  daily_cap_non_blocking integer NOT NULL DEFAULT 10,
  digest_window_minutes integer NOT NULL DEFAULT 15,
  digest_max_items integer NOT NULL DEFAULT 3,
  deadline_hours_blocking integer NOT NULL DEFAULT 12,
  deadline_hours_non_blocking integer NOT NULL DEFAULT 24,
  reminder_offsets_minutes integer[] NOT NULL DEFAULT '{0,1440}',
  questions_paused boolean NOT NULL DEFAULT false,
  channel_priority text[] NOT NULL DEFAULT '{}',
  daily_summary_time time NOT NULL DEFAULT '08:00',
  absence_mode jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT notification_policies_id_format CHECK (id ~ '^ntp_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT notification_policies_tenant_key UNIQUE (novel_id, id),
  UNIQUE (novel_id)
);

-- novel
CREATE TABLE novel_counters (
  novel_id text NOT NULL,
  counter_kind text NOT NULL,
  CONSTRAINT novel_counters_counter_kind_enum CHECK (counter_kind IN ('question', 'setup', 'continuity_issue', 'task')),
  last_value bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (novel_id, counter_kind),
  CONSTRAINT novel_counters_ck_1 CHECK (last_value >= 0)
);

-- concept
CREATE TABLE concept_sessions (
  id text NOT NULL,
  novel_id text NOT NULL,
  purpose text NOT NULL DEFAULT 'initial',
  CONSTRAINT concept_sessions_purpose_enum CHECK (purpose IN ('initial', 'revision')),
  entry_mode text NOT NULL DEFAULT 'conversation',
  CONSTRAINT concept_sessions_entry_mode_enum CHECK (entry_mode IN ('conversation', 'import', 'direct_input')),
  base_brief_id text,
  status text NOT NULL DEFAULT 'active',
  CONSTRAINT concept_sessions_status_enum CHECK (status IN ('active', 'awaiting_approval', 'paused', 'approved', 'abandoned')),
  stage text NOT NULL DEFAULT 'opening',
  CONSTRAINT concept_sessions_stage_enum CHECK (stage IN ('opening', 'diverging', 'converging', 'confirming')),
  pause_reason text,
  CONSTRAINT concept_sessions_pause_reason_enum CHECK (pause_reason IN ('user', 'idle', 'budget_limit')),
  working_brief jsonb NOT NULL DEFAULT '{}',
  field_flip_counts jsonb NOT NULL DEFAULT '{}',
  agent_turn_count integer NOT NULL DEFAULT 0,
  user_message_count integer NOT NULL DEFAULT 0,
  turn_limit integer NOT NULL DEFAULT 40,
  turn_extension_count integer NOT NULL DEFAULT 0,
  llm_disabled boolean NOT NULL DEFAULT false,
  budget_limit_micros bigint NOT NULL,
  spent_micros bigint NOT NULL DEFAULT 0,
  active_channel_id text NOT NULL,
  in_flight_task_id text,
  question_set_version text NOT NULL DEFAULT 'common@1',
  template_refs jsonb NOT NULL DEFAULT '[]',
  pending_approval_id text,
  approved_brief_id text,
  last_user_message_at timestamptz,
  reminded_at timestamptz,
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT concept_sessions_id_format CHECK (id ~ '^cns_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT concept_sessions_tenant_key UNIQUE (novel_id, id),
  CONSTRAINT concept_sessions_ck_1 CHECK (status <> 'paused' OR pause_reason IS NOT NULL),
  CONSTRAINT concept_sessions_ck_2 CHECK (purpose <> 'revision' OR base_brief_id IS NOT NULL),
  CONSTRAINT concept_sessions_ck_3 CHECK (status <> 'awaiting_approval' OR pending_approval_id IS NOT NULL),
  CONSTRAINT concept_sessions_ck_4 CHECK (status <> 'approved' OR approved_brief_id IS NOT NULL),
  CONSTRAINT concept_sessions_ck_5 CHECK (budget_limit_micros >= 0 AND spent_micros >= 0),
  CONSTRAINT concept_sessions_ck_6 CHECK (turn_extension_count >= 0)
);

-- concept
CREATE TABLE concept_messages (
  id text NOT NULL,
  novel_id text NOT NULL,
  session_id text NOT NULL,
  seq integer NOT NULL,
  author_kind text NOT NULL,
  CONSTRAINT concept_messages_author_kind_enum CHECK (author_kind IN ('user', 'agent', 'system')),
  author_user_id text,
  run_id text,
  channel_id text NOT NULL,
  inbox_id text,
  outbox_id text,
  kind text NOT NULL,
  CONSTRAINT concept_messages_kind_enum CHECK (kind IN ('text', 'option_pick', 'form_edit', 'import_text', 'question', 'notice')),
  body text NOT NULL,
  options jsonb,
  picked_idx integer,
  asked_field_paths text[],
  slot_updates jsonb NOT NULL DEFAULT '[]',
  responds_to_seq integer,
  is_superseded boolean NOT NULL DEFAULT false,
  provider_message_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT concept_messages_id_format CHECK (id ~ '^cnm_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT concept_messages_tenant_key UNIQUE (novel_id, id),
  UNIQUE (novel_id, session_id, seq),
  CONSTRAINT concept_messages_ck_1 CHECK (author_kind <> 'user' OR author_user_id IS NOT NULL),
  CONSTRAINT concept_messages_ck_2 CHECK (author_kind <> 'agent' OR run_id IS NOT NULL),
  CONSTRAINT concept_messages_ck_3 CHECK (seq >= 1)
);

-- concept
CREATE TABLE concept_briefs (
  id text NOT NULL,
  novel_id text NOT NULL,
  session_id text NOT NULL,
  version_no integer NOT NULL,
  status text NOT NULL DEFAULT 'awaiting_approval',
  CONSTRAINT concept_briefs_status_enum CHECK (status IN ('awaiting_approval', 'approved', 'approved_direction', 'rejected', 'superseded')),
  approval_id text,
  approved_at timestamptz,
  supersedes_id text,
  author_actor_type text NOT NULL,
  CONSTRAINT concept_briefs_author_actor_type_enum CHECK (author_actor_type IN ('user', 'agent', 'system')),
  author_actor_id text NOT NULL,
  entry_mode text NOT NULL,
  CONSTRAINT concept_briefs_entry_mode_enum CHECK (entry_mode IN ('conversation', 'import', 'direct_input')),
  question_set_version text NOT NULL,
  template_refs jsonb NOT NULL DEFAULT '[]',
  template_overrides jsonb NOT NULL DEFAULT '[]',
  content jsonb NOT NULL,
  content_md text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT concept_briefs_id_format CHECK (id ~ '^cbf_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT concept_briefs_tenant_key UNIQUE (novel_id, id),
  UNIQUE (novel_id, version_no),
  CONSTRAINT concept_briefs_ck_1 CHECK (status NOT IN ('approved', 'approved_direction') OR (approval_id IS NOT NULL AND approved_at IS NOT NULL)),
  CONSTRAINT concept_briefs_ck_2 CHECK (version_no >= 1)
);

-- manuscript
CREATE TABLE episodes (
  id text NOT NULL,
  novel_id text NOT NULL,
  arc_id text NOT NULL,
  episode_no integer NOT NULL,
  title text,
  status text NOT NULL DEFAULT 'planned',
  CONSTRAINT episodes_status_enum CHECK (status IN ('planned', 'outlining', 'drafting', 'checking', 'polishing', 'awaiting_approval', 'revising', 'approved', 'published')),
  block_reasons text[] NOT NULL DEFAULT '{}',
  CONSTRAINT episodes_block_reasons_enum CHECK (block_reasons <@ ARRAY['question', 'approval', 'budget', 'continuity_issue', 'setup_check', 'extraction_failure', 'rewrite_limit', 'provider_unavailable']::text[]),
  paused_at timestamptz,
  primary_timeline_id text NOT NULL,
  outline_version_id text,
  current_version_id text,
  approved_version_id text,
  published_version_id text,
  rejection_count integer NOT NULL DEFAULT 0,
  auto_rewrite_count integer NOT NULL DEFAULT 0,
  last_rework_from text,
  CONSTRAINT episodes_last_rework_from_enum CHECK (last_rework_from IN ('outline', 'draft', 'polish')),
  hook_note text,
  approved_at timestamptz,
  approved_by_actor_type text,
  CONSTRAINT episodes_approved_by_actor_type_enum CHECK (approved_by_actor_type IN ('user', 'agent', 'system')),
  approved_by_actor_id text,
  published_at timestamptz,
  published_by_actor_type text,
  CONSTRAINT episodes_published_by_actor_type_enum CHECK (published_by_actor_type IN ('user', 'agent', 'system')),
  published_by_actor_id text,
  scheduled_publish_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT episodes_id_format CHECK (id ~ '^epi_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT episodes_tenant_key UNIQUE (novel_id, id),
  UNIQUE (novel_id, episode_no),
  CONSTRAINT episodes_ck_1 CHECK (episode_no >= 1),
  CONSTRAINT episodes_ck_2 CHECK (rejection_count >= 0 AND auto_rewrite_count >= 0),
  CONSTRAINT episodes_ck_3 CHECK (status NOT IN ('approved', 'published') OR (approved_at IS NOT NULL AND approved_version_id IS NOT NULL AND approved_by_actor_type IS NOT NULL AND approved_by_actor_id IS NOT NULL)),
  CONSTRAINT episodes_ck_4 CHECK (status <> 'published' OR (published_at IS NOT NULL AND published_version_id IS NOT NULL AND published_version_id = approved_version_id AND published_by_actor_type IS NOT NULL AND published_by_actor_id IS NOT NULL))
);

-- manuscript
CREATE TABLE manuscript_versions (
  id text NOT NULL,
  novel_id text NOT NULL,
  episode_id text NOT NULL,
  version_no integer NOT NULL,
  kind text NOT NULL,
  CONSTRAINT manuscript_versions_kind_enum CHECK (kind IN ('outline', 'draft', 'revision', 'final')),
  parent_version_id text,
  stage text NOT NULL,
  CONSTRAINT manuscript_versions_stage_enum CHECK (stage IN ('planned', 'outlining', 'drafting', 'checking', 'polishing', 'awaiting_approval', 'revising', 'approved', 'published')),
  content text NOT NULL,
  outline_data jsonb,
  char_count_with_spaces integer NOT NULL,
  char_count_without_spaces integer NOT NULL,
  content_hash text NOT NULL,
  author_actor_type text NOT NULL,
  CONSTRAINT manuscript_versions_author_actor_type_enum CHECK (author_actor_type IN ('user', 'agent', 'system')),
  author_actor_id text NOT NULL,
  agent_role text,
  CONSTRAINT manuscript_versions_agent_role_enum CHECK (agent_role IN ('concept_partner', 'showrunner', 'planner', 'world_keeper', 'writer', 'continuity_editor', 'foreshadow_manager', 'line_editor', 'scene_director', 'visual_producer')),
  model_id text,
  run_id text,
  is_human_edit boolean NOT NULL DEFAULT false,
  is_fallback_model boolean NOT NULL DEFAULT false,
  attribution_spans jsonb NOT NULL DEFAULT '[]',
  writer_annotations jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT manuscript_versions_id_format CHECK (id ~ '^mnv_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT manuscript_versions_tenant_key UNIQUE (novel_id, id),
  UNIQUE (novel_id, episode_id, version_no),
  CONSTRAINT manuscript_versions_ck_1 CHECK (version_no >= 1),
  CONSTRAINT manuscript_versions_ck_2 CHECK (kind <> 'outline' OR outline_data IS NOT NULL),
  CONSTRAINT manuscript_versions_ck_3 CHECK (author_actor_type <> 'agent' OR (agent_role IS NOT NULL AND model_id IS NOT NULL AND run_id IS NOT NULL)),
  CONSTRAINT manuscript_versions_ck_4 CHECK (char_count_with_spaces >= 0 AND char_count_without_spaces >= 0)
);

-- manuscript
CREATE TABLE episode_rejections (
  id text NOT NULL,
  novel_id text NOT NULL,
  episode_id text NOT NULL,
  rejection_no integer NOT NULL,
  approval_id text NOT NULL,
  from_version_id text NOT NULL,
  reason text NOT NULL,
  rework_from text NOT NULL,
  CONSTRAINT episode_rejections_rework_from_enum CHECK (rework_from IN ('outline', 'draft', 'polish')),
  rejected_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT episode_rejections_id_format CHECK (id ~ '^erj_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT episode_rejections_tenant_key UNIQUE (novel_id, id),
  UNIQUE (novel_id, episode_id, rejection_no),
  CONSTRAINT episode_rejections_ck_1 CHECK (rejection_no >= 1)
);

-- manuscript
CREATE TABLE scenes (
  id text NOT NULL,
  novel_id text NOT NULL,
  episode_id text NOT NULL,
  ord integer NOT NULL,
  status text NOT NULL DEFAULT 'active',
  CONSTRAINT scenes_status_enum CHECK (status IN ('active', 'retired')),
  manuscript_version_id text NOT NULL,
  char_start integer NOT NULL,
  char_end integer NOT NULL,
  story_point integer NOT NULL,
  timeline_id text NOT NULL,
  location_entity_id text,
  pov_entity_id text,
  narration_mode text,
  CONSTRAINT scenes_narration_mode_enum CHECK (narration_mode IN ('first_person', 'third_limited', 'third_omniscient')),
  summary text NOT NULL,
  boundary_revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT scenes_id_format CHECK (id ~ '^scn_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT scenes_tenant_key UNIQUE (novel_id, id),
  CONSTRAINT scenes_ck_1 CHECK (ord BETWEEN 1 AND 999),
  CONSTRAINT scenes_ck_2 CHECK (char_start >= 0 AND char_end >= char_start),
  CONSTRAINT scenes_ck_3 CHECK (story_point >= 0)
);

-- manuscript
CREATE TABLE scene_participants (
  novel_id text NOT NULL,
  scene_id text NOT NULL,
  entity_id text NOT NULL,
  participation text NOT NULL,
  CONSTRAINT scene_participants_participation_enum CHECK (participation IN ('present', 'mentioned', 'flashback')),
  mention_count integer NOT NULL DEFAULT 0,
  first_mention_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (novel_id, scene_id, entity_id)
);

-- manuscript
CREATE TABLE episode_recaps (
  id text NOT NULL,
  novel_id text NOT NULL,
  episode_id text NOT NULL,
  source_version_id text NOT NULL,
  layer text NOT NULL,
  CONSTRAINT episode_recaps_layer_enum CHECK (layer IN ('canon', 'reader')),
  pov_entity_id text,
  summary text NOT NULL,
  prefilter_result jsonb,
  created_by_run_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT episode_recaps_id_format CHECK (id ~ '^rcp_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT episode_recaps_tenant_key UNIQUE (novel_id, id),
  CONSTRAINT episode_recaps_ck_1 CHECK (layer <> 'reader' OR prefilter_result IS NOT NULL),
  CONSTRAINT episode_recaps_ck_2 CHECK (layer <> 'canon' OR pov_entity_id IS NULL)
);

-- orchestration
CREATE TABLE tasks (
  id text NOT NULL,
  novel_id text NOT NULL,
  display_no integer NOT NULL,
  kind text NOT NULL,
  CONSTRAINT tasks_kind_enum CHECK (kind IN ('concept_turn', 'import_concept', 'check_concept_brief', 'plan_series_bible', 'build_initial_ontology', 'plan_arc', 'plan_setups', 'outline_episode', 'draft_episode', 'extract_facts', 'link_mentions', 'check_continuity', 'check_setups', 'polish_episode', 'split_scenes', 'revise_episode', 'check_text_safety', 'plan_rework', 'interpret_answer', 'apply_answer', 'review_setup_due', 'schedule_episodes', 'grade_question', 'dedupe_entities', 'split_shots', 'build_prompt_ir', 'classify_safety', 'render_prompts', 'generate_character_sheet', 'generate_keyframes', 'generate_illustrations', 'generate_clips', 'assemble_scene_video', 'edit_trailer')),
  agent_role text NOT NULL,
  CONSTRAINT tasks_agent_role_enum CHECK (agent_role IN ('concept_partner', 'showrunner', 'planner', 'world_keeper', 'writer', 'continuity_editor', 'foreshadow_manager', 'line_editor', 'scene_director', 'visual_producer')),
  target_type text NOT NULL,
  CONSTRAINT tasks_target_type_enum CHECK (target_type IN ('novel', 'goal', 'arc', 'episode', 'scene', 'shot', 'setup', 'entity', 'question', 'concept_session')),
  target_id text NOT NULL,
  goal_id text,
  arc_id text,
  episode_id text,
  parent_task_id text,
  status text NOT NULL DEFAULT 'pending',
  CONSTRAINT tasks_status_enum CHECK (status IN ('pending', 'ready', 'running', 'blocked', 'done', 'failed', 'cancelled')),
  priority integer NOT NULL DEFAULT 0,
  block_reason text,
  CONSTRAINT tasks_block_reason_enum CHECK (block_reason IN ('question', 'approval', 'budget', 'budget_reservation_wait', 'provider_unavailable', 'rewrite_limit', 'continuity_issue')),
  blocked_ref_type text,
  CONSTRAINT tasks_blocked_ref_type_enum CHECK (blocked_ref_type IN ('novel', 'goal', 'series_bible', 'arc', 'episode', 'manuscript_version', 'scene', 'shot', 'task', 'run', 'question', 'answer', 'approval', 'channel', 'budget_policy', 'cost_event', 'continuity_issue', 'setup', 'setup_beat', 'entity', 'entity_name', 'mention', 'fact', 'timeline', 'schema_proposal', 'glossary_term', 'identity_decision', 'media_asset', 'scene_prompt_ir', 'media_quote', 'settings', 'concept_session', 'concept_brief', 'concept_message')),
  blocked_ref_id text,
  paused_at timestamptz,
  lease_run_id text,
  lease_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  not_before_at timestamptz,
  input jsonb NOT NULL DEFAULT '{}',
  output_refs jsonb,
  superseded_by_task_id text,
  created_by_actor_type text NOT NULL,
  CONSTRAINT tasks_created_by_actor_type_enum CHECK (created_by_actor_type IN ('user', 'agent', 'system')),
  created_by_actor_id text NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT tasks_id_format CHECK (id ~ '^tsk_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT tasks_tenant_key UNIQUE (novel_id, id),
  UNIQUE (novel_id, display_no),
  CONSTRAINT tasks_ck_1 CHECK (goal_id IS NOT NULL OR kind IN ('concept_turn', 'import_concept', 'check_concept_brief') /* INV-CON-08, INV-TSK-01 */),
  CONSTRAINT tasks_ck_2 CHECK (kind NOT IN ('concept_turn', 'import_concept', 'check_concept_brief') OR target_type = 'concept_session'),
  CONSTRAINT tasks_ck_3 CHECK (status <> 'blocked' OR block_reason IS NOT NULL),
  CONSTRAINT tasks_ck_4 CHECK (lease_run_id IS NULL OR lease_expires_at IS NOT NULL),
  CONSTRAINT tasks_ck_5 CHECK (attempt_count >= 0 AND attempt_count <= max_attempts /* INV-TSK-04 */)
);

-- orchestration
CREATE TABLE task_dependencies (
  novel_id text NOT NULL,
  task_id text NOT NULL,
  depends_on_task_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (novel_id, task_id, depends_on_task_id),
  CONSTRAINT task_dependencies_ck_1 CHECK (task_id <> depends_on_task_id)
);

-- orchestration
CREATE TABLE wake_requests (
  id text NOT NULL,
  novel_id text NOT NULL,
  task_id text,
  reason text NOT NULL,
  CONSTRAINT wake_requests_reason_enum CHECK (reason IN ('schedule', 'task_created', 'dependency_done', 'question_answered', 'approval_decided', 'budget_resumed', 'budget_released', 'user_resume', 'retry', 'reclaim')),
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  CONSTRAINT wake_requests_status_enum CHECK (status IN ('pending', 'claimed', 'coalesced', 'discarded')),
  not_before_at timestamptz,
  coalesced_into_id text,
  claimed_run_id text,
  source_ref_type text,
  CONSTRAINT wake_requests_source_ref_type_enum CHECK (source_ref_type IN ('novel', 'goal', 'series_bible', 'arc', 'episode', 'manuscript_version', 'scene', 'shot', 'task', 'run', 'question', 'answer', 'approval', 'channel', 'budget_policy', 'cost_event', 'continuity_issue', 'setup', 'setup_beat', 'entity', 'entity_name', 'mention', 'fact', 'timeline', 'schema_proposal', 'glossary_term', 'identity_decision', 'media_asset', 'scene_prompt_ir', 'media_quote', 'settings', 'concept_session', 'concept_brief', 'concept_message')),
  source_ref_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT wake_requests_id_format CHECK (id ~ '^wak_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT wake_requests_tenant_key UNIQUE (novel_id, id),
  UNIQUE (novel_id, idempotency_key),
  CONSTRAINT wake_requests_ck_1 CHECK (status <> 'coalesced' OR coalesced_into_id IS NOT NULL)
);

-- orchestration
CREATE TABLE runs (
  id text NOT NULL,
  novel_id text NOT NULL,
  task_id text NOT NULL,
  wake_request_id text NOT NULL,
  agent_role text NOT NULL,
  CONSTRAINT runs_agent_role_enum CHECK (agent_role IN ('concept_partner', 'showrunner', 'planner', 'world_keeper', 'writer', 'continuity_editor', 'foreshadow_manager', 'line_editor', 'scene_director', 'visual_producer')),
  status text NOT NULL DEFAULT 'queued',
  CONSTRAINT runs_status_enum CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted')),
  stop_reason text,
  CONSTRAINT runs_stop_reason_enum CHECK (stop_reason IN ('completed', 'paused', 'cancelled_by_user', 'budget_blocked', 'awaiting_human', 'lease_lost', 'error', 'superseded')),
  error_family text,
  CONSTRAINT runs_error_family_enum CHECK (error_family IN ('provider_unavailable', 'auth_failed', 'quota_exhausted', 'rate_limited', 'content_filtered', 'invalid_output', 'timeout', 'budget_blocked', 'internal')),
  error_message text,
  prompt_template_version text NOT NULL,
  models_used jsonb NOT NULL DEFAULT '[]',
  context_snapshot_id text,
  started_at timestamptz,
  heartbeat_at timestamptz,
  finished_at timestamptz,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cost_micros bigint NOT NULL DEFAULT 0,
  rerun_of_run_id text,
  safe_point_seq integer NOT NULL DEFAULT 0,
  log_storage_key text,
  output_summary jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT runs_id_format CHECK (id ~ '^run_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT runs_tenant_key UNIQUE (novel_id, id),
  CONSTRAINT runs_ck_1 CHECK (status NOT IN ('succeeded', 'failed', 'cancelled', 'interrupted') OR stop_reason IS NOT NULL)
);

-- agents
CREATE TABLE context_snapshots (
  id text NOT NULL,
  novel_id text NOT NULL,
  run_id text NOT NULL,
  story_point integer,
  timeline_id text,
  concept_message_ids text[] NOT NULL DEFAULT '{}',
  pov_entity_id text,
  fact_version_ids text[] NOT NULL DEFAULT '{}',
  candidate_fact_version_ids text[] NOT NULL DEFAULT '{}',
  constraint_fact_ids text[] NOT NULL DEFAULT '{}',
  setup_ids text[] NOT NULL DEFAULT '{}',
  answer_ids text[] NOT NULL DEFAULT '{}',
  entity_ids text[] NOT NULL DEFAULT '{}',
  entity_name_ids text[] NOT NULL DEFAULT '{}',
  schema_version_id text NOT NULL,
  episode_recap_ids text[] NOT NULL DEFAULT '{}',
  provisional_question_ids text[] NOT NULL DEFAULT '{}',
  cloned_from_snapshot_id text,
  token_estimate integer NOT NULL,
  build_ms integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT context_snapshots_id_format CHECK (id ~ '^ctx_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT context_snapshots_tenant_key UNIQUE (novel_id, id)
);

-- llm
CREATE TABLE role_model_bindings (
  id text NOT NULL,
  novel_id text NOT NULL,
  agent_role text NOT NULL,
  CONSTRAINT role_model_bindings_agent_role_enum CHECK (agent_role IN ('concept_partner', 'showrunner', 'planner', 'world_keeper', 'writer', 'continuity_editor', 'foreshadow_manager', 'line_editor', 'scene_director', 'visual_producer')),
  provider_profile_id text NOT NULL,
  model_id text NOT NULL,
  max_output_tokens integer NOT NULL,
  fallback_model_id text,
  fallback_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT role_model_bindings_id_format CHECK (id ~ '^rmb_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT role_model_bindings_tenant_key UNIQUE (novel_id, id),
  UNIQUE (novel_id, agent_role),
  CONSTRAINT role_model_bindings_ck_1 CHECK (max_output_tokens > 0)
);

-- llm
CREATE TABLE provider_calls (
  id text NOT NULL,
  novel_id text NOT NULL,
  run_id text NOT NULL,
  seq integer NOT NULL,
  provider_kind text NOT NULL,
  CONSTRAINT provider_calls_provider_kind_enum CHECK (provider_kind IN ('llm', 'image', 'video')),
  provider text NOT NULL,
  model_id text NOT NULL,
  model_version text,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  max_output_tokens integer,
  max_cost_micros bigint NOT NULL,
  reservation_id text NOT NULL,
  status text NOT NULL DEFAULT 'prepared',
  CONSTRAINT provider_calls_status_enum CHECK (status IN ('prepared', 'sent', 'responded', 'failed', 'unknown', 'responded_late', 'abandoned')),
  response_storage_key text,
  response jsonb,
  usage jsonb,
  error_family text,
  CONSTRAINT provider_calls_error_family_enum CHECK (error_family IN ('provider_unavailable', 'auth_failed', 'quota_exhausted', 'rate_limited', 'content_filtered', 'invalid_output', 'timeout', 'budget_blocked', 'internal')),
  retry_of_call_id text,
  sent_at timestamptz,
  responded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT provider_calls_id_format CHECK (id ~ '^pcl_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT provider_calls_tenant_key UNIQUE (novel_id, id),
  UNIQUE (novel_id, idempotency_key),
  UNIQUE (novel_id, run_id, seq),
  CONSTRAINT provider_calls_ck_1 CHECK (provider_kind <> 'llm' OR max_output_tokens IS NOT NULL),
  CONSTRAINT provider_calls_ck_2 CHECK (status NOT IN ('responded', 'responded_late') OR response IS NOT NULL OR response_storage_key IS NOT NULL),
  CONSTRAINT provider_calls_ck_3 CHECK (max_cost_micros >= 0)
);

-- budget
CREATE TABLE budget_policies (
  id text NOT NULL,
  novel_id text NOT NULL,
  category text NOT NULL,
  CONSTRAINT budget_policies_category_enum CHECK (category IN ('all', 'text', 'image', 'video')),
  budget_window text NOT NULL DEFAULT 'calendar_month',
  CONSTRAINT budget_policies_budget_window_enum CHECK (budget_window IN ('calendar_month', 'lifetime')),
  hard_limit_micros bigint NOT NULL,
  soft_warn_ratio numeric(3,2) NOT NULL DEFAULT 0.80,
  hard_stop_enabled boolean NOT NULL DEFAULT true,
  unpriced_usage_policy text NOT NULL DEFAULT 'block',
  CONSTRAINT budget_policies_unpriced_usage_policy_enum CHECK (unpriced_usage_policy IN ('block', 'require_approval')),
  status text NOT NULL DEFAULT 'ok',
  CONSTRAINT budget_policies_status_enum CHECK (status IN ('ok', 'warning', 'hard_stopped')),
  window_started_at timestamptz NOT NULL,
  resume_approval_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT budget_policies_id_format CHECK (id ~ '^bgp_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT budget_policies_tenant_key UNIQUE (novel_id, id),
  UNIQUE (novel_id, category, budget_window),
  CONSTRAINT budget_policies_ck_1 CHECK (hard_limit_micros >= 0),
  CONSTRAINT budget_policies_ck_2 CHECK (soft_warn_ratio >= 0 AND soft_warn_ratio <= 1)
);

-- budget
CREATE TABLE budget_reservations (
  id text NOT NULL,
  novel_id text NOT NULL,
  run_id text NOT NULL,
  provider_call_id text,
  category text NOT NULL,
  CONSTRAINT budget_reservations_category_enum CHECK (category IN ('text', 'image', 'video')),
  amount_micros bigint NOT NULL,
  status text NOT NULL DEFAULT 'active',
  CONSTRAINT budget_reservations_status_enum CHECK (status IN ('active', 'settled', 'released', 'unknown_closed')),
  settled_cost_event_id text,
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT budget_reservations_id_format CHECK (id ~ '^rsv_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT budget_reservations_tenant_key UNIQUE (novel_id, id),
  CONSTRAINT budget_reservations_ck_1 CHECK (amount_micros >= 0),
  CONSTRAINT budget_reservations_ck_2 CHECK (status = 'active' OR settled_at IS NOT NULL),
  CONSTRAINT budget_reservations_ck_3 CHECK (status <> 'settled' OR settled_cost_event_id IS NOT NULL)
);

-- budget
CREATE TABLE cost_events (
  id text NOT NULL,
  novel_id text NOT NULL,
  idempotency_key text NOT NULL,
  provider_call_id text,
  adjusts_cost_event_id text,
  run_id text,
  task_id text,
  agent_role text,
  CONSTRAINT cost_events_agent_role_enum CHECK (agent_role IN ('concept_partner', 'showrunner', 'planner', 'world_keeper', 'writer', 'continuity_editor', 'foreshadow_manager', 'line_editor', 'scene_director', 'visual_producer')),
  arc_id text,
  episode_id text,
  scene_id text,
  shot_id text,
  category text NOT NULL,
  CONSTRAINT cost_events_category_enum CHECK (category IN ('text', 'image', 'video')),
  provider text NOT NULL,
  model_id text NOT NULL,
  provider_profile_id text NOT NULL,
  provider_profile_version integer NOT NULL,
  cost_basis text NOT NULL,
  CONSTRAINT cost_events_cost_basis_enum CHECK (cost_basis IN ('measured', 'estimated', 'unknown')),
  amount_micros bigint NOT NULL,
  reserved_micros bigint NOT NULL DEFAULT 0,
  overrun_micros bigint NOT NULL DEFAULT 0,
  input_tokens bigint,
  output_tokens bigint,
  cached_tokens bigint,
  units jsonb,
  is_rerun boolean NOT NULL DEFAULT false,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT cost_events_id_format CHECK (id ~ '^cst_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT cost_events_tenant_key UNIQUE (novel_id, id),
  UNIQUE (novel_id, idempotency_key),
  CONSTRAINT cost_events_ck_1 CHECK (amount_micros >= 0 OR adjusts_cost_event_id IS NOT NULL /* negative only for correction rows */),
  CONSTRAINT cost_events_ck_2 CHECK (reserved_micros >= 0 AND overrun_micros >= 0),
  CONSTRAINT cost_events_ck_3 CHECK (provider_call_id IS NULL OR run_id IS NOT NULL)
);

-- hitl
CREATE TABLE questions (
  id text NOT NULL,
  novel_id text NOT NULL,
  display_no integer NOT NULL,
  grade text NOT NULL,
  CONSTRAINT questions_grade_enum CHECK (grade IN ('blocking', 'non_blocking', 'informational')),
  question_type text NOT NULL,
  CONSTRAINT questions_question_type_enum CHECK (question_type IN ('single_choice', 'multi_choice', 'free_text', 'approve_reject', 'attachment_review')),
  topic text NOT NULL,
  CONSTRAINT questions_topic_enum CHECK (topic IN ('direction', 'bible_confirm', 'character_fate', 'creative_choice', 'setup_due', 'setup_abandon', 'entity_disambiguation', 'duplicate_entity', 'identity_change', 'schema_change', 'interpretation_confirm', 'followup', 'approval_gate', 'rewrite_limit', 'extraction_failure', 'budget', 'provider_outage', 'retcon', 'late_answer_conflict', 'publish_batch', 'concept_confirm', 'media_gate', 'safety_review')),
  status text NOT NULL DEFAULT 'pending',
  CONSTRAINT questions_status_enum CHECK (status IN ('pending', 'open', 'answered', 'defaulted', 'resolved', 'cancelled')),
  title text NOT NULL,
  body text NOT NULL,
  recommendation jsonb,
  rationale text NOT NULL,
  blocking_basis text NOT NULL,
  CONSTRAINT questions_blocking_basis_enum CHECK (blocking_basis IN ('ending_direction', 'arc_goal', 'canon_change', 'major_character_fate', 'budget', 'published_canon', 'approval_gate', 'rewrite_limit', 'setup_due_high', 'safety_review', 'system_failure', 'none')),
  grade_reason text NOT NULL,
  deadline_at timestamptz,
  reminder_count integer NOT NULL DEFAULT 0,
  last_reminded_at timestamptz,
  asked_by_role text,
  CONSTRAINT questions_asked_by_role_enum CHECK (asked_by_role IN ('concept_partner', 'showrunner', 'planner', 'world_keeper', 'writer', 'continuity_editor', 'foreshadow_manager', 'line_editor', 'scene_director', 'visual_producer')),
  created_by_run_id text,
  approval_id text,
  parent_question_id text,
  depends_on_question_id text,
  digest_batch_id text,
  accepted_answer_id text,
  resolution_source text,
  CONSTRAINT questions_resolution_source_enum CHECK (resolution_source IN ('user_answer', 'default_applied', 'deadline_hold', 'absence_delegated', 'notice_only')),
  sent_at timestamptz,
  answered_at timestamptz,
  resolved_at timestamptz,
  cancelled_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT questions_id_format CHECK (id ~ '^qst_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT questions_tenant_key UNIQUE (novel_id, id),
  UNIQUE (novel_id, display_no),
  CONSTRAINT questions_ck_1 CHECK ((blocking_basis <> 'none') = (grade = 'blocking') /* INV-Q-01 */),
  CONSTRAINT questions_ck_2 CHECK (grade = 'informational' OR (recommendation IS NOT NULL AND deadline_at IS NOT NULL)),
  CONSTRAINT questions_ck_3 CHECK (status NOT IN ('defaulted', 'resolved') OR resolution_source IS NOT NULL),
  CONSTRAINT questions_ck_4 CHECK (grade <> 'blocking' OR resolution_source IS NULL OR resolution_source IN ('user_answer', 'absence_delegated') /* INV-Q-02 fail-closed */),
  CONSTRAINT questions_ck_5 CHECK (status <> 'cancelled' OR cancelled_reason IS NOT NULL)
);

-- hitl
CREATE TABLE question_options (
  novel_id text NOT NULL,
  question_id text NOT NULL,
  idx integer NOT NULL,
  label text NOT NULL,
  value jsonb,
  is_recommended boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (novel_id, question_id, idx),
  CONSTRAINT question_options_ck_1 CHECK (idx >= 0)
);

-- hitl
CREATE TABLE question_links (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  novel_id text NOT NULL,
  question_id text NOT NULL,
  ref_type text NOT NULL,
  CONSTRAINT question_links_ref_type_enum CHECK (ref_type IN ('novel', 'goal', 'series_bible', 'arc', 'episode', 'manuscript_version', 'scene', 'shot', 'task', 'run', 'question', 'answer', 'approval', 'channel', 'budget_policy', 'cost_event', 'continuity_issue', 'setup', 'setup_beat', 'entity', 'entity_name', 'mention', 'fact', 'timeline', 'schema_proposal', 'glossary_term', 'identity_decision', 'media_asset', 'scene_prompt_ir', 'media_quote', 'settings', 'concept_session', 'concept_brief', 'concept_message')),
  ref_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT question_links_tenant_key UNIQUE (novel_id, id),
  UNIQUE (novel_id, question_id, ref_type, ref_id)
);

-- hitl
CREATE TABLE question_deliveries (
  id text NOT NULL,
  novel_id text NOT NULL,
  question_id text NOT NULL,
  channel_id text NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  CONSTRAINT question_deliveries_state_enum CHECK (state IN ('pending', 'posted', 'answered_here', 'closed_elsewhere', 'withdrawn', 'failed')),
  outbox_id text,
  provider_message_ref text,
  posted_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT question_deliveries_id_format CHECK (id ~ '^qdl_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT question_deliveries_tenant_key UNIQUE (novel_id, id),
  UNIQUE (novel_id, question_id, channel_id)
);

-- hitl
CREATE TABLE answers (
  id text NOT NULL,
  novel_id text NOT NULL,
  question_id text NOT NULL,
  channel_id text NOT NULL,
  inbox_id text,
  responder_user_id text NOT NULL,
  received_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  disposition text NOT NULL,
  CONSTRAINT answers_disposition_enum CHECK (disposition IN ('accepted', 'late', 'duplicate')),
  late_resolution text,
  CONSTRAINT answers_late_resolution_enum CHECK (late_resolution IN ('pending_user_choice', 'revision_task_created', 'retcon_question_created', 'no_change', 'dismissed', 'applied_to_hold')),
  late_resolution_ref_type text,
  CONSTRAINT answers_late_resolution_ref_type_enum CHECK (late_resolution_ref_type IN ('novel', 'goal', 'series_bible', 'arc', 'episode', 'manuscript_version', 'scene', 'shot', 'task', 'run', 'question', 'answer', 'approval', 'channel', 'budget_policy', 'cost_event', 'continuity_issue', 'setup', 'setup_beat', 'entity', 'entity_name', 'mention', 'fact', 'timeline', 'schema_proposal', 'glossary_term', 'identity_decision', 'media_asset', 'scene_prompt_ir', 'media_quote', 'settings', 'concept_session', 'concept_brief', 'concept_message')),
  late_resolution_ref_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT answers_id_format CHECK (id ~ '^ans_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT answers_tenant_key UNIQUE (novel_id, id),
  CONSTRAINT answers_ck_1 CHECK (disposition <> 'late' OR late_resolution IS NOT NULL)
);

-- hitl
CREATE TABLE answer_interpretations (
  id text NOT NULL,
  novel_id text NOT NULL,
  answer_id text NOT NULL,
  run_id text NOT NULL,
  status text NOT NULL DEFAULT 'proposed',
  CONSTRAINT answer_interpretations_status_enum CHECK (status IN ('proposed', 'confirmed', 'corrected', 'rejected', 'needs_followup')),
  proposed_changes jsonb NOT NULL,
  confirm_question_id text,
  final_changes jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT answer_interpretations_id_format CHECK (id ~ '^itp_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT answer_interpretations_tenant_key UNIQUE (novel_id, id),
  CONSTRAINT answer_interpretations_ck_1 CHECK (status NOT IN ('confirmed', 'corrected') OR final_changes IS NOT NULL)
);

-- hitl
CREATE TABLE answer_reflections (
  id text NOT NULL,
  novel_id text NOT NULL,
  question_id text NOT NULL,
  answer_id text,
  status text NOT NULL DEFAULT 'pending',
  CONSTRAINT answer_reflections_status_enum CHECK (status IN ('pending', 'applied', 'not_applied')),
  consumer_run_ids text[] NOT NULL DEFAULT '{}',
  locations jsonb NOT NULL DEFAULT '[]',
  not_applied_reason text,
  notified_at timestamptz,
  notice_outbox_id text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT answer_reflections_id_format CHECK (id ~ '^arf_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT answer_reflections_tenant_key UNIQUE (novel_id, id),
  UNIQUE (novel_id, question_id),
  CONSTRAINT answer_reflections_ck_1 CHECK (status <> 'not_applied' OR not_applied_reason IS NOT NULL)
);

-- hitl
CREATE TABLE answer_reflection_items (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  novel_id text NOT NULL,
  reflection_id text NOT NULL,
  change_kind text NOT NULL,
  CONSTRAINT answer_reflection_items_change_kind_enum CHECK (change_kind IN ('fact_created', 'fact_changed', 'constraint_created', 'task_created', 'task_changed', 'bible_changed', 'setup_changed', 'entity_name_rule', 'schema_changed', 'no_change')),
  ref_type text,
  CONSTRAINT answer_reflection_items_ref_type_enum CHECK (ref_type IN ('novel', 'goal', 'series_bible', 'arc', 'episode', 'manuscript_version', 'scene', 'shot', 'task', 'run', 'question', 'answer', 'approval', 'channel', 'budget_policy', 'cost_event', 'continuity_issue', 'setup', 'setup_beat', 'entity', 'entity_name', 'mention', 'fact', 'timeline', 'schema_proposal', 'glossary_term', 'identity_decision', 'media_asset', 'scene_prompt_ir', 'media_quote', 'settings', 'concept_session', 'concept_brief', 'concept_message')),
  ref_id text,
  summary text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT answer_reflection_items_tenant_key UNIQUE (novel_id, id)
);

-- hitl
CREATE TABLE answer_sessions (
  id text NOT NULL,
  novel_id text NOT NULL,
  channel_id text NOT NULL,
  question_id text NOT NULL,
  responder_external_ref text NOT NULL,
  step text NOT NULL,
  collected jsonb NOT NULL DEFAULT '{}',
  prompt_message_ref text,
  status text NOT NULL DEFAULT 'active',
  CONSTRAINT answer_sessions_status_enum CHECK (status IN ('active', 'completed', 'expired', 'cancelled')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT answer_sessions_id_format CHECK (id ~ '^ase_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT answer_sessions_tenant_key UNIQUE (novel_id, id)
);

-- hitl
CREATE TABLE approvals (
  id text NOT NULL,
  novel_id text NOT NULL,
  approval_type text NOT NULL,
  CONSTRAINT approvals_approval_type_enum CHECK (approval_type IN ('concept_brief', 'series_bible', 'arc_plan', 'episode', 'arc', 'canon_change', 'retcon', 'ending_change', 'budget_resume', 'setup_abandon', 'publish_batch', 'schema_change', 'identity_change', 'character_sheet', 'media_quote', 'safety_review', 'draft_adoption')),
  status text NOT NULL DEFAULT 'pending',
  CONSTRAINT approvals_status_enum CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'superseded')),
  subject_type text NOT NULL,
  CONSTRAINT approvals_subject_type_enum CHECK (subject_type IN ('novel', 'goal', 'series_bible', 'arc', 'episode', 'manuscript_version', 'scene', 'shot', 'task', 'run', 'question', 'answer', 'approval', 'channel', 'budget_policy', 'cost_event', 'continuity_issue', 'setup', 'setup_beat', 'entity', 'entity_name', 'mention', 'fact', 'timeline', 'schema_proposal', 'glossary_term', 'identity_decision', 'media_asset', 'scene_prompt_ir', 'media_quote', 'settings', 'concept_session', 'concept_brief', 'concept_message')),
  subject_id text NOT NULL,
  question_id text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  requested_by_actor_type text NOT NULL,
  CONSTRAINT approvals_requested_by_actor_type_enum CHECK (requested_by_actor_type IN ('user', 'agent', 'system')),
  requested_by_actor_id text NOT NULL,
  decided_by_user_id text,
  decided_at timestamptz,
  decision_note text,
  rework_from text,
  CONSTRAINT approvals_rework_from_enum CHECK (rework_from IN ('outline', 'draft', 'polish')),
  decided_via_channel_id text,
  is_absence_delegated boolean NOT NULL DEFAULT false,
  superseded_by_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT approvals_id_format CHECK (id ~ '^apr_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT approvals_tenant_key UNIQUE (novel_id, id),
  UNIQUE (novel_id, question_id),
  CONSTRAINT approvals_ck_1 CHECK (status NOT IN ('approved', 'rejected') OR decided_at IS NOT NULL),
  CONSTRAINT approvals_ck_2 CHECK (status <> 'rejected' OR decision_note IS NOT NULL),
  CONSTRAINT approvals_ck_3 CHECK (approval_type <> 'episode' OR status <> 'rejected' OR rework_from IS NOT NULL),
  CONSTRAINT approvals_ck_4 CHECK (NOT is_absence_delegated OR approval_type NOT IN ('retcon', 'ending_change', 'budget_resume') /* INV-APR-03 */),
  CONSTRAINT approvals_ck_5 CHECK (status <> 'superseded' OR superseded_by_id IS NOT NULL)
);

-- hitl
CREATE TABLE digest_batches (
  id text NOT NULL,
  novel_id text NOT NULL,
  kind text NOT NULL,
  CONSTRAINT digest_batches_kind_enum CHECK (kind IN ('non_blocking_digest', 'daily_summary', 'publish_batch', 'absence_summary')),
  status text NOT NULL DEFAULT 'collecting',
  CONSTRAINT digest_batches_status_enum CHECK (status IN ('collecting', 'sent', 'cancelled')),
  channel_id text,
  window_start_at timestamptz NOT NULL,
  window_end_at timestamptz NOT NULL,
  question_ids text[] NOT NULL DEFAULT '{}',
  outbox_id text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT digest_batches_id_format CHECK (id ~ '^dgb_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT digest_batches_tenant_key UNIQUE (novel_id, id),
  CONSTRAINT digest_batches_ck_1 CHECK (window_end_at >= window_start_at),
  CONSTRAINT digest_batches_ck_2 CHECK (status <> 'sent' OR sent_at IS NOT NULL)
);

-- messaging
CREATE TABLE channels (
  id text NOT NULL,
  novel_id text NOT NULL,
  kind text NOT NULL,
  CONSTRAINT channels_kind_enum CHECK (kind IN ('telegram', 'discord', 'slack', 'kakao', 'web')),
  status text NOT NULL DEFAULT 'pending_binding',
  CONSTRAINT channels_status_enum CHECK (status IN ('pending_binding', 'active', 'degraded', 'disconnected', 'revoked')),
  bot_id text,
  label text NOT NULL,
  external_chat_ref jsonb,
  allowed_user_refs text[],
  bound_at timestamptz,
  last_health_at timestamptz,
  last_health_status text,
  CONSTRAINT channels_last_health_status_enum CHECK (last_health_status IN ('pass', 'warn', 'fail')),
  disconnected_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT channels_id_format CHECK (id ~ '^chn_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT channels_tenant_key UNIQUE (novel_id, id),
  CONSTRAINT channels_ck_1 CHECK (kind = 'web' OR (bot_id IS NOT NULL AND allowed_user_refs IS NOT NULL)),
  CONSTRAINT channels_ck_2 CHECK (kind <> 'web' OR bot_id IS NULL)
);

-- messaging
CREATE TABLE channel_binding_tokens (
  id text NOT NULL,
  novel_id text NOT NULL,
  channel_kind text NOT NULL,
  CONSTRAINT channel_binding_tokens_channel_kind_enum CHECK (channel_kind IN ('telegram', 'discord', 'slack', 'kakao', 'web')),
  bot_id text,
  token_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'issued',
  CONSTRAINT channel_binding_tokens_status_enum CHECK (status IN ('issued', 'consumed', 'expired', 'revoked')),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_external_ref text,
  channel_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT channel_binding_tokens_id_format CHECK (id ~ '^bnd_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT channel_binding_tokens_tenant_key UNIQUE (novel_id, id),
  CONSTRAINT channel_binding_tokens_ck_1 CHECK (status <> 'consumed' OR (consumed_at IS NOT NULL AND consumed_external_ref IS NOT NULL)),
  CONSTRAINT channel_binding_tokens_ck_2 CHECK (channel_kind <> 'web')
);

-- messaging — novel_id filled after binding resolution (T-6)
CREATE TABLE messenger_inbox (
  id text NOT NULL,
  novel_id text,
  bot_id text NOT NULL,
  channel_id text,
  event_kind text NOT NULL,
  CONSTRAINT messenger_inbox_event_kind_enum CHECK (event_kind IN ('message', 'callback', 'command', 'interaction', 'system')),
  provider_event_id text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'received',
  CONSTRAINT messenger_inbox_status_enum CHECK (status IN ('received', 'processing', 'processed', 'ignored', 'retry', 'failed')),
  ignore_reason text,
  CONSTRAINT messenger_inbox_ignore_reason_enum CHECK (ignore_reason IN ('duplicate', 'unauthorized', 'unbound_chat', 'unsupported', 'unknown_question')),
  sender_external_ref text,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT messenger_inbox_id_format CHECK (id ~ '^inb_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT messenger_inbox_tenant_key UNIQUE (novel_id, id),
  CONSTRAINT messenger_inbox_ck_1 CHECK (status <> 'ignored' OR ignore_reason IS NOT NULL)
);

-- messaging
CREATE TABLE messenger_outbox (
  id text NOT NULL,
  novel_id text NOT NULL,
  channel_id text NOT NULL,
  kind text NOT NULL,
  CONSTRAINT messenger_outbox_kind_enum CHECK (kind IN ('question', 'question_update', 'digest', 'reminder', 'reflection_notice', 'daily_summary', 'alert', 'binding_confirmation', 'command_reply', 'concept_message')),
  status text NOT NULL DEFAULT 'pending',
  CONSTRAINT messenger_outbox_status_enum CHECK (status IN ('pending', 'sending', 'sent', 'retry', 'delivery_unknown', 'failed', 'cancelled')),
  idempotency_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  question_id text,
  digest_batch_id text,
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  provider_message_ref text,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT messenger_outbox_id_format CHECK (id ~ '^obx_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT messenger_outbox_tenant_key UNIQUE (novel_id, id),
  CONSTRAINT messenger_outbox_ck_1 CHECK (status <> 'sent' OR sent_at IS NOT NULL)
);

-- continuity
CREATE TABLE continuity_issues (
  id text NOT NULL,
  novel_id text NOT NULL,
  display_no integer NOT NULL,
  episode_id text NOT NULL,
  manuscript_version_id text NOT NULL,
  scene_id text,
  char_start integer,
  char_end integer,
  kind text NOT NULL,
  CONSTRAINT continuity_issues_kind_enum CHECK (kind IN ('appearance', 'age', 'relationship', 'ability_rule', 'location_travel', 'death_state', 'character_knowledge', 'identity_leak', 'schema_violation', 'published_canon_conflict', 'answer_constraint', 'human_edit_conflict', 'setup_missing', 'setup_contradiction', 'glossary_spelling', 'safety_age_rating', 'safety_minor_sexual', 'safety_real_person')),
  severity text NOT NULL,
  CONSTRAINT continuity_issues_severity_enum CHECK (severity IN ('high', 'medium', 'low')),
  status text NOT NULL DEFAULT 'open',
  CONSTRAINT continuity_issues_status_enum CHECK (status IN ('open', 'fixing', 'resolved', 'waived', 'false_positive', 'superseded')),
  detector text NOT NULL,
  CONSTRAINT continuity_issues_detector_enum CHECK (detector IN ('continuity_editor', 'foreshadow_manager', 'line_editor', 'world_keeper', 'schema_validator', 'linker')),
  detected_by_run_id text,
  message text NOT NULL,
  proposed_fix text,
  fix_scope text,
  CONSTRAINT continuity_issues_fix_scope_enum CHECK (fix_scope IN ('span', 'scene', 'outline')),
  auto_fix_diff jsonb,
  resolution_kind text,
  CONSTRAINT continuity_issues_resolution_kind_enum CHECK (resolution_kind IN ('auto_fixed', 'rewritten', 'human_edited', 'canon_updated', 'retconned')),
  resolved_by_actor_type text,
  CONSTRAINT continuity_issues_resolved_by_actor_type_enum CHECK (resolved_by_actor_type IN ('user', 'agent', 'system')),
  resolved_by_actor_id text,
  resolved_at timestamptz,
  question_id text,
  approval_id text,
  dedupe_key text NOT NULL,
  previous_issue_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT continuity_issues_id_format CHECK (id ~ '^cis_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT continuity_issues_tenant_key UNIQUE (novel_id, id),
  UNIQUE (novel_id, display_no),
  CONSTRAINT continuity_issues_ck_1 CHECK (status <> 'resolved' OR resolution_kind IS NOT NULL),
  CONSTRAINT continuity_issues_ck_2 CHECK (resolution_kind IS DISTINCT FROM 'auto_fixed' OR auto_fix_diff IS NOT NULL),
  CONSTRAINT continuity_issues_ck_3 CHECK (status IN ('open', 'fixing') OR (resolved_at IS NOT NULL AND resolved_by_actor_type IS NOT NULL AND resolved_by_actor_id IS NOT NULL)),
  CONSTRAINT continuity_issues_ck_4 CHECK (kind NOT IN ('safety_age_rating', 'safety_minor_sexual', 'safety_real_person') OR status NOT IN ('waived', 'false_positive') /* INV-CI-05 */),
  CONSTRAINT continuity_issues_ck_5 CHECK (status NOT IN ('waived', 'false_positive') OR severity <> 'high' OR resolved_by_actor_type = 'user' /* INV-CI-03 */),
  CONSTRAINT continuity_issues_ck_6 CHECK (char_end IS NULL OR char_start IS NULL OR char_end >= char_start)
);

-- continuity
CREATE TABLE continuity_issue_evidence (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  novel_id text NOT NULL,
  issue_id text NOT NULL,
  ref_type text NOT NULL,
  CONSTRAINT continuity_issue_evidence_ref_type_enum CHECK (ref_type IN ('novel', 'goal', 'series_bible', 'arc', 'episode', 'manuscript_version', 'scene', 'shot', 'task', 'run', 'question', 'answer', 'approval', 'channel', 'budget_policy', 'cost_event', 'continuity_issue', 'setup', 'setup_beat', 'entity', 'entity_name', 'mention', 'fact', 'timeline', 'schema_proposal', 'glossary_term', 'identity_decision', 'media_asset', 'scene_prompt_ir', 'media_quote', 'settings', 'concept_session', 'concept_brief', 'concept_message')),
  ref_id text NOT NULL,
  fact_version_id text,
  schema_rule_key text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT continuity_issue_evidence_tenant_key UNIQUE (novel_id, id),
  CONSTRAINT continuity_issue_evidence_ck_1 CHECK (ref_type IN ('fact', 'setup', 'setup_beat', 'answer', 'mention', 'entity_name', 'glossary_term'))
);

-- foreshadow
CREATE TABLE setups (
  id text NOT NULL,
  novel_id text NOT NULL,
  display_no integer NOT NULL,
  title text NOT NULL,
  description text NOT NULL,
  importance text NOT NULL,
  CONSTRAINT setups_importance_enum CHECK (importance IN ('low', 'medium', 'high')),
  narrative_status text NOT NULL DEFAULT 'planned',
  CONSTRAINT setups_narrative_status_enum CHECK (narrative_status IN ('planned', 'planted', 'reinforced', 'paid_off', 'abandoned')),
  canon_status text NOT NULL DEFAULT 'candidate',
  CONSTRAINT setups_canon_status_enum CHECK (canon_status IN ('candidate', 'approved', 'published_locked', 'rejected', 'retracted')),
  planned_arc_id text,
  due_kind text NOT NULL,
  CONSTRAINT setups_due_kind_enum CHECK (due_kind IN ('episode', 'arc')),
  due_episode_no integer,
  due_arc_id text,
  abandoned_reason text,
  abandon_approval_id text,
  paid_off_beat_id text,
  created_by_actor_type text NOT NULL,
  CONSTRAINT setups_created_by_actor_type_enum CHECK (created_by_actor_type IN ('user', 'agent', 'system')),
  created_by_actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT setups_id_format CHECK (id ~ '^stp_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT setups_tenant_key UNIQUE (novel_id, id),
  UNIQUE (novel_id, display_no),
  CONSTRAINT setups_ck_1 CHECK (due_kind <> 'episode' OR due_episode_no IS NOT NULL),
  CONSTRAINT setups_ck_2 CHECK (due_kind <> 'arc' OR due_arc_id IS NOT NULL),
  CONSTRAINT setups_ck_3 CHECK (narrative_status <> 'abandoned' OR (abandoned_reason IS NOT NULL AND abandon_approval_id IS NOT NULL) /* INV-SU-02 */),
  CONSTRAINT setups_ck_4 CHECK (narrative_status <> 'paid_off' OR paid_off_beat_id IS NOT NULL)
);

-- foreshadow
CREATE TABLE setup_beats (
  id text NOT NULL,
  novel_id text NOT NULL,
  setup_id text NOT NULL,
  kind text NOT NULL,
  CONSTRAINT setup_beats_kind_enum CHECK (kind IN ('plant', 'reinforce', 'payoff')),
  status text NOT NULL DEFAULT 'planned',
  CONSTRAINT setup_beats_status_enum CHECK (status IN ('planned', 'detected', 'missing', 'confirmed', 'cancelled')),
  canon_status text NOT NULL DEFAULT 'candidate',
  CONSTRAINT setup_beats_canon_status_enum CHECK (canon_status IN ('candidate', 'approved', 'published_locked', 'rejected', 'retracted')),
  planned_episode_no integer,
  planned_note text,
  episode_id text,
  scene_id text,
  manuscript_version_id text,
  char_start integer,
  char_end integer,
  detected_by_run_id text,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT setup_beats_id_format CHECK (id ~ '^sbt_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT setup_beats_tenant_key UNIQUE (novel_id, id),
  CONSTRAINT setup_beats_ck_1 CHECK (status NOT IN ('detected', 'confirmed') OR (episode_id IS NOT NULL AND scene_id IS NOT NULL AND manuscript_version_id IS NOT NULL AND char_start IS NOT NULL AND char_end IS NOT NULL)),
  CONSTRAINT setup_beats_ck_2 CHECK (status <> 'confirmed' OR confirmed_at IS NOT NULL)
);

-- foreshadow
CREATE TABLE setup_due_changes (
  id text NOT NULL,
  novel_id text NOT NULL,
  setup_id text NOT NULL,
  from_due_kind text,
  CONSTRAINT setup_due_changes_from_due_kind_enum CHECK (from_due_kind IN ('episode', 'arc')),
  from_due_episode_no integer,
  from_due_arc_id text,
  to_due_kind text NOT NULL,
  CONSTRAINT setup_due_changes_to_due_kind_enum CHECK (to_due_kind IN ('episode', 'arc')),
  to_due_episode_no integer,
  to_due_arc_id text,
  reason text NOT NULL,
  question_id text,
  approval_id text,
  changed_by_actor_type text NOT NULL,
  CONSTRAINT setup_due_changes_changed_by_actor_type_enum CHECK (changed_by_actor_type IN ('user', 'agent', 'system')),
  changed_by_actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT setup_due_changes_id_format CHECK (id ~ '^sdc_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT setup_due_changes_tenant_key UNIQUE (novel_id, id)
);

-- foreshadow
CREATE TABLE setup_links (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  novel_id text NOT NULL,
  setup_id text NOT NULL,
  ref_type text NOT NULL,
  CONSTRAINT setup_links_ref_type_enum CHECK (ref_type IN ('novel', 'goal', 'series_bible', 'arc', 'episode', 'manuscript_version', 'scene', 'shot', 'task', 'run', 'question', 'answer', 'approval', 'channel', 'budget_policy', 'cost_event', 'continuity_issue', 'setup', 'setup_beat', 'entity', 'entity_name', 'mention', 'fact', 'timeline', 'schema_proposal', 'glossary_term', 'identity_decision', 'media_asset', 'scene_prompt_ir', 'media_quote', 'settings', 'concept_session', 'concept_brief', 'concept_message')),
  ref_id text NOT NULL,
  pinned_fact_version_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT setup_links_tenant_key UNIQUE (novel_id, id),
  UNIQUE (novel_id, setup_id, ref_type, ref_id),
  CONSTRAINT setup_links_ck_1 CHECK (ref_type IN ('entity', 'fact')),
  CONSTRAINT setup_links_ck_2 CHECK (pinned_fact_version_id IS NULL OR ref_type = 'fact')
);

-- audit — append-only; seq = realtime event id (ADR-017)
CREATE TABLE activity_log (
  seq bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  id text NOT NULL,
  novel_id text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL,
  CONSTRAINT activity_log_actor_type_enum CHECK (actor_type IN ('user', 'agent', 'system')),
  actor_id text NOT NULL,
  run_id text,
  question_id text,
  approval_id text,
  answer_id text,
  action text NOT NULL,
  target_type text NOT NULL,
  CONSTRAINT activity_log_target_type_enum CHECK (target_type IN ('novel', 'goal', 'series_bible', 'arc', 'episode', 'manuscript_version', 'scene', 'shot', 'task', 'run', 'question', 'answer', 'approval', 'channel', 'budget_policy', 'cost_event', 'continuity_issue', 'setup', 'setup_beat', 'entity', 'entity_name', 'mention', 'fact', 'timeline', 'schema_proposal', 'glossary_term', 'identity_decision', 'media_asset', 'scene_prompt_ir', 'media_quote', 'settings', 'concept_session', 'concept_brief', 'concept_message')),
  target_id text NOT NULL,
  before jsonb,
  after jsonb,
  reason text,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (seq),
  UNIQUE (id),
  CONSTRAINT activity_log_id_format CHECK (id ~ '^act_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT activity_log_tenant_key UNIQUE (novel_id, id),
  CONSTRAINT activity_log_ck_1 CHECK (actor_type <> 'agent' OR run_id IS NOT NULL),
  CONSTRAINT activity_log_ck_2 CHECK (action ~ '^[a-z_]+\.[a-z_]+$')
);

-- ontology
CREATE TABLE ontology_schema_versions (
  id text NOT NULL,
  novel_id text NOT NULL,
  version_no integer NOT NULL,
  base_schema_key text NOT NULL DEFAULT 'base@1',
  extension jsonb NOT NULL DEFAULT '{}',
  published_at timestamptz NOT NULL DEFAULT now(),
  approval_id text,
  proposal_ids text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT ontology_schema_versions_id_format CHECK (id ~ '^osv_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT ontology_schema_versions_tenant_key UNIQUE (novel_id, id),
  UNIQUE (novel_id, version_no),
  CONSTRAINT ontology_schema_versions_ck_1 CHECK (version_no >= 1)
);

-- ontology
CREATE TABLE timelines (
  id text NOT NULL,
  novel_id text NOT NULL,
  kind text NOT NULL DEFAULT 'main',
  CONSTRAINT timelines_kind_enum CHECK (kind IN ('main', 'regression', 'loop', 'parallel')),
  label text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  parent_timeline_id text,
  branch_story_point integer,
  rewind_to_story_point integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT timelines_id_format CHECK (id ~ '^tln_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT timelines_tenant_key UNIQUE (novel_id, id),
  UNIQUE (novel_id, label),
  CONSTRAINT timelines_ck_1 CHECK (kind = 'main' OR parent_timeline_id IS NOT NULL),
  CONSTRAINT timelines_ck_2 CHECK (kind NOT IN ('regression', 'loop') OR rewind_to_story_point IS NOT NULL),
  CONSTRAINT timelines_ck_3 CHECK (NOT is_default OR kind = 'main')
);

-- ontology
CREATE TABLE entities (
  id text NOT NULL,
  novel_id text NOT NULL,
  entity_type text NOT NULL,
  status text NOT NULL DEFAULT 'candidate',
  CONSTRAINT entities_status_enum CHECK (status IN ('candidate', 'active', 'merged', 'retired')),
  preferred_name_id text,
  merged_into_id text,
  confusable_with_ids text[] NOT NULL DEFAULT '{}',
  disambiguator text,
  created_from_mention_id text,
  equivalence_check jsonb,
  is_real_person boolean NOT NULL DEFAULT false,
  concept_character_key text,
  summary text,
  created_by_actor_type text NOT NULL,
  CONSTRAINT entities_created_by_actor_type_enum CHECK (created_by_actor_type IN ('user', 'agent', 'system')),
  created_by_actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT entities_id_format CHECK (id ~ '^ent_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT entities_tenant_key UNIQUE (novel_id, id),
  CONSTRAINT entities_ck_1 CHECK (status <> 'merged' OR merged_into_id IS NOT NULL),
  CONSTRAINT entities_ck_2 CHECK (merged_into_id IS NULL OR merged_into_id <> id),
  CONSTRAINT entities_ck_3 CHECK (status <> 'active' OR preferred_name_id IS NOT NULL),
  CONSTRAINT entities_ck_4 CHECK (NOT is_real_person OR entity_type = 'character'),
  CONSTRAINT entities_ck_5 CHECK (concept_character_key IS NULL OR entity_type = 'character'),
  CONSTRAINT entities_ck_6 CHECK (entity_type ~ '^[a-z][a-z0-9_.]*$')
);

-- ontology
CREATE TABLE entity_names (
  id text NOT NULL,
  novel_id text NOT NULL,
  entity_id text NOT NULL,
  surface text NOT NULL,
  normalized_key text NOT NULL,
  jamo_key text NOT NULL,
  translit_key text NOT NULL,
  name_kind text NOT NULL,
  CONSTRAINT entity_names_name_kind_enum CHECK (name_kind IN ('true_name', 'alias', 'title', 'address_term', 'disguise', 'variant', 'hidden_variant')),
  is_preferred boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active',
  CONSTRAINT entity_names_status_enum CHECK (status IN ('proposed', 'active', 'retired')),
  story_range int4range NOT NULL DEFAULT '[0,)',
  timeline_id text,
  surface_visibility text NOT NULL DEFAULT 'public',
  CONSTRAINT entity_names_surface_visibility_enum CHECK (surface_visibility IN ('public', 'restricted', 'secret')),
  surface_known_by_entity_ids text[] NOT NULL DEFAULT '{}',
  identity_visibility text NOT NULL DEFAULT 'public',
  CONSTRAINT entity_names_identity_visibility_enum CHECK (identity_visibility IN ('public', 'restricted', 'secret')),
  identity_known_by_entity_ids text[] NOT NULL DEFAULT '{}',
  used_by_condition jsonb,
  reader_reveal_point integer,
  origin_entity_id text,
  forbidden_by_glossary_term_id text,
  merged_conflict_with_id text,
  source_kind text NOT NULL,
  CONSTRAINT entity_names_source_kind_enum CHECK (source_kind IN ('manuscript', 'answer', 'user_input', 'series_bible', 'import', 'system_derived')),
  source_ref_type text NOT NULL,
  CONSTRAINT entity_names_source_ref_type_enum CHECK (source_ref_type IN ('novel', 'goal', 'series_bible', 'arc', 'episode', 'manuscript_version', 'scene', 'shot', 'task', 'run', 'question', 'answer', 'approval', 'channel', 'budget_policy', 'cost_event', 'continuity_issue', 'setup', 'setup_beat', 'entity', 'entity_name', 'mention', 'fact', 'timeline', 'schema_proposal', 'glossary_term', 'identity_decision', 'media_asset', 'scene_prompt_ir', 'media_quote', 'settings', 'concept_session', 'concept_brief', 'concept_message')),
  source_ref_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT entity_names_id_format CHECK (id ~ '^enm_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT entity_names_tenant_key UNIQUE (novel_id, id),
  CONSTRAINT entity_names_ck_1 CHECK (name_kind <> 'address_term' OR used_by_condition IS NOT NULL),
  CONSTRAINT entity_names_ck_2 CHECK (NOT isempty(story_range))
);

-- ontology
CREATE TABLE narrative_frames (
  id text NOT NULL,
  novel_id text NOT NULL,
  scene_id text NOT NULL,
  manuscript_version_id text NOT NULL,
  char_start integer NOT NULL,
  char_end integer NOT NULL,
  frame_kind text NOT NULL,
  CONSTRAINT narrative_frames_frame_kind_enum CHECK (frame_kind IN ('flashback', 'recollection', 'dream', 'other_timeline')),
  target_story_point integer,
  target_timeline_id text,
  source_kind text NOT NULL,
  CONSTRAINT narrative_frames_source_kind_enum CHECK (source_kind IN ('manuscript', 'answer', 'user_input', 'series_bible', 'import', 'system_derived')),
  run_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT narrative_frames_id_format CHECK (id ~ '^nfr_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT narrative_frames_tenant_key UNIQUE (novel_id, id),
  CONSTRAINT narrative_frames_ck_1 CHECK (char_start >= 0 AND char_end >= char_start)
);

-- ontology
CREATE TABLE mentions (
  id text NOT NULL,
  novel_id text NOT NULL,
  source_kind text NOT NULL,
  CONSTRAINT mentions_source_kind_enum CHECK (source_kind IN ('manuscript', 'answer', 'user_input', 'series_bible', 'import')),
  manuscript_version_id text,
  scene_id text,
  char_start integer,
  char_end integer,
  answer_id text,
  story_point integer NOT NULL,
  timeline_id text NOT NULL,
  narrative_frame_id text,
  redirected_from_entity_id text,
  surface text NOT NULL,
  mention_kind text NOT NULL,
  CONSTRAINT mentions_mention_kind_enum CHECK (mention_kind IN ('named', 'title', 'address', 'pronoun', 'zero', 'descriptive')),
  speaker_entity_id text,
  pov_entity_id text,
  chain_key text,
  candidates jsonb NOT NULL DEFAULT '[]',
  linked_entity_id text,
  via_name_id text,
  via_entity_id text,
  confidence real,
  rationale text,
  link_status text NOT NULL,
  CONSTRAINT mentions_link_status_enum CHECK (link_status IN ('auto_linked', 'confirmed', 'ambiguous', 'new_entity_candidate', 'rejected')),
  linker_version text NOT NULL,
  question_id text,
  run_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT mentions_id_format CHECK (id ~ '^mnt_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT mentions_tenant_key UNIQUE (novel_id, id),
  CONSTRAINT mentions_ck_1 CHECK (source_kind <> 'manuscript' OR (manuscript_version_id IS NOT NULL AND scene_id IS NOT NULL AND char_start IS NOT NULL AND char_end IS NOT NULL)),
  CONSTRAINT mentions_ck_2 CHECK (source_kind <> 'answer' OR answer_id IS NOT NULL),
  CONSTRAINT mentions_ck_3 CHECK (link_status NOT IN ('auto_linked', 'confirmed', 'new_entity_candidate') OR linked_entity_id IS NOT NULL),
  CONSTRAINT mentions_ck_4 CHECK (mention_kind <> 'zero' OR surface = ''),
  CONSTRAINT mentions_ck_5 CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);

-- ontology
CREATE TABLE facts (
  id text NOT NULL,
  novel_id text NOT NULL,
  fact_kind text NOT NULL,
  CONSTRAINT facts_fact_kind_enum CHECK (fact_kind IN ('attribute', 'relation', 'event', 'state', 'knowledge', 'rule', 'constraint')),
  subject_entity_id text,
  predicate text NOT NULL,
  object_entity_id text,
  object_fact_id text,
  object_name_id text,
  value jsonb,
  knowledge_stance text,
  CONSTRAINT facts_knowledge_stance_enum CHECK (knowledge_stance IN ('knows', 'suspects', 'misbelieves', 'unaware')),
  slot_key text NOT NULL,
  is_negation boolean NOT NULL DEFAULT false,
  is_secret boolean NOT NULL DEFAULT false,
  reader_reveal_point integer,
  timeline_id text NOT NULL,
  story_range int4range NOT NULL,
  from_scene_id text,
  to_scene_id text,
  canon_status text NOT NULL DEFAULT 'candidate',
  CONSTRAINT facts_canon_status_enum CHECK (canon_status IN ('candidate', 'approved', 'published_locked', 'rejected', 'retracted')),
  current_version_no integer NOT NULL DEFAULT 1,
  source_kind text NOT NULL,
  CONSTRAINT facts_source_kind_enum CHECK (source_kind IN ('manuscript', 'answer', 'user_input', 'series_bible', 'import', 'system_derived')),
  source_ref_type text NOT NULL,
  CONSTRAINT facts_source_ref_type_enum CHECK (source_ref_type IN ('novel', 'goal', 'series_bible', 'arc', 'episode', 'manuscript_version', 'scene', 'shot', 'task', 'run', 'question', 'answer', 'approval', 'channel', 'budget_policy', 'cost_event', 'continuity_issue', 'setup', 'setup_beat', 'entity', 'entity_name', 'mention', 'fact', 'timeline', 'schema_proposal', 'glossary_term', 'identity_decision', 'media_asset', 'scene_prompt_ir', 'media_quote', 'settings', 'concept_session', 'concept_brief', 'concept_message')),
  source_ref_id text NOT NULL,
  source_scene_id text,
  mention_ids text[],
  observed_as_name_id text,
  narrative_frame_id text,
  schema_version_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT facts_id_format CHECK (id ~ '^fct_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT facts_tenant_key UNIQUE (novel_id, id),
  CONSTRAINT facts_ck_1 CHECK (fact_kind <> 'knowledge' OR knowledge_stance IS NOT NULL),
  CONSTRAINT facts_ck_2 CHECK (subject_entity_id IS NOT NULL OR canon_status = 'candidate' /* INV-ONT-08 */),
  CONSTRAINT facts_ck_3 CHECK (num_nonnulls(object_entity_id, object_fact_id, object_name_id, value) <= 1),
  CONSTRAINT facts_ck_4 CHECK (source_kind NOT IN ('manuscript', 'answer') OR (mention_ids IS NOT NULL AND cardinality(mention_ids) > 0)),
  CONSTRAINT facts_ck_5 CHECK (current_version_no >= 1),
  CONSTRAINT facts_ck_6 CHECK (NOT isempty(story_range))
);

-- ontology
CREATE TABLE fact_versions (
  id text NOT NULL,
  novel_id text NOT NULL,
  fact_id text NOT NULL,
  version_no integer NOT NULL,
  content jsonb NOT NULL,
  canon_status text NOT NULL,
  CONSTRAINT fact_versions_canon_status_enum CHECK (canon_status IN ('candidate', 'approved', 'published_locked', 'rejected', 'retracted')),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  recorded_by_actor_type text NOT NULL,
  CONSTRAINT fact_versions_recorded_by_actor_type_enum CHECK (recorded_by_actor_type IN ('user', 'agent', 'system')),
  recorded_by_actor_id text NOT NULL,
  run_id text,
  change_reason text NOT NULL,
  CONSTRAINT fact_versions_change_reason_enum CHECK (change_reason IN ('extracted', 'user_edit', 'canon_change', 'retcon', 'identity_merge', 'identity_split', 'identity_relink', 'identity_revert', 'revert', 'range_recalc', 'range_close', 'resolution_filled', 'reinterpretation')),
  approval_id text,
  identity_decision_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT fact_versions_id_format CHECK (id ~ '^fcv_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT fact_versions_tenant_key UNIQUE (novel_id, id),
  UNIQUE (novel_id, fact_id, version_no),
  CONSTRAINT fact_versions_ck_1 CHECK (version_no >= 1),
  CONSTRAINT fact_versions_ck_2 CHECK (superseded_at IS NULL OR superseded_at >= recorded_at)
);

-- ontology
CREATE TABLE fact_cardinality_slots (
  novel_id text NOT NULL,
  fact_id text NOT NULL,
  timeline_id text NOT NULL,
  slot_key text NOT NULL,
  story_range int4range NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (novel_id, fact_id, slot_key)
);

-- ontology
CREATE TABLE schema_change_proposals (
  id text NOT NULL,
  novel_id text NOT NULL,
  kind text NOT NULL,
  CONSTRAINT schema_change_proposals_kind_enum CHECK (kind IN ('add_entity_type', 'add_relation_type', 'add_attribute', 'add_synonym', 'change_constraint', 'deprecate_item')),
  status text NOT NULL DEFAULT 'proposed',
  CONSTRAINT schema_change_proposals_status_enum CHECK (status IN ('proposed', 'mapped_to_existing', 'approved', 'rejected', 'withdrawn')),
  payload jsonb NOT NULL,
  examples jsonb NOT NULL DEFAULT '[]',
  similar_keys jsonb NOT NULL DEFAULT '[]',
  mapped_to_key text,
  question_id text,
  approval_id text,
  resulting_schema_version_id text,
  proposed_by_actor_type text NOT NULL,
  CONSTRAINT schema_change_proposals_proposed_by_actor_type_enum CHECK (proposed_by_actor_type IN ('user', 'agent', 'system')),
  proposed_by_actor_id text NOT NULL,
  decided_by_actor_type text,
  CONSTRAINT schema_change_proposals_decided_by_actor_type_enum CHECK (decided_by_actor_type IN ('user', 'agent', 'system')),
  decided_by_actor_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT schema_change_proposals_id_format CHECK (id ~ '^scp_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT schema_change_proposals_tenant_key UNIQUE (novel_id, id),
  CONSTRAINT schema_change_proposals_ck_1 CHECK (status <> 'mapped_to_existing' OR mapped_to_key IS NOT NULL),
  CONSTRAINT schema_change_proposals_ck_2 CHECK (status NOT IN ('approved', 'mapped_to_existing') OR resulting_schema_version_id IS NOT NULL)
);

-- ontology
CREATE TABLE glossary_terms (
  id text NOT NULL,
  novel_id text NOT NULL,
  surface text NOT NULL,
  normalized_key text NOT NULL,
  category text NOT NULL,
  definition text NOT NULL,
  preferred_surface text NOT NULL,
  spelling_rules jsonb NOT NULL DEFAULT '{}',
  linked_entity_id text,
  linked_schema_key text,
  status text NOT NULL DEFAULT 'active',
  CONSTRAINT glossary_terms_status_enum CHECK (status IN ('active', 'deprecated')),
  source_kind text NOT NULL,
  CONSTRAINT glossary_terms_source_kind_enum CHECK (source_kind IN ('user', 'agent', 'template')),
  source_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT glossary_terms_id_format CHECK (id ~ '^gls_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT glossary_terms_tenant_key UNIQUE (novel_id, id)
);

-- ontology
CREATE TABLE identity_decisions (
  id text NOT NULL,
  novel_id text NOT NULL,
  kind text NOT NULL,
  CONSTRAINT identity_decisions_kind_enum CHECK (kind IN ('merge', 'split', 'confirm_distinct', 'relink')),
  status text NOT NULL DEFAULT 'proposed',
  CONSTRAINT identity_decisions_status_enum CHECK (status IN ('proposed', 'applied', 'rejected', 'reverted', 'cancelled')),
  source_entity_ids text[] NOT NULL DEFAULT '{}',
  survivor_entity_id text,
  new_entity_id text,
  relink_mention_ids text[] NOT NULL DEFAULT '{}',
  relink_from_entity_id text,
  relink_to_entity_id text,
  rationale text,
  evidence jsonb NOT NULL DEFAULT '{}',
  impact jsonb NOT NULL DEFAULT '{}',
  question_id text,
  approval_id text,
  proposed_by_actor_type text NOT NULL,
  CONSTRAINT identity_decisions_proposed_by_actor_type_enum CHECK (proposed_by_actor_type IN ('user', 'agent', 'system')),
  proposed_by_actor_id text NOT NULL,
  decided_by_actor_type text,
  CONSTRAINT identity_decisions_decided_by_actor_type_enum CHECK (decided_by_actor_type IN ('user', 'agent', 'system')),
  decided_by_actor_id text,
  applied_at timestamptz,
  reverted_at timestamptz,
  reverted_by_actor_type text,
  CONSTRAINT identity_decisions_reverted_by_actor_type_enum CHECK (reverted_by_actor_type IN ('user', 'agent', 'system')),
  reverted_by_actor_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT identity_decisions_id_format CHECK (id ~ '^idd_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT identity_decisions_tenant_key UNIQUE (novel_id, id),
  CONSTRAINT identity_decisions_ck_1 CHECK (kind <> 'merge' OR survivor_entity_id IS NOT NULL),
  CONSTRAINT identity_decisions_ck_2 CHECK (kind <> 'split' OR status <> 'applied' OR new_entity_id IS NOT NULL),
  CONSTRAINT identity_decisions_ck_3 CHECK (kind <> 'relink' OR (relink_from_entity_id IS NOT NULL AND relink_to_entity_id IS NOT NULL)),
  CONSTRAINT identity_decisions_ck_4 CHECK (status NOT IN ('applied', 'reverted') OR applied_at IS NOT NULL),
  CONSTRAINT identity_decisions_ck_5 CHECK (status <> 'reverted' OR reverted_at IS NOT NULL)
);

-- ontology
CREATE TABLE identity_decision_moves (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  novel_id text NOT NULL,
  decision_id text NOT NULL,
  ref_table text NOT NULL,
  ref_id text NOT NULL,
  ref_column text NOT NULL,
  from_entity_id text NOT NULL,
  to_entity_id text NOT NULL,
  created_fact_version_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT identity_decision_moves_tenant_key UNIQUE (novel_id, id)
);

-- ontology
CREATE TABLE entity_distinct_pairs (
  novel_id text NOT NULL,
  entity_a_id text NOT NULL,
  entity_b_id text NOT NULL,
  decision_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (novel_id, entity_a_id, entity_b_id),
  CONSTRAINT entity_distinct_pairs_ck_1 CHECK (entity_a_id < entity_b_id)
);

-- export
CREATE TABLE export_jobs (
  id text NOT NULL,
  novel_id text NOT NULL,
  scope_kind text NOT NULL,
  CONSTRAINT export_jobs_scope_kind_enum CHECK (scope_kind IN ('episode', 'arc', 'novel')),
  scope_target_id text,
  export_format text NOT NULL,
  CONSTRAINT export_jobs_export_format_enum CHECK (export_format IN ('txt', 'markdown', 'docx', 'epub', 'json', 'novel_package')),
  version_selection text NOT NULL DEFAULT 'default',
  CONSTRAINT export_jobs_version_selection_enum CHECK (version_selection IN ('default', 'current')),
  items jsonb NOT NULL DEFAULT '[]',
  excluded jsonb NOT NULL DEFAULT '[]',
  storage_key text,
  content_hash text,
  requested_by_actor_type text NOT NULL,
  CONSTRAINT export_jobs_requested_by_actor_type_enum CHECK (requested_by_actor_type IN ('user', 'agent', 'system')),
  requested_by_actor_id text NOT NULL,
  completed_at timestamptz,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT export_jobs_id_format CHECK (id ~ '^exp_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT export_jobs_tenant_key UNIQUE (novel_id, id),
  CONSTRAINT export_jobs_ck_1 CHECK ((scope_kind = 'novel') = (scope_target_id IS NULL)),
  CONSTRAINT export_jobs_ck_2 CHECK (completed_at IS NULL OR (storage_key IS NOT NULL AND content_hash IS NOT NULL))
);

-- ── foreign keys (T-2 composite tenant FKs) ──
ALTER TABLE length_profiles ADD CONSTRAINT length_profiles_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE health_check_results ADD CONSTRAINT health_check_results_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE novels ADD CONSTRAINT novels_approved_concept_brief_id_fk FOREIGN KEY (id, approved_concept_brief_id) REFERENCES concept_briefs (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE novels ADD CONSTRAINT novels_length_profile_id_fk FOREIGN KEY (length_profile_id) REFERENCES length_profiles (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE novels ADD CONSTRAINT novels_active_schema_version_id_fk FOREIGN KEY (id, active_schema_version_id) REFERENCES ontology_schema_versions (novel_id, id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE goals ADD CONSTRAINT goals_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE series_bibles ADD CONSTRAINT series_bibles_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE series_bibles ADD CONSTRAINT series_bibles_concept_brief_id_fk FOREIGN KEY (novel_id, concept_brief_id) REFERENCES concept_briefs (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE series_bibles ADD CONSTRAINT series_bibles_approval_id_fk FOREIGN KEY (novel_id, approval_id) REFERENCES approvals (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE arcs ADD CONSTRAINT arcs_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE arcs ADD CONSTRAINT arcs_plan_approval_id_fk FOREIGN KEY (novel_id, plan_approval_id) REFERENCES approvals (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE arcs ADD CONSTRAINT arcs_arc_approval_id_fk FOREIGN KEY (novel_id, arc_approval_id) REFERENCES approvals (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE notification_policies ADD CONSTRAINT notification_policies_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE novel_counters ADD CONSTRAINT novel_counters_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE concept_sessions ADD CONSTRAINT concept_sessions_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE concept_sessions ADD CONSTRAINT concept_sessions_base_brief_id_fk FOREIGN KEY (novel_id, base_brief_id) REFERENCES concept_briefs (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE concept_sessions ADD CONSTRAINT concept_sessions_active_channel_id_fk FOREIGN KEY (novel_id, active_channel_id) REFERENCES channels (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE concept_sessions ADD CONSTRAINT concept_sessions_in_flight_task_id_fk FOREIGN KEY (novel_id, in_flight_task_id) REFERENCES tasks (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE concept_sessions ADD CONSTRAINT concept_sessions_pending_approval_id_fk FOREIGN KEY (novel_id, pending_approval_id) REFERENCES approvals (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE concept_sessions ADD CONSTRAINT concept_sessions_approved_brief_id_fk FOREIGN KEY (novel_id, approved_brief_id) REFERENCES concept_briefs (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE concept_sessions ADD CONSTRAINT concept_sessions_created_by_user_id_fk FOREIGN KEY (created_by_user_id) REFERENCES users (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE concept_messages ADD CONSTRAINT concept_messages_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE concept_messages ADD CONSTRAINT concept_messages_session_id_fk FOREIGN KEY (novel_id, session_id) REFERENCES concept_sessions (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE concept_messages ADD CONSTRAINT concept_messages_author_user_id_fk FOREIGN KEY (author_user_id) REFERENCES users (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE concept_messages ADD CONSTRAINT concept_messages_run_id_fk FOREIGN KEY (novel_id, run_id) REFERENCES runs (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE concept_messages ADD CONSTRAINT concept_messages_channel_id_fk FOREIGN KEY (novel_id, channel_id) REFERENCES channels (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE concept_messages ADD CONSTRAINT concept_messages_inbox_id_fk FOREIGN KEY (inbox_id) REFERENCES messenger_inbox (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE concept_messages ADD CONSTRAINT concept_messages_outbox_id_fk FOREIGN KEY (novel_id, outbox_id) REFERENCES messenger_outbox (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE concept_briefs ADD CONSTRAINT concept_briefs_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE concept_briefs ADD CONSTRAINT concept_briefs_session_id_fk FOREIGN KEY (novel_id, session_id) REFERENCES concept_sessions (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE concept_briefs ADD CONSTRAINT concept_briefs_approval_id_fk FOREIGN KEY (novel_id, approval_id) REFERENCES approvals (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE concept_briefs ADD CONSTRAINT concept_briefs_supersedes_id_fk FOREIGN KEY (novel_id, supersedes_id) REFERENCES concept_briefs (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE episodes ADD CONSTRAINT episodes_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE episodes ADD CONSTRAINT episodes_arc_id_fk FOREIGN KEY (novel_id, arc_id) REFERENCES arcs (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE episodes ADD CONSTRAINT episodes_primary_timeline_id_fk FOREIGN KEY (novel_id, primary_timeline_id) REFERENCES timelines (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE episodes ADD CONSTRAINT episodes_outline_version_id_fk FOREIGN KEY (novel_id, outline_version_id) REFERENCES manuscript_versions (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE episodes ADD CONSTRAINT episodes_current_version_id_fk FOREIGN KEY (novel_id, current_version_id) REFERENCES manuscript_versions (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE episodes ADD CONSTRAINT episodes_approved_version_id_fk FOREIGN KEY (novel_id, approved_version_id) REFERENCES manuscript_versions (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE episodes ADD CONSTRAINT episodes_published_version_id_fk FOREIGN KEY (novel_id, published_version_id) REFERENCES manuscript_versions (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE manuscript_versions ADD CONSTRAINT manuscript_versions_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE manuscript_versions ADD CONSTRAINT manuscript_versions_episode_id_fk FOREIGN KEY (novel_id, episode_id) REFERENCES episodes (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE manuscript_versions ADD CONSTRAINT manuscript_versions_parent_version_id_fk FOREIGN KEY (novel_id, parent_version_id) REFERENCES manuscript_versions (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE manuscript_versions ADD CONSTRAINT manuscript_versions_run_id_fk FOREIGN KEY (novel_id, run_id) REFERENCES runs (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE episode_rejections ADD CONSTRAINT episode_rejections_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE episode_rejections ADD CONSTRAINT episode_rejections_episode_id_fk FOREIGN KEY (novel_id, episode_id) REFERENCES episodes (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE episode_rejections ADD CONSTRAINT episode_rejections_approval_id_fk FOREIGN KEY (novel_id, approval_id) REFERENCES approvals (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE episode_rejections ADD CONSTRAINT episode_rejections_from_version_id_fk FOREIGN KEY (novel_id, from_version_id) REFERENCES manuscript_versions (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE episode_rejections ADD CONSTRAINT episode_rejections_rejected_by_user_id_fk FOREIGN KEY (rejected_by_user_id) REFERENCES users (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE scenes ADD CONSTRAINT scenes_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE scenes ADD CONSTRAINT scenes_episode_id_fk FOREIGN KEY (novel_id, episode_id) REFERENCES episodes (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE scenes ADD CONSTRAINT scenes_manuscript_version_id_fk FOREIGN KEY (novel_id, manuscript_version_id) REFERENCES manuscript_versions (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE scenes ADD CONSTRAINT scenes_timeline_id_fk FOREIGN KEY (novel_id, timeline_id) REFERENCES timelines (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE scenes ADD CONSTRAINT scenes_location_entity_id_fk FOREIGN KEY (novel_id, location_entity_id) REFERENCES entities (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE scenes ADD CONSTRAINT scenes_pov_entity_id_fk FOREIGN KEY (novel_id, pov_entity_id) REFERENCES entities (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE scene_participants ADD CONSTRAINT scene_participants_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE scene_participants ADD CONSTRAINT scene_participants_scene_id_fk FOREIGN KEY (novel_id, scene_id) REFERENCES scenes (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE scene_participants ADD CONSTRAINT scene_participants_entity_id_fk FOREIGN KEY (novel_id, entity_id) REFERENCES entities (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE scene_participants ADD CONSTRAINT scene_participants_first_mention_id_fk FOREIGN KEY (novel_id, first_mention_id) REFERENCES mentions (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE episode_recaps ADD CONSTRAINT episode_recaps_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE episode_recaps ADD CONSTRAINT episode_recaps_episode_id_fk FOREIGN KEY (novel_id, episode_id) REFERENCES episodes (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE episode_recaps ADD CONSTRAINT episode_recaps_source_version_id_fk FOREIGN KEY (novel_id, source_version_id) REFERENCES manuscript_versions (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE episode_recaps ADD CONSTRAINT episode_recaps_pov_entity_id_fk FOREIGN KEY (novel_id, pov_entity_id) REFERENCES entities (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE episode_recaps ADD CONSTRAINT episode_recaps_created_by_run_id_fk FOREIGN KEY (novel_id, created_by_run_id) REFERENCES runs (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE tasks ADD CONSTRAINT tasks_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE tasks ADD CONSTRAINT tasks_goal_id_fk FOREIGN KEY (novel_id, goal_id) REFERENCES goals (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE tasks ADD CONSTRAINT tasks_arc_id_fk FOREIGN KEY (novel_id, arc_id) REFERENCES arcs (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE tasks ADD CONSTRAINT tasks_episode_id_fk FOREIGN KEY (novel_id, episode_id) REFERENCES episodes (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE tasks ADD CONSTRAINT tasks_parent_task_id_fk FOREIGN KEY (novel_id, parent_task_id) REFERENCES tasks (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE tasks ADD CONSTRAINT tasks_lease_run_id_fk FOREIGN KEY (novel_id, lease_run_id) REFERENCES runs (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE tasks ADD CONSTRAINT tasks_superseded_by_task_id_fk FOREIGN KEY (novel_id, superseded_by_task_id) REFERENCES tasks (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE task_dependencies ADD CONSTRAINT task_dependencies_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE task_dependencies ADD CONSTRAINT task_dependencies_task_id_fk FOREIGN KEY (novel_id, task_id) REFERENCES tasks (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE task_dependencies ADD CONSTRAINT task_dependencies_depends_on_task_id_fk FOREIGN KEY (novel_id, depends_on_task_id) REFERENCES tasks (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE wake_requests ADD CONSTRAINT wake_requests_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE wake_requests ADD CONSTRAINT wake_requests_task_id_fk FOREIGN KEY (novel_id, task_id) REFERENCES tasks (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE wake_requests ADD CONSTRAINT wake_requests_coalesced_into_id_fk FOREIGN KEY (novel_id, coalesced_into_id) REFERENCES wake_requests (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE wake_requests ADD CONSTRAINT wake_requests_claimed_run_id_fk FOREIGN KEY (novel_id, claimed_run_id) REFERENCES runs (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE runs ADD CONSTRAINT runs_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE runs ADD CONSTRAINT runs_task_id_fk FOREIGN KEY (novel_id, task_id) REFERENCES tasks (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE runs ADD CONSTRAINT runs_wake_request_id_fk FOREIGN KEY (novel_id, wake_request_id) REFERENCES wake_requests (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE runs ADD CONSTRAINT runs_context_snapshot_id_fk FOREIGN KEY (novel_id, context_snapshot_id) REFERENCES context_snapshots (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE runs ADD CONSTRAINT runs_rerun_of_run_id_fk FOREIGN KEY (novel_id, rerun_of_run_id) REFERENCES runs (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE context_snapshots ADD CONSTRAINT context_snapshots_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE context_snapshots ADD CONSTRAINT context_snapshots_run_id_fk FOREIGN KEY (novel_id, run_id) REFERENCES runs (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE context_snapshots ADD CONSTRAINT context_snapshots_timeline_id_fk FOREIGN KEY (novel_id, timeline_id) REFERENCES timelines (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE context_snapshots ADD CONSTRAINT context_snapshots_pov_entity_id_fk FOREIGN KEY (novel_id, pov_entity_id) REFERENCES entities (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE context_snapshots ADD CONSTRAINT context_snapshots_schema_version_id_fk FOREIGN KEY (novel_id, schema_version_id) REFERENCES ontology_schema_versions (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE context_snapshots ADD CONSTRAINT context_snapshots_cloned_from_snapshot_id_fk FOREIGN KEY (novel_id, cloned_from_snapshot_id) REFERENCES context_snapshots (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE role_model_bindings ADD CONSTRAINT role_model_bindings_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE role_model_bindings ADD CONSTRAINT role_model_bindings_provider_profile_id_fk FOREIGN KEY (provider_profile_id) REFERENCES provider_profiles (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE provider_calls ADD CONSTRAINT provider_calls_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE provider_calls ADD CONSTRAINT provider_calls_run_id_fk FOREIGN KEY (novel_id, run_id) REFERENCES runs (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE provider_calls ADD CONSTRAINT provider_calls_reservation_id_fk FOREIGN KEY (novel_id, reservation_id) REFERENCES budget_reservations (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE provider_calls ADD CONSTRAINT provider_calls_retry_of_call_id_fk FOREIGN KEY (novel_id, retry_of_call_id) REFERENCES provider_calls (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE budget_policies ADD CONSTRAINT budget_policies_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE budget_policies ADD CONSTRAINT budget_policies_resume_approval_id_fk FOREIGN KEY (novel_id, resume_approval_id) REFERENCES approvals (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE budget_reservations ADD CONSTRAINT budget_reservations_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE budget_reservations ADD CONSTRAINT budget_reservations_run_id_fk FOREIGN KEY (novel_id, run_id) REFERENCES runs (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE budget_reservations ADD CONSTRAINT budget_reservations_provider_call_id_fk FOREIGN KEY (novel_id, provider_call_id) REFERENCES provider_calls (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE budget_reservations ADD CONSTRAINT budget_reservations_settled_cost_event_id_fk FOREIGN KEY (novel_id, settled_cost_event_id) REFERENCES cost_events (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE cost_events ADD CONSTRAINT cost_events_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE cost_events ADD CONSTRAINT cost_events_provider_call_id_fk FOREIGN KEY (novel_id, provider_call_id) REFERENCES provider_calls (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE cost_events ADD CONSTRAINT cost_events_adjusts_cost_event_id_fk FOREIGN KEY (novel_id, adjusts_cost_event_id) REFERENCES cost_events (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE cost_events ADD CONSTRAINT cost_events_run_id_fk FOREIGN KEY (novel_id, run_id) REFERENCES runs (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE cost_events ADD CONSTRAINT cost_events_task_id_fk FOREIGN KEY (novel_id, task_id) REFERENCES tasks (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE cost_events ADD CONSTRAINT cost_events_arc_id_fk FOREIGN KEY (novel_id, arc_id) REFERENCES arcs (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE cost_events ADD CONSTRAINT cost_events_episode_id_fk FOREIGN KEY (novel_id, episode_id) REFERENCES episodes (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE cost_events ADD CONSTRAINT cost_events_scene_id_fk FOREIGN KEY (novel_id, scene_id) REFERENCES scenes (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE cost_events ADD CONSTRAINT cost_events_provider_profile_id_fk FOREIGN KEY (provider_profile_id) REFERENCES provider_profiles (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE questions ADD CONSTRAINT questions_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE questions ADD CONSTRAINT questions_created_by_run_id_fk FOREIGN KEY (novel_id, created_by_run_id) REFERENCES runs (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE questions ADD CONSTRAINT questions_approval_id_fk FOREIGN KEY (novel_id, approval_id) REFERENCES approvals (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE questions ADD CONSTRAINT questions_parent_question_id_fk FOREIGN KEY (novel_id, parent_question_id) REFERENCES questions (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE questions ADD CONSTRAINT questions_depends_on_question_id_fk FOREIGN KEY (novel_id, depends_on_question_id) REFERENCES questions (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE questions ADD CONSTRAINT questions_digest_batch_id_fk FOREIGN KEY (novel_id, digest_batch_id) REFERENCES digest_batches (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE questions ADD CONSTRAINT questions_accepted_answer_id_fk FOREIGN KEY (novel_id, accepted_answer_id) REFERENCES answers (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE question_options ADD CONSTRAINT question_options_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE question_options ADD CONSTRAINT question_options_question_id_fk FOREIGN KEY (novel_id, question_id) REFERENCES questions (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE question_links ADD CONSTRAINT question_links_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE question_links ADD CONSTRAINT question_links_question_id_fk FOREIGN KEY (novel_id, question_id) REFERENCES questions (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE question_deliveries ADD CONSTRAINT question_deliveries_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE question_deliveries ADD CONSTRAINT question_deliveries_question_id_fk FOREIGN KEY (novel_id, question_id) REFERENCES questions (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE question_deliveries ADD CONSTRAINT question_deliveries_channel_id_fk FOREIGN KEY (novel_id, channel_id) REFERENCES channels (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE question_deliveries ADD CONSTRAINT question_deliveries_outbox_id_fk FOREIGN KEY (novel_id, outbox_id) REFERENCES messenger_outbox (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE answers ADD CONSTRAINT answers_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE answers ADD CONSTRAINT answers_question_id_fk FOREIGN KEY (novel_id, question_id) REFERENCES questions (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE answers ADD CONSTRAINT answers_channel_id_fk FOREIGN KEY (novel_id, channel_id) REFERENCES channels (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE answers ADD CONSTRAINT answers_inbox_id_fk FOREIGN KEY (inbox_id) REFERENCES messenger_inbox (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE answers ADD CONSTRAINT answers_responder_user_id_fk FOREIGN KEY (responder_user_id) REFERENCES users (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE answer_interpretations ADD CONSTRAINT answer_interpretations_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE answer_interpretations ADD CONSTRAINT answer_interpretations_answer_id_fk FOREIGN KEY (novel_id, answer_id) REFERENCES answers (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE answer_interpretations ADD CONSTRAINT answer_interpretations_run_id_fk FOREIGN KEY (novel_id, run_id) REFERENCES runs (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE answer_interpretations ADD CONSTRAINT answer_interpretations_confirm_question_id_fk FOREIGN KEY (novel_id, confirm_question_id) REFERENCES questions (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE answer_reflections ADD CONSTRAINT answer_reflections_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE answer_reflections ADD CONSTRAINT answer_reflections_question_id_fk FOREIGN KEY (novel_id, question_id) REFERENCES questions (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE answer_reflections ADD CONSTRAINT answer_reflections_answer_id_fk FOREIGN KEY (novel_id, answer_id) REFERENCES answers (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE answer_reflections ADD CONSTRAINT answer_reflections_notice_outbox_id_fk FOREIGN KEY (novel_id, notice_outbox_id) REFERENCES messenger_outbox (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE answer_reflection_items ADD CONSTRAINT answer_reflection_items_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE answer_reflection_items ADD CONSTRAINT answer_reflection_items_reflection_id_fk FOREIGN KEY (novel_id, reflection_id) REFERENCES answer_reflections (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE answer_sessions ADD CONSTRAINT answer_sessions_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE answer_sessions ADD CONSTRAINT answer_sessions_channel_id_fk FOREIGN KEY (novel_id, channel_id) REFERENCES channels (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE answer_sessions ADD CONSTRAINT answer_sessions_question_id_fk FOREIGN KEY (novel_id, question_id) REFERENCES questions (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE approvals ADD CONSTRAINT approvals_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE approvals ADD CONSTRAINT approvals_question_id_fk FOREIGN KEY (novel_id, question_id) REFERENCES questions (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE approvals ADD CONSTRAINT approvals_decided_by_user_id_fk FOREIGN KEY (decided_by_user_id) REFERENCES users (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE approvals ADD CONSTRAINT approvals_decided_via_channel_id_fk FOREIGN KEY (novel_id, decided_via_channel_id) REFERENCES channels (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE approvals ADD CONSTRAINT approvals_superseded_by_id_fk FOREIGN KEY (novel_id, superseded_by_id) REFERENCES approvals (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE digest_batches ADD CONSTRAINT digest_batches_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE digest_batches ADD CONSTRAINT digest_batches_channel_id_fk FOREIGN KEY (novel_id, channel_id) REFERENCES channels (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE digest_batches ADD CONSTRAINT digest_batches_outbox_id_fk FOREIGN KEY (novel_id, outbox_id) REFERENCES messenger_outbox (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE channels ADD CONSTRAINT channels_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE channels ADD CONSTRAINT channels_bot_id_fk FOREIGN KEY (bot_id) REFERENCES messenger_bots (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE channel_binding_tokens ADD CONSTRAINT channel_binding_tokens_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE channel_binding_tokens ADD CONSTRAINT channel_binding_tokens_bot_id_fk FOREIGN KEY (bot_id) REFERENCES messenger_bots (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE channel_binding_tokens ADD CONSTRAINT channel_binding_tokens_channel_id_fk FOREIGN KEY (novel_id, channel_id) REFERENCES channels (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE messenger_inbox ADD CONSTRAINT messenger_inbox_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE messenger_inbox ADD CONSTRAINT messenger_inbox_bot_id_fk FOREIGN KEY (bot_id) REFERENCES messenger_bots (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE messenger_inbox ADD CONSTRAINT messenger_inbox_channel_id_fk FOREIGN KEY (channel_id) REFERENCES channels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE messenger_outbox ADD CONSTRAINT messenger_outbox_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE messenger_outbox ADD CONSTRAINT messenger_outbox_channel_id_fk FOREIGN KEY (novel_id, channel_id) REFERENCES channels (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE messenger_outbox ADD CONSTRAINT messenger_outbox_question_id_fk FOREIGN KEY (novel_id, question_id) REFERENCES questions (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE messenger_outbox ADD CONSTRAINT messenger_outbox_digest_batch_id_fk FOREIGN KEY (novel_id, digest_batch_id) REFERENCES digest_batches (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE continuity_issues ADD CONSTRAINT continuity_issues_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE continuity_issues ADD CONSTRAINT continuity_issues_episode_id_fk FOREIGN KEY (novel_id, episode_id) REFERENCES episodes (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE continuity_issues ADD CONSTRAINT continuity_issues_manuscript_version_id_fk FOREIGN KEY (novel_id, manuscript_version_id) REFERENCES manuscript_versions (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE continuity_issues ADD CONSTRAINT continuity_issues_scene_id_fk FOREIGN KEY (novel_id, scene_id) REFERENCES scenes (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE continuity_issues ADD CONSTRAINT continuity_issues_detected_by_run_id_fk FOREIGN KEY (novel_id, detected_by_run_id) REFERENCES runs (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE continuity_issues ADD CONSTRAINT continuity_issues_question_id_fk FOREIGN KEY (novel_id, question_id) REFERENCES questions (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE continuity_issues ADD CONSTRAINT continuity_issues_approval_id_fk FOREIGN KEY (novel_id, approval_id) REFERENCES approvals (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE continuity_issues ADD CONSTRAINT continuity_issues_previous_issue_id_fk FOREIGN KEY (novel_id, previous_issue_id) REFERENCES continuity_issues (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE continuity_issue_evidence ADD CONSTRAINT continuity_issue_evidence_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE continuity_issue_evidence ADD CONSTRAINT continuity_issue_evidence_issue_id_fk FOREIGN KEY (novel_id, issue_id) REFERENCES continuity_issues (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE continuity_issue_evidence ADD CONSTRAINT continuity_issue_evidence_fact_version_id_fk FOREIGN KEY (novel_id, fact_version_id) REFERENCES fact_versions (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE setups ADD CONSTRAINT setups_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE setups ADD CONSTRAINT setups_planned_arc_id_fk FOREIGN KEY (novel_id, planned_arc_id) REFERENCES arcs (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE setups ADD CONSTRAINT setups_due_arc_id_fk FOREIGN KEY (novel_id, due_arc_id) REFERENCES arcs (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE setups ADD CONSTRAINT setups_abandon_approval_id_fk FOREIGN KEY (novel_id, abandon_approval_id) REFERENCES approvals (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE setups ADD CONSTRAINT setups_paid_off_beat_id_fk FOREIGN KEY (novel_id, paid_off_beat_id) REFERENCES setup_beats (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE setup_beats ADD CONSTRAINT setup_beats_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE setup_beats ADD CONSTRAINT setup_beats_setup_id_fk FOREIGN KEY (novel_id, setup_id) REFERENCES setups (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE setup_beats ADD CONSTRAINT setup_beats_episode_id_fk FOREIGN KEY (novel_id, episode_id) REFERENCES episodes (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE setup_beats ADD CONSTRAINT setup_beats_scene_id_fk FOREIGN KEY (novel_id, scene_id) REFERENCES scenes (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE setup_beats ADD CONSTRAINT setup_beats_manuscript_version_id_fk FOREIGN KEY (novel_id, manuscript_version_id) REFERENCES manuscript_versions (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE setup_beats ADD CONSTRAINT setup_beats_detected_by_run_id_fk FOREIGN KEY (novel_id, detected_by_run_id) REFERENCES runs (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE setup_due_changes ADD CONSTRAINT setup_due_changes_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE setup_due_changes ADD CONSTRAINT setup_due_changes_setup_id_fk FOREIGN KEY (novel_id, setup_id) REFERENCES setups (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE setup_due_changes ADD CONSTRAINT setup_due_changes_from_due_arc_id_fk FOREIGN KEY (novel_id, from_due_arc_id) REFERENCES arcs (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE setup_due_changes ADD CONSTRAINT setup_due_changes_to_due_arc_id_fk FOREIGN KEY (novel_id, to_due_arc_id) REFERENCES arcs (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE setup_due_changes ADD CONSTRAINT setup_due_changes_question_id_fk FOREIGN KEY (novel_id, question_id) REFERENCES questions (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE setup_due_changes ADD CONSTRAINT setup_due_changes_approval_id_fk FOREIGN KEY (novel_id, approval_id) REFERENCES approvals (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE setup_links ADD CONSTRAINT setup_links_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE setup_links ADD CONSTRAINT setup_links_setup_id_fk FOREIGN KEY (novel_id, setup_id) REFERENCES setups (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE setup_links ADD CONSTRAINT setup_links_pinned_fact_version_id_fk FOREIGN KEY (novel_id, pinned_fact_version_id) REFERENCES fact_versions (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE activity_log ADD CONSTRAINT activity_log_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE ontology_schema_versions ADD CONSTRAINT ontology_schema_versions_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE ontology_schema_versions ADD CONSTRAINT ontology_schema_versions_approval_id_fk FOREIGN KEY (novel_id, approval_id) REFERENCES approvals (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE timelines ADD CONSTRAINT timelines_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE timelines ADD CONSTRAINT timelines_parent_timeline_id_fk FOREIGN KEY (novel_id, parent_timeline_id) REFERENCES timelines (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE entities ADD CONSTRAINT entities_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE entities ADD CONSTRAINT entities_preferred_name_id_fk FOREIGN KEY (novel_id, preferred_name_id) REFERENCES entity_names (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE entities ADD CONSTRAINT entities_merged_into_id_fk FOREIGN KEY (novel_id, merged_into_id) REFERENCES entities (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE entities ADD CONSTRAINT entities_created_from_mention_id_fk FOREIGN KEY (novel_id, created_from_mention_id) REFERENCES mentions (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE entity_names ADD CONSTRAINT entity_names_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE entity_names ADD CONSTRAINT entity_names_entity_id_fk FOREIGN KEY (novel_id, entity_id) REFERENCES entities (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE entity_names ADD CONSTRAINT entity_names_timeline_id_fk FOREIGN KEY (novel_id, timeline_id) REFERENCES timelines (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE entity_names ADD CONSTRAINT entity_names_origin_entity_id_fk FOREIGN KEY (novel_id, origin_entity_id) REFERENCES entities (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE entity_names ADD CONSTRAINT entity_names_forbidden_by_glossary_term_id_fk FOREIGN KEY (novel_id, forbidden_by_glossary_term_id) REFERENCES glossary_terms (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE entity_names ADD CONSTRAINT entity_names_merged_conflict_with_id_fk FOREIGN KEY (novel_id, merged_conflict_with_id) REFERENCES entity_names (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE narrative_frames ADD CONSTRAINT narrative_frames_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE narrative_frames ADD CONSTRAINT narrative_frames_scene_id_fk FOREIGN KEY (novel_id, scene_id) REFERENCES scenes (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE narrative_frames ADD CONSTRAINT narrative_frames_manuscript_version_id_fk FOREIGN KEY (novel_id, manuscript_version_id) REFERENCES manuscript_versions (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE narrative_frames ADD CONSTRAINT narrative_frames_target_timeline_id_fk FOREIGN KEY (novel_id, target_timeline_id) REFERENCES timelines (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE narrative_frames ADD CONSTRAINT narrative_frames_run_id_fk FOREIGN KEY (novel_id, run_id) REFERENCES runs (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE mentions ADD CONSTRAINT mentions_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE mentions ADD CONSTRAINT mentions_manuscript_version_id_fk FOREIGN KEY (novel_id, manuscript_version_id) REFERENCES manuscript_versions (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE mentions ADD CONSTRAINT mentions_scene_id_fk FOREIGN KEY (novel_id, scene_id) REFERENCES scenes (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE mentions ADD CONSTRAINT mentions_answer_id_fk FOREIGN KEY (novel_id, answer_id) REFERENCES answers (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE mentions ADD CONSTRAINT mentions_timeline_id_fk FOREIGN KEY (novel_id, timeline_id) REFERENCES timelines (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE mentions ADD CONSTRAINT mentions_narrative_frame_id_fk FOREIGN KEY (novel_id, narrative_frame_id) REFERENCES narrative_frames (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE mentions ADD CONSTRAINT mentions_redirected_from_entity_id_fk FOREIGN KEY (novel_id, redirected_from_entity_id) REFERENCES entities (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE mentions ADD CONSTRAINT mentions_speaker_entity_id_fk FOREIGN KEY (novel_id, speaker_entity_id) REFERENCES entities (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE mentions ADD CONSTRAINT mentions_pov_entity_id_fk FOREIGN KEY (novel_id, pov_entity_id) REFERENCES entities (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE mentions ADD CONSTRAINT mentions_linked_entity_id_fk FOREIGN KEY (novel_id, linked_entity_id) REFERENCES entities (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE mentions ADD CONSTRAINT mentions_via_name_id_fk FOREIGN KEY (novel_id, via_name_id) REFERENCES entity_names (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE mentions ADD CONSTRAINT mentions_via_entity_id_fk FOREIGN KEY (novel_id, via_entity_id) REFERENCES entities (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE mentions ADD CONSTRAINT mentions_question_id_fk FOREIGN KEY (novel_id, question_id) REFERENCES questions (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE mentions ADD CONSTRAINT mentions_run_id_fk FOREIGN KEY (novel_id, run_id) REFERENCES runs (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE facts ADD CONSTRAINT facts_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE facts ADD CONSTRAINT facts_subject_entity_id_fk FOREIGN KEY (novel_id, subject_entity_id) REFERENCES entities (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE facts ADD CONSTRAINT facts_object_entity_id_fk FOREIGN KEY (novel_id, object_entity_id) REFERENCES entities (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE facts ADD CONSTRAINT facts_object_fact_id_fk FOREIGN KEY (novel_id, object_fact_id) REFERENCES facts (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE facts ADD CONSTRAINT facts_object_name_id_fk FOREIGN KEY (novel_id, object_name_id) REFERENCES entity_names (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE facts ADD CONSTRAINT facts_timeline_id_fk FOREIGN KEY (novel_id, timeline_id) REFERENCES timelines (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE facts ADD CONSTRAINT facts_from_scene_id_fk FOREIGN KEY (novel_id, from_scene_id) REFERENCES scenes (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE facts ADD CONSTRAINT facts_to_scene_id_fk FOREIGN KEY (novel_id, to_scene_id) REFERENCES scenes (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE facts ADD CONSTRAINT facts_source_scene_id_fk FOREIGN KEY (novel_id, source_scene_id) REFERENCES scenes (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE facts ADD CONSTRAINT facts_observed_as_name_id_fk FOREIGN KEY (novel_id, observed_as_name_id) REFERENCES entity_names (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE facts ADD CONSTRAINT facts_narrative_frame_id_fk FOREIGN KEY (novel_id, narrative_frame_id) REFERENCES narrative_frames (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE facts ADD CONSTRAINT facts_schema_version_id_fk FOREIGN KEY (novel_id, schema_version_id) REFERENCES ontology_schema_versions (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE fact_versions ADD CONSTRAINT fact_versions_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE fact_versions ADD CONSTRAINT fact_versions_fact_id_fk FOREIGN KEY (novel_id, fact_id) REFERENCES facts (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE fact_versions ADD CONSTRAINT fact_versions_run_id_fk FOREIGN KEY (novel_id, run_id) REFERENCES runs (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE fact_versions ADD CONSTRAINT fact_versions_approval_id_fk FOREIGN KEY (novel_id, approval_id) REFERENCES approvals (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE fact_versions ADD CONSTRAINT fact_versions_identity_decision_id_fk FOREIGN KEY (novel_id, identity_decision_id) REFERENCES identity_decisions (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE fact_cardinality_slots ADD CONSTRAINT fact_cardinality_slots_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE fact_cardinality_slots ADD CONSTRAINT fact_cardinality_slots_fact_id_fk FOREIGN KEY (novel_id, fact_id) REFERENCES facts (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE fact_cardinality_slots ADD CONSTRAINT fact_cardinality_slots_timeline_id_fk FOREIGN KEY (novel_id, timeline_id) REFERENCES timelines (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE schema_change_proposals ADD CONSTRAINT schema_change_proposals_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE schema_change_proposals ADD CONSTRAINT schema_change_proposals_question_id_fk FOREIGN KEY (novel_id, question_id) REFERENCES questions (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE schema_change_proposals ADD CONSTRAINT schema_change_proposals_approval_id_fk FOREIGN KEY (novel_id, approval_id) REFERENCES approvals (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE schema_change_proposals ADD CONSTRAINT schema_change_proposals_resulting_schema_version_id_fk FOREIGN KEY (novel_id, resulting_schema_version_id) REFERENCES ontology_schema_versions (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE glossary_terms ADD CONSTRAINT glossary_terms_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE glossary_terms ADD CONSTRAINT glossary_terms_linked_entity_id_fk FOREIGN KEY (novel_id, linked_entity_id) REFERENCES entities (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE identity_decisions ADD CONSTRAINT identity_decisions_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE identity_decisions ADD CONSTRAINT identity_decisions_survivor_entity_id_fk FOREIGN KEY (novel_id, survivor_entity_id) REFERENCES entities (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE identity_decisions ADD CONSTRAINT identity_decisions_new_entity_id_fk FOREIGN KEY (novel_id, new_entity_id) REFERENCES entities (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE identity_decisions ADD CONSTRAINT identity_decisions_relink_from_entity_id_fk FOREIGN KEY (novel_id, relink_from_entity_id) REFERENCES entities (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE identity_decisions ADD CONSTRAINT identity_decisions_relink_to_entity_id_fk FOREIGN KEY (novel_id, relink_to_entity_id) REFERENCES entities (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE identity_decisions ADD CONSTRAINT identity_decisions_question_id_fk FOREIGN KEY (novel_id, question_id) REFERENCES questions (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE identity_decisions ADD CONSTRAINT identity_decisions_approval_id_fk FOREIGN KEY (novel_id, approval_id) REFERENCES approvals (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE identity_decision_moves ADD CONSTRAINT identity_decision_moves_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE identity_decision_moves ADD CONSTRAINT identity_decision_moves_decision_id_fk FOREIGN KEY (novel_id, decision_id) REFERENCES identity_decisions (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE identity_decision_moves ADD CONSTRAINT identity_decision_moves_from_entity_id_fk FOREIGN KEY (novel_id, from_entity_id) REFERENCES entities (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE identity_decision_moves ADD CONSTRAINT identity_decision_moves_to_entity_id_fk FOREIGN KEY (novel_id, to_entity_id) REFERENCES entities (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE identity_decision_moves ADD CONSTRAINT identity_decision_moves_created_fact_version_id_fk FOREIGN KEY (novel_id, created_fact_version_id) REFERENCES fact_versions (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE entity_distinct_pairs ADD CONSTRAINT entity_distinct_pairs_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE entity_distinct_pairs ADD CONSTRAINT entity_distinct_pairs_entity_a_id_fk FOREIGN KEY (novel_id, entity_a_id) REFERENCES entities (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE entity_distinct_pairs ADD CONSTRAINT entity_distinct_pairs_entity_b_id_fk FOREIGN KEY (novel_id, entity_b_id) REFERENCES entities (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE entity_distinct_pairs ADD CONSTRAINT entity_distinct_pairs_decision_id_fk FOREIGN KEY (novel_id, decision_id) REFERENCES identity_decisions (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE export_jobs ADD CONSTRAINT export_jobs_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;

-- ── indexes, partial unique invariants, triggers ──
CREATE INDEX health_check_results_kind_checked_idx ON health_check_results (kind, checked_at DESC);
CREATE UNIQUE INDEX series_bibles_one_approved ON series_bibles (novel_id) WHERE status = 'approved' /* INV-BIB-01 */;
CREATE UNIQUE INDEX concept_sessions_one_open /* INV-CON-01 */ ON concept_sessions (novel_id) WHERE status IN ('active', 'awaiting_approval', 'paused');
CREATE UNIQUE INDEX concept_briefs_one_approved /* INV-CON-02 */ ON concept_briefs (novel_id) WHERE status = 'approved';
CREATE UNIQUE INDEX concept_briefs_one_approved_direction /* INV-CON-14 */ ON concept_briefs (novel_id) WHERE status = 'approved_direction';
CREATE INDEX episodes_arc_idx ON episodes (novel_id, arc_id);
CREATE TRIGGER manuscript_versions_append_only BEFORE UPDATE ON manuscript_versions FOR EACH ROW EXECUTE FUNCTION ncs_forbid_update() /* INV-MV-01 */;
CREATE UNIQUE INDEX scenes_active_ord ON scenes (novel_id, episode_id, ord) WHERE status = 'active';
CREATE UNIQUE INDEX episode_recaps_uniq /* INV-RC-01 */ ON episode_recaps (novel_id, episode_id, source_version_id, layer, COALESCE(pov_entity_id, ''));
CREATE INDEX tasks_ready_idx ON tasks (priority DESC, created_at) WHERE status = 'ready';
CREATE INDEX tasks_status_idx ON tasks (novel_id, status);
CREATE INDEX tasks_target_idx ON tasks (novel_id, target_type, target_id);
CREATE INDEX task_dependencies_depends_idx ON task_dependencies (novel_id, depends_on_task_id);
CREATE INDEX wake_requests_pending_idx ON wake_requests (not_before_at, created_at) WHERE status = 'pending';
CREATE INDEX runs_task_idx ON runs (novel_id, task_id);
CREATE INDEX runs_running_idx ON runs (status) WHERE status IN ('queued', 'running');
CREATE INDEX provider_calls_request_hash_idx ON provider_calls (novel_id, request_hash) /* INV-PC-02 reuse */;
CREATE INDEX provider_calls_sent_idx ON provider_calls (status) WHERE status IN ('prepared', 'sent');
CREATE INDEX budget_reservations_active_idx ON budget_reservations (novel_id, category) WHERE status = 'active';
CREATE UNIQUE INDEX cost_events_one_per_call /* INV-COST-01 */ ON cost_events (novel_id, provider_call_id) WHERE provider_call_id IS NOT NULL;
CREATE INDEX cost_events_window_idx ON cost_events (novel_id, category, occurred_at);
CREATE TRIGGER cost_events_append_only BEFORE UPDATE ON cost_events FOR EACH ROW EXECUTE FUNCTION ncs_forbid_update() /* INV-COST-04 */;
CREATE INDEX questions_status_idx ON questions (novel_id, status);
CREATE UNIQUE INDEX answers_one_accepted /* INV-Q-03, FR-MSG-18 */ ON answers (novel_id, question_id) WHERE disposition = 'accepted';
CREATE UNIQUE INDEX answer_sessions_one_active /* INV-AS-01 */ ON answer_sessions (novel_id, channel_id, responder_external_ref) WHERE status = 'active';
CREATE UNIQUE INDEX approvals_one_pending /* INV-APR-01 */ ON approvals (novel_id, subject_type, subject_id, approval_type) WHERE status = 'pending';
CREATE UNIQUE INDEX channels_one_web /* INV-CH-01 */ ON channels (novel_id) WHERE kind = 'web';
CREATE INDEX messenger_inbox_work_idx ON messenger_inbox (next_attempt_at, received_at) WHERE status IN ('received', 'retry');
CREATE INDEX messenger_outbox_work_idx ON messenger_outbox (next_attempt_at, created_at) WHERE status IN ('pending', 'retry');
CREATE INDEX continuity_issues_episode_idx ON continuity_issues (novel_id, episode_id, status);
CREATE INDEX continuity_issues_dedupe_idx ON continuity_issues (novel_id, dedupe_key);
CREATE INDEX setup_beats_setup_idx ON setup_beats (novel_id, setup_id);
CREATE INDEX activity_log_target_idx ON activity_log (novel_id, target_type, target_id, seq);
CREATE INDEX activity_log_actor_idx ON activity_log (novel_id, actor_type, actor_id, seq);
CREATE INDEX activity_log_novel_seq_idx ON activity_log (novel_id, seq);
CREATE TRIGGER activity_log_append_only BEFORE UPDATE ON activity_log FOR EACH ROW EXECUTE FUNCTION ncs_forbid_update();
CREATE UNIQUE INDEX timelines_one_default ON timelines (novel_id) WHERE is_default;
CREATE UNIQUE INDEX entities_concept_key ON entities (novel_id, concept_character_key) WHERE status = 'active' AND concept_character_key IS NOT NULL;
CREATE INDEX entities_type_idx ON entities (novel_id, entity_type, status);
CREATE UNIQUE INDEX entity_names_one_preferred /* INV-ONT-02 */ ON entity_names (novel_id, entity_id) WHERE is_preferred AND status = 'active';
CREATE INDEX entity_names_normalized_idx ON entity_names (novel_id, normalized_key);
CREATE INDEX entity_names_translit_idx ON entity_names (novel_id, translit_key);
CREATE INDEX entity_names_entity_idx ON entity_names (novel_id, entity_id);
CREATE INDEX mentions_linked_idx ON mentions (novel_id, linked_entity_id);
CREATE INDEX mentions_scene_idx ON mentions (novel_id, scene_id);
CREATE INDEX mentions_ambiguous_idx ON mentions (novel_id) WHERE link_status = 'ambiguous';
CREATE INDEX facts_subject_idx ON facts (novel_id, subject_entity_id, predicate);
CREATE INDEX facts_object_idx ON facts (novel_id, object_entity_id) WHERE object_entity_id IS NOT NULL;
CREATE INDEX facts_slot_idx ON facts (novel_id, timeline_id, slot_key);
CREATE UNIQUE INDEX fact_versions_one_current ON fact_versions (novel_id, fact_id) WHERE superseded_at IS NULL;
CREATE UNIQUE INDEX glossary_terms_active_key ON glossary_terms (novel_id, normalized_key) WHERE status = 'active';
CREATE INDEX identity_decision_moves_decision_idx ON identity_decision_moves (novel_id, decision_id);

-- ── btree_gist EXCLUDE constraints (INV-ARC-01, INV-ONT-03, INV-ONT-05) ──
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist') THEN
    EXECUTE 'ALTER TABLE arcs ADD CONSTRAINT arcs_no_overlap /* INV-ARC-01 */ EXCLUDE USING gist (novel_id WITH =, int4range(planned_episode_from, planned_episode_to, ''[]'') WITH &&) WHERE (status <> ''cancelled'')';
    EXECUTE 'ALTER TABLE entity_names ADD CONSTRAINT entity_names_no_dup /* INV-ONT-03 */ EXCLUDE USING gist (novel_id WITH =, entity_id WITH =, normalized_key WITH =, name_kind WITH =, (COALESCE(timeline_id, ''*'')) WITH =, story_range WITH &&) WHERE (status <> ''retired'')';
    EXECUTE 'ALTER TABLE fact_cardinality_slots ADD CONSTRAINT fact_cardinality_slots_no_overlap /* INV-ONT-05 */ EXCLUDE USING gist (novel_id WITH =, timeline_id WITH =, slot_key WITH =, story_range WITH &&)';
  ELSE
    RAISE WARNING 'btree_gist missing: EXCLUDE constraints not created';
  END IF;
END $$;

-- ── pg_trgm (optional, S-5) ──
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'CREATE INDEX entity_names_surface_trgm ON entity_names USING gin (surface gin_trgm_ops)';
  END IF;
END $$;

-- ── enum column markers (check-enum-sync) ──
COMMENT ON COLUMN users.role IS 'enum:user_role';
COMMENT ON COLUMN length_profiles.count_basis IS 'enum:count_basis';
COMMENT ON COLUMN provider_profiles.provider_kind IS 'enum:provider_kind';
COMMENT ON COLUMN messenger_bots.kind IS 'enum:channel_kind';
COMMENT ON COLUMN messenger_bots.receive_mode IS 'enum:telegram_receive_mode';
COMMENT ON COLUMN messenger_bots.status IS 'enum:channel_status';
COMMENT ON COLUMN secrets.provider IS 'enum:secret_provider';
COMMENT ON COLUMN backup_records.status IS 'enum:backup_status';
COMMENT ON COLUMN backup_records.trigger IS 'enum:backup_trigger';
COMMENT ON COLUMN backup_records.mode IS 'enum:backup_mode';
COMMENT ON COLUMN health_check_results.kind IS 'enum:health_check_kind';
COMMENT ON COLUMN health_check_results.status IS 'enum:health_status';
COMMENT ON COLUMN health_check_results.target_ref_type IS 'enum:ref_type';
COMMENT ON COLUMN novels.age_rating IS 'enum:age_rating';
COMMENT ON COLUMN novels.status IS 'enum:novel_status';
COMMENT ON COLUMN novels.autonomy_level IS 'enum:autonomy_level';
COMMENT ON COLUMN novels.question_threshold IS 'enum:question_threshold';
COMMENT ON COLUMN novels.media_autonomy IS 'enum:media_autonomy';
COMMENT ON COLUMN novels.media_target_basis IS 'enum:media_target_basis';
COMMENT ON COLUMN novels.publish_policy IS 'enum:publish_policy';
COMMENT ON COLUMN novels.default_narration_mode IS 'enum:narration_mode';
COMMENT ON COLUMN novels.pause_reason IS 'enum:pause_reason';
COMMENT ON COLUMN series_bibles.status IS 'enum:series_bible_status';
COMMENT ON COLUMN series_bibles.author_actor_type IS 'enum:actor_type';
COMMENT ON COLUMN arcs.status IS 'enum:arc_status';
COMMENT ON COLUMN novel_counters.counter_kind IS 'enum:novel_counter_kind';
COMMENT ON COLUMN concept_sessions.purpose IS 'enum:concept_session_purpose';
COMMENT ON COLUMN concept_sessions.entry_mode IS 'enum:concept_entry_mode';
COMMENT ON COLUMN concept_sessions.status IS 'enum:concept_session_status';
COMMENT ON COLUMN concept_sessions.stage IS 'enum:concept_stage';
COMMENT ON COLUMN concept_sessions.pause_reason IS 'enum:concept_pause_reason';
COMMENT ON COLUMN concept_messages.author_kind IS 'enum:concept_message_author';
COMMENT ON COLUMN concept_messages.kind IS 'enum:concept_message_kind';
COMMENT ON COLUMN concept_briefs.status IS 'enum:concept_brief_status';
COMMENT ON COLUMN concept_briefs.author_actor_type IS 'enum:actor_type';
COMMENT ON COLUMN concept_briefs.entry_mode IS 'enum:concept_entry_mode';
COMMENT ON COLUMN episodes.status IS 'enum:episode_status';
COMMENT ON COLUMN episodes.block_reasons IS 'enum:episode_block_reason';
COMMENT ON COLUMN episodes.last_rework_from IS 'enum:rework_from';
COMMENT ON COLUMN episodes.approved_by_actor_type IS 'enum:actor_type';
COMMENT ON COLUMN episodes.published_by_actor_type IS 'enum:actor_type';
COMMENT ON COLUMN manuscript_versions.kind IS 'enum:manuscript_version_kind';
COMMENT ON COLUMN manuscript_versions.stage IS 'enum:episode_status';
COMMENT ON COLUMN manuscript_versions.author_actor_type IS 'enum:actor_type';
COMMENT ON COLUMN manuscript_versions.agent_role IS 'enum:agent_role';
COMMENT ON COLUMN episode_rejections.rework_from IS 'enum:rework_from';
COMMENT ON COLUMN scenes.status IS 'enum:scene_status';
COMMENT ON COLUMN scenes.narration_mode IS 'enum:narration_mode';
COMMENT ON COLUMN scene_participants.participation IS 'enum:scene_participation';
COMMENT ON COLUMN episode_recaps.layer IS 'enum:recap_layer';
COMMENT ON COLUMN tasks.kind IS 'enum:task_kind';
COMMENT ON COLUMN tasks.agent_role IS 'enum:agent_role';
COMMENT ON COLUMN tasks.target_type IS 'enum:target_type';
COMMENT ON COLUMN tasks.status IS 'enum:task_status';
COMMENT ON COLUMN tasks.block_reason IS 'enum:task_block_reason';
COMMENT ON COLUMN tasks.blocked_ref_type IS 'enum:ref_type';
COMMENT ON COLUMN tasks.created_by_actor_type IS 'enum:actor_type';
COMMENT ON COLUMN wake_requests.reason IS 'enum:wake_reason';
COMMENT ON COLUMN wake_requests.status IS 'enum:wake_status';
COMMENT ON COLUMN wake_requests.source_ref_type IS 'enum:ref_type';
COMMENT ON COLUMN runs.agent_role IS 'enum:agent_role';
COMMENT ON COLUMN runs.status IS 'enum:run_status';
COMMENT ON COLUMN runs.stop_reason IS 'enum:run_stop_reason';
COMMENT ON COLUMN runs.error_family IS 'enum:error_family';
COMMENT ON COLUMN role_model_bindings.agent_role IS 'enum:agent_role';
COMMENT ON COLUMN provider_calls.provider_kind IS 'enum:provider_kind';
COMMENT ON COLUMN provider_calls.status IS 'enum:provider_call_status';
COMMENT ON COLUMN provider_calls.error_family IS 'enum:error_family';
COMMENT ON COLUMN budget_policies.category IS 'enum:budget_category';
COMMENT ON COLUMN budget_policies.budget_window IS 'enum:budget_window';
COMMENT ON COLUMN budget_policies.unpriced_usage_policy IS 'enum:unpriced_usage_policy';
COMMENT ON COLUMN budget_policies.status IS 'enum:budget_status';
COMMENT ON COLUMN budget_reservations.category IS 'enum:cost_category';
COMMENT ON COLUMN budget_reservations.status IS 'enum:reservation_status';
COMMENT ON COLUMN cost_events.agent_role IS 'enum:agent_role';
COMMENT ON COLUMN cost_events.category IS 'enum:cost_category';
COMMENT ON COLUMN cost_events.cost_basis IS 'enum:cost_basis';
COMMENT ON COLUMN questions.grade IS 'enum:question_grade';
COMMENT ON COLUMN questions.question_type IS 'enum:question_type';
COMMENT ON COLUMN questions.topic IS 'enum:question_topic';
COMMENT ON COLUMN questions.status IS 'enum:question_status';
COMMENT ON COLUMN questions.blocking_basis IS 'enum:blocking_basis';
COMMENT ON COLUMN questions.asked_by_role IS 'enum:agent_role';
COMMENT ON COLUMN questions.resolution_source IS 'enum:resolution_source';
COMMENT ON COLUMN question_links.ref_type IS 'enum:ref_type';
COMMENT ON COLUMN question_deliveries.state IS 'enum:question_delivery_state';
COMMENT ON COLUMN answers.disposition IS 'enum:answer_disposition';
COMMENT ON COLUMN answers.late_resolution IS 'enum:late_answer_resolution';
COMMENT ON COLUMN answers.late_resolution_ref_type IS 'enum:ref_type';
COMMENT ON COLUMN answer_interpretations.status IS 'enum:interpretation_status';
COMMENT ON COLUMN answer_reflections.status IS 'enum:reflection_status';
COMMENT ON COLUMN answer_reflection_items.change_kind IS 'enum:reflection_change_kind';
COMMENT ON COLUMN answer_reflection_items.ref_type IS 'enum:ref_type';
COMMENT ON COLUMN answer_sessions.status IS 'enum:answer_session_status';
COMMENT ON COLUMN approvals.approval_type IS 'enum:approval_type';
COMMENT ON COLUMN approvals.status IS 'enum:approval_status';
COMMENT ON COLUMN approvals.subject_type IS 'enum:ref_type';
COMMENT ON COLUMN approvals.requested_by_actor_type IS 'enum:actor_type';
COMMENT ON COLUMN approvals.rework_from IS 'enum:rework_from';
COMMENT ON COLUMN digest_batches.kind IS 'enum:digest_kind';
COMMENT ON COLUMN digest_batches.status IS 'enum:digest_status';
COMMENT ON COLUMN channels.kind IS 'enum:channel_kind';
COMMENT ON COLUMN channels.status IS 'enum:channel_status';
COMMENT ON COLUMN channels.last_health_status IS 'enum:health_status';
COMMENT ON COLUMN channel_binding_tokens.channel_kind IS 'enum:channel_kind';
COMMENT ON COLUMN channel_binding_tokens.status IS 'enum:binding_token_status';
COMMENT ON COLUMN messenger_inbox.event_kind IS 'enum:inbox_event_kind';
COMMENT ON COLUMN messenger_inbox.status IS 'enum:inbox_status';
COMMENT ON COLUMN messenger_inbox.ignore_reason IS 'enum:inbox_ignore_reason';
COMMENT ON COLUMN messenger_outbox.kind IS 'enum:outbox_kind';
COMMENT ON COLUMN messenger_outbox.status IS 'enum:outbox_status';
COMMENT ON COLUMN continuity_issues.kind IS 'enum:continuity_issue_kind';
COMMENT ON COLUMN continuity_issues.severity IS 'enum:issue_severity';
COMMENT ON COLUMN continuity_issues.status IS 'enum:continuity_issue_status';
COMMENT ON COLUMN continuity_issues.detector IS 'enum:issue_detector';
COMMENT ON COLUMN continuity_issues.fix_scope IS 'enum:issue_fix_scope';
COMMENT ON COLUMN continuity_issues.resolution_kind IS 'enum:issue_resolution_kind';
COMMENT ON COLUMN continuity_issues.resolved_by_actor_type IS 'enum:actor_type';
COMMENT ON COLUMN continuity_issue_evidence.ref_type IS 'enum:ref_type';
COMMENT ON COLUMN setups.importance IS 'enum:setup_importance';
COMMENT ON COLUMN setups.narrative_status IS 'enum:setup_narrative_status';
COMMENT ON COLUMN setups.canon_status IS 'enum:canon_status';
COMMENT ON COLUMN setups.due_kind IS 'enum:setup_due_kind';
COMMENT ON COLUMN setups.created_by_actor_type IS 'enum:actor_type';
COMMENT ON COLUMN setup_beats.kind IS 'enum:setup_beat_kind';
COMMENT ON COLUMN setup_beats.status IS 'enum:setup_beat_status';
COMMENT ON COLUMN setup_beats.canon_status IS 'enum:canon_status';
COMMENT ON COLUMN setup_due_changes.from_due_kind IS 'enum:setup_due_kind';
COMMENT ON COLUMN setup_due_changes.to_due_kind IS 'enum:setup_due_kind';
COMMENT ON COLUMN setup_due_changes.changed_by_actor_type IS 'enum:actor_type';
COMMENT ON COLUMN setup_links.ref_type IS 'enum:ref_type';
COMMENT ON COLUMN activity_log.actor_type IS 'enum:actor_type';
COMMENT ON COLUMN activity_log.target_type IS 'enum:ref_type';
COMMENT ON COLUMN timelines.kind IS 'enum:timeline_kind';
COMMENT ON COLUMN entities.status IS 'enum:entity_status';
COMMENT ON COLUMN entities.created_by_actor_type IS 'enum:actor_type';
COMMENT ON COLUMN entity_names.name_kind IS 'enum:name_kind';
COMMENT ON COLUMN entity_names.status IS 'enum:entity_name_status';
COMMENT ON COLUMN entity_names.surface_visibility IS 'enum:name_visibility';
COMMENT ON COLUMN entity_names.identity_visibility IS 'enum:name_visibility';
COMMENT ON COLUMN entity_names.source_kind IS 'enum:fact_source_kind';
COMMENT ON COLUMN entity_names.source_ref_type IS 'enum:ref_type';
COMMENT ON COLUMN narrative_frames.frame_kind IS 'enum:narrative_frame_kind';
COMMENT ON COLUMN narrative_frames.source_kind IS 'enum:fact_source_kind';
COMMENT ON COLUMN mentions.source_kind IS 'enum:mention_source_kind';
COMMENT ON COLUMN mentions.mention_kind IS 'enum:mention_kind';
COMMENT ON COLUMN mentions.link_status IS 'enum:link_status';
COMMENT ON COLUMN facts.fact_kind IS 'enum:fact_kind';
COMMENT ON COLUMN facts.knowledge_stance IS 'enum:knowledge_stance';
COMMENT ON COLUMN facts.canon_status IS 'enum:canon_status';
COMMENT ON COLUMN facts.source_kind IS 'enum:fact_source_kind';
COMMENT ON COLUMN facts.source_ref_type IS 'enum:ref_type';
COMMENT ON COLUMN fact_versions.canon_status IS 'enum:canon_status';
COMMENT ON COLUMN fact_versions.recorded_by_actor_type IS 'enum:actor_type';
COMMENT ON COLUMN fact_versions.change_reason IS 'enum:fact_change_reason';
COMMENT ON COLUMN schema_change_proposals.kind IS 'enum:schema_change_kind';
COMMENT ON COLUMN schema_change_proposals.status IS 'enum:schema_change_status';
COMMENT ON COLUMN schema_change_proposals.proposed_by_actor_type IS 'enum:actor_type';
COMMENT ON COLUMN schema_change_proposals.decided_by_actor_type IS 'enum:actor_type';
COMMENT ON COLUMN glossary_terms.status IS 'enum:glossary_term_status';
COMMENT ON COLUMN glossary_terms.source_kind IS 'enum:glossary_source_kind';
COMMENT ON COLUMN identity_decisions.kind IS 'enum:identity_decision_kind';
COMMENT ON COLUMN identity_decisions.status IS 'enum:identity_decision_status';
COMMENT ON COLUMN identity_decisions.proposed_by_actor_type IS 'enum:actor_type';
COMMENT ON COLUMN identity_decisions.decided_by_actor_type IS 'enum:actor_type';
COMMENT ON COLUMN identity_decisions.reverted_by_actor_type IS 'enum:actor_type';
COMMENT ON COLUMN export_jobs.scope_kind IS 'enum:export_scope_kind';
COMMENT ON COLUMN export_jobs.export_format IS 'enum:export_format';
COMMENT ON COLUMN export_jobs.version_selection IS 'enum:export_version_selection';
COMMENT ON COLUMN export_jobs.requested_by_actor_type IS 'enum:actor_type';
