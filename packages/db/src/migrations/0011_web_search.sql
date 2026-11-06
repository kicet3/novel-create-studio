-- 0011_web_search — 인터넷 검색(설계 추가, module llm + novel + concept).
-- 작품별 설정: 컨셉 대화·기획서·전체 구성·세계관 생성의 LLM 호출이 웹 검색을 쓸 수 있는지(기본 켬)와 호출 1회당 검색 상한.
-- 검색 결과 출처는 provider_calls.response(jsonb)의 webSearch.citations에 남고, 컨셉 답변에는 sources로 복사합니다.
ALTER TABLE novels ADD COLUMN web_search_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE novels ADD COLUMN web_search_max_uses integer NOT NULL DEFAULT 3;
ALTER TABLE novels ADD CONSTRAINT novels_ck_web_search_max_uses CHECK (web_search_max_uses BETWEEN 1 AND 10);
ALTER TABLE concept_messages ADD COLUMN sources jsonb;
