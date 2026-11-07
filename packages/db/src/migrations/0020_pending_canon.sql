-- 0020_pending_canon — 미확정 사실 선행 집필(설계 추가, module manuscript + continuity).
-- full_auto + 화 자동 승인 끔: 앞 화가 승인을 기다리는 동안 다음 화를 미리 씁니다. 앞 화에서 나온 후보 사실은
-- 다음 화 아웃라인·초고 컨텍스트에 "미확정 사실 (앞 화 승인 대기 — 확정 설정이 우선)"으로 들어가고(컨텍스트 스냅숏 fact_version_ids에 기록),
-- 앞 화가 바뀌거나 반려되면 그 사실을 따라 쓴 뒷 화의 연속성 검사를 다시 돌립니다.
-- 연속성 이슈 종류 pending_canon_changed: 승인 대기 중인 뒷 화가 따른 앞 화의 미확정 설정이 바뀜(medium, 근거 = 사실)
ALTER TABLE continuity_issues DROP CONSTRAINT continuity_issues_kind_enum;
ALTER TABLE continuity_issues ADD CONSTRAINT continuity_issues_kind_enum CHECK (kind IN ('appearance', 'age', 'relationship', 'ability_rule', 'location_travel', 'death_state', 'character_knowledge', 'identity_leak', 'schema_violation', 'published_canon_conflict', 'answer_constraint', 'human_edit_conflict', 'setup_missing', 'setup_contradiction', 'glossary_spelling', 'safety_age_rating', 'safety_minor_sexual', 'safety_real_person', 'plan_deviation', 'opening_continuity', 'pending_canon_changed'));
