-- 0010_concept_turn_ceiling — 컨셉 대화 턴 상한을 숨은 안전 상한으로 (module concept).
-- 대화는 브리프 필수 항목이 모두 확정될 때까지 이어지고, concept.max_turns는 기본 40 → 200으로 올라갑니다.
-- 이전 기본값으로 만든 진행 중 세션(active·paused·awaiting_approval)도 같은 여유를 갖도록 상한을 160턴 올립니다(연장분 유지).
ALTER TABLE concept_sessions ALTER COLUMN turn_limit SET DEFAULT 200;
UPDATE concept_sessions SET turn_limit = turn_limit + 160 WHERE status IN ('active', 'paused', 'awaiting_approval') AND turn_limit < 200;
