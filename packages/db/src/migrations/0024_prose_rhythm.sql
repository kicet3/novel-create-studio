-- 0024_prose_rhythm — 문장 리듬(설계 추가, module novel + manuscript).
-- 짧은 평서문('~였다. ~다.')을 연달아 끊어 쓰면 읽기 어색합니다. 작품 설정 "문장 리듬"(concise 간결 / normal 보통(기본) /
-- flowing 유려)이 리듬 지표의 기준값을 정하고, 버전마다 지표(문장 수·평균 길이·단문 비율·최장 단문 연속·지적 문단)를
-- manuscript_versions.rhythm에 남깁니다(버전은 추가 전용이라 저장할 때 한 번만 씁니다). 지적 문단이 있으면 다듬기 단계가
-- 그 문단만 한 번 더 고칩니다.
ALTER TABLE novels ADD COLUMN prose_rhythm text NOT NULL DEFAULT 'normal';
ALTER TABLE novels ADD CONSTRAINT novels_prose_rhythm_check CHECK (prose_rhythm IN ('concise', 'normal', 'flowing'));

ALTER TABLE manuscript_versions ADD COLUMN rhythm jsonb;

-- [문체 다듬기]: 승인 대기·승인된 화에서 만든 리듬 다듬기 후보 버전(현재 버전은 그대로). 작가가 비교한 뒤 [적용]하면
-- 사람 수정 규칙(E16)으로 새 버전이 되고, [버리기]하면 비웁니다.
ALTER TABLE episodes ADD COLUMN rhythm_candidate_version_id text;
ALTER TABLE episodes ADD CONSTRAINT episodes_rhythm_candidate_fk FOREIGN KEY (novel_id, rhythm_candidate_version_id) REFERENCES manuscript_versions (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
