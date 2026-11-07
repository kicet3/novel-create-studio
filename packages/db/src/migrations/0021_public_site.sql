-- 0021_public_site — 공개 사이트(설계 추가, module publication).
-- 작품별 "공개 사이트에 노출" 설정(기본 꺼짐)과 공개 주소(slug)·공개 소개·작가 표시 이름.
-- 켜진 작품의 공개된 화(status = published, published_version_id)만 정적 JSON 스냅숏으로 내보내며,
-- 독자용 앱(apps/public-reader)은 이 스냅숏만 읽습니다(스튜디오 DB·API에 접근하지 않음).
CREATE TABLE public_site_novels (
  novel_id text NOT NULL PRIMARY KEY REFERENCES novels (id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  slug text,
  intro text NOT NULL DEFAULT '',
  author_name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT public_site_novels_slug_format CHECK (slug IS NULL OR slug ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'),
  CONSTRAINT public_site_novels_enabled_slug CHECK (NOT enabled OR slug IS NOT NULL),
  CONSTRAINT public_site_novels_intro_len CHECK (char_length(intro) <= 2000),
  CONSTRAINT public_site_novels_author_len CHECK (char_length(author_name) <= 40)
);
CREATE UNIQUE INDEX public_site_novels_slug_uq ON public_site_novels (slug) WHERE slug IS NOT NULL;
