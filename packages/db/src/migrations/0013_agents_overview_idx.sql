-- 0013_agents_overview_idx — 에이전트 현황(읽기 전용) 조회용 인덱스(module orchestration).
-- 실행 타임라인·오늘 사용량은 "생성 시각 ≥ 범위 시작 − 실행 시간 상한"으로 실행을 좁혀 읽습니다. 진행 중인 실행은 runs_running_idx로 따로 읽습니다.
CREATE INDEX IF NOT EXISTS runs_novel_created_idx ON runs (novel_id, created_at);
