-- 0002_integration — DDL requested by the module agents during MVP-α integration (CONVENTIONS §0).
-- Additive only: new nullable/defaulted columns, one NOT NULL relaxation, indexes.

-- ── orchestration ──
-- one running manuscript writer per episode (04 §3.3; also enforced in the engine claim)
CREATE UNIQUE INDEX tasks_one_manuscript_writer_per_episode ON tasks (novel_id, episode_id)
  WHERE status = 'running' AND episode_id IS NOT NULL
    AND kind IN ('outline_episode', 'draft_episode', 'revise_episode', 'polish_episode');
CREATE INDEX wake_requests_task_pending_idx ON wake_requests (novel_id, task_id) WHERE status = 'pending';

-- ── budget ──
CREATE INDEX budget_reservations_run_idx ON budget_reservations (novel_id, run_id) WHERE status = 'active';
-- provider identity of the attached call, so reclaim after a restart can close it as `unknown` (FR-AGT-02 (3))
ALTER TABLE budget_reservations ADD COLUMN call_meta jsonb;

-- ── agents ──
-- FR-AGT-04: manuscript versions a context pack read (section refs.versionIds)
ALTER TABLE context_snapshots ADD COLUMN manuscript_version_ids text[] NOT NULL DEFAULT '{}';

-- ── manuscript ──
-- E11 (approved → revising by revision request) and full_auto episodes have no approval to link
ALTER TABLE episode_rejections ALTER COLUMN approval_id DROP NOT NULL;

-- ── ontology ──
CREATE INDEX fact_versions_current_episode_idx ON fact_versions (novel_id, (content->>'episodeId')) WHERE superseded_at IS NULL;

-- ── foreshadow ──
CREATE INDEX setup_beats_planned_ep_idx ON setup_beats (novel_id, planned_episode_no);
CREATE INDEX setup_beats_episode_idx ON setup_beats (novel_id, episode_id);
CREATE INDEX setups_planned_arc_idx ON setups (novel_id, planned_arc_id);

-- ── hitl ──
-- hard idempotency of answer submissions (web request id / messenger inbox id)
CREATE UNIQUE INDEX answers_source_key_uq ON answers (novel_id, question_id, (payload->>'source_key'));
CREATE INDEX questions_parent_idx ON questions (novel_id, parent_question_id) WHERE parent_question_id IS NOT NULL;

-- ── messaging ──
CREATE INDEX messenger_outbox_provider_ref_idx ON messenger_outbox (channel_id, provider_message_ref) WHERE provider_message_ref IS NOT NULL;

-- ── concept ──
CREATE INDEX concept_sessions_idle ON concept_sessions (status, last_user_message_at) WHERE status = 'active';
