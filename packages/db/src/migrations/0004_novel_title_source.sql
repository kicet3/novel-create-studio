-- 0004_novel_title_source — 작품 제목 출처(가제 자동 생성).
-- provisional: 작품 생성 때 제목을 비워 둬 붙은 임시 제목("제목 미정")
-- auto: 컨셉 대화에서 concept_partner가 낸 가제를 자동 반영
-- user: 사용자가 직접 정하거나 확정한 제목 — 자동 갱신 대상이 아님
ALTER TABLE novels ADD COLUMN title_source text NOT NULL DEFAULT 'user';
ALTER TABLE novels ADD CONSTRAINT novels_title_source_enum CHECK (title_source IN ('provisional', 'auto', 'user'));
COMMENT ON COLUMN novels.title_source IS 'enum:novel_title_source';
UPDATE novels SET title_source = 'provisional' WHERE title = '제목 미정';
