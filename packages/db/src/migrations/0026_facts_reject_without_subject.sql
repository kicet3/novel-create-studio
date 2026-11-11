-- 0026_facts_reject_without_subject — 주어 엔터티가 아직 없는 후보 사실도 기각할 수 있게 합니다.
-- INV-ONT-08(후보가 아닌 사실은 주어 엔터티가 있어야 한다)은 살아 있는 사실(approved·published_locked)에 대한 규칙입니다.
-- 그런데 수정 반영(revision fact-reconcile)이 "더는 본문이 뒷받침하지 않는" 후보 사실을 rejected 로 바꿀 때, 주어가 미해결
-- 이름(subject_entity_id NULL)인 후보는 facts_ck_2 에 걸려 트랜잭션 전체가 실패하고 화가 extraction_failure 로 막혔습니다.
-- rejected 는 종결 상태이므로 주어 없이도 무방합니다. retracted 는 approved 이후에만 가능하므로 주어가 늘 있습니다.
ALTER TABLE facts DROP CONSTRAINT IF EXISTS facts_ck_2;
ALTER TABLE facts ADD CONSTRAINT facts_ck_2 CHECK (subject_entity_id IS NOT NULL OR canon_status IN ('candidate', 'rejected') /* INV-ONT-08 */);
