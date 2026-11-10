-- 0023_episode_units — 에피소드 묶음(설계 추가, module manuscript + novel).
-- 웹소설은 한 에피소드(이야기 단위)를 여러 화로 나눠 「제목 (1)」「제목 (2)」처럼 올립니다. 플롯(아크) 안의 연속된 화들을
-- 하나의 에피소드 묶음(episode_units)으로 묶고, 화마다 묶음과 몇 번째 화인지(unit_part_no)를 둡니다.
-- episodes.title은 화면·공개 사이트에 그대로 쓰는 표시 제목이며, 묶음을 적용할 때 "<묶음 제목> (n)"으로 맞춥니다
-- (묶음이 한 화뿐이면 번호 없이 묶음 제목). 공개된 화의 제목은 작가가 명시적으로 고를 때만 바뀝니다.
CREATE TABLE episode_units (
  id text NOT NULL,
  novel_id text NOT NULL,
  arc_id text NOT NULL,
  title text NOT NULL,
  ord integer NOT NULL,
  planned_episode_count integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT episode_units_id_format CHECK (id ~ '^epu_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT episode_units_tenant_key UNIQUE (novel_id, id),
  CONSTRAINT episode_units_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT episode_units_arc_fk FOREIGN KEY (novel_id, arc_id) REFERENCES arcs (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT episode_units_status_check CHECK (status IN ('active', 'retired')),
  CONSTRAINT episode_units_title_len CHECK (char_length(title) BETWEEN 1 AND 200),
  CONSTRAINT episode_units_count_check CHECK (planned_episode_count >= 1 AND ord >= 1)
);
CREATE INDEX episode_units_arc_idx ON episode_units (novel_id, arc_id, status, ord);

ALTER TABLE episodes ADD COLUMN unit_id text;
ALTER TABLE episodes ADD COLUMN unit_part_no integer;
ALTER TABLE episodes ADD CONSTRAINT episodes_unit_fk FOREIGN KEY (novel_id, unit_id) REFERENCES episode_units (novel_id, id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE episodes ADD CONSTRAINT episodes_unit_part_check CHECK ((unit_id IS NULL AND unit_part_no IS NULL) OR (unit_id IS NOT NULL AND unit_part_no >= 1));
CREATE INDEX episodes_unit_idx ON episodes (novel_id, unit_id);

-- 작품 설정 "제목 방식": unit = 에피소드 묶음 (1)(2) (새 작품 기본), per_episode = 화마다 새 제목(이전 방식).
-- 이미 있는 작품은 이전 방식으로 두고, 플롯의 [제목 정리]를 적용하면 unit으로 바뀝니다.
ALTER TABLE novels ADD COLUMN episode_title_mode text NOT NULL DEFAULT 'per_episode';
ALTER TABLE novels ALTER COLUMN episode_title_mode SET DEFAULT 'unit';
ALTER TABLE novels ADD CONSTRAINT novels_episode_title_mode_check CHECK (episode_title_mode IN ('unit', 'per_episode'));

-- 승인 종류 episode_titles: [제목 정리] 제안(대상 arc, payload = 묶음 제안). 작가가 인박스나 플롯 화면에서 적용합니다.
ALTER TABLE approvals DROP CONSTRAINT approvals_approval_type_enum;
ALTER TABLE approvals ADD CONSTRAINT approvals_approval_type_enum CHECK (approval_type IN ('concept_brief', 'series_bible', 'arc_plan', 'episode', 'arc', 'canon_change', 'retcon', 'ending_change', 'budget_resume', 'setup_abandon', 'publish_batch', 'schema_change', 'identity_change', 'character_sheet', 'media_quote', 'safety_review', 'draft_adoption', 'story_structure', 'episode_titles'));
