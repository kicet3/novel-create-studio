-- 0025_public_site_auto — 공개 사이트 자동 노출(설계 추가, module publication).
-- 작품별 "공개 사이트에 노출" 켜기를 없앱니다: 보관되지 않은 작품 중 공개된 화가 1개 이상이면 자동으로 공개 사이트에 오르고,
-- 공개 주소는 작품 id를 소문자로 바꾼 값(예: nov_01m6qxdwfxeahe006mnnhf9j5j), 작가 표시 이름은 "새벽눈길" 고정입니다.
-- 그래서 enabled·slug·author_name 열은 더 이상 읽거나 쓰지 않습니다(기존 값은 그대로 두고, 공개 소개 intro만 씁니다).
-- 공개 주소 형식은 밑줄(_)을 허용하도록 넓힙니다(packages/public-schema v3, PUBLIC_SLUG_RE와 같은 규칙).
ALTER TABLE public_site_novels DROP CONSTRAINT IF EXISTS public_site_novels_slug_format;
ALTER TABLE public_site_novels ADD CONSTRAINT public_site_novels_slug_format CHECK (slug IS NULL OR (slug ~ '^[a-z0-9]([a-z0-9_-]{0,62}[a-z0-9])?$' AND position('--' in slug) = 0));
ALTER TABLE public_site_novels DROP CONSTRAINT IF EXISTS public_site_novels_enabled_slug;
