-- 0027_episode_delete — 화 삭제(원고 폐기): fact_versions.change_reason 에 'episode_deleted' 를 추가합니다.
-- 생성한 화의 원고를 삭제하면 그 화에서 추출된 사실은 rejected(후보) / retracted(승인) 로 끝나고, 그 이유를
-- user_edit(값 편집)·canon_change(승격/강등) 와 구분해 기록합니다. 0001_init 의 CHECK 제약을 같은 이름으로 다시 만듭니다.
ALTER TABLE fact_versions DROP CONSTRAINT IF EXISTS fact_versions_change_reason_enum;
ALTER TABLE fact_versions ADD CONSTRAINT fact_versions_change_reason_enum CHECK (change_reason IN ('extracted', 'user_edit', 'canon_change', 'retcon', 'identity_merge', 'identity_split', 'identity_relink', 'identity_revert', 'revert', 'range_recalc', 'range_close', 'resolution_filled', 'reinterpretation', 'episode_deleted'));
