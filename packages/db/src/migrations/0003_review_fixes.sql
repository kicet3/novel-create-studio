-- 0003_review_fixes — integration review fixes.

-- ── system ──
-- health check kind `secrets` (08 §5.3 CFG-8: stored secrets that the master key can no longer decrypt)
ALTER TABLE health_check_results DROP CONSTRAINT health_check_results_kind_enum;
ALTER TABLE health_check_results ADD CONSTRAINT health_check_results_kind_enum
  CHECK (kind IN ('llm_key', 'bot_token', 'channel_reach', 'database', 'ontology_integrity', 'backup_location', 'storage', 'secrets'));
