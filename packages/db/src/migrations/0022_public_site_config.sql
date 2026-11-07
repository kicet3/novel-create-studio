-- 0022_public_site_config — 공개 사이트 대상(설계 추가, module publication).
-- 설치 단위 한 행: 내보낼 곳(supabase = 사용자의 Supabase 공개 스키마, files = 정적 JSON 스냅숏; NULL = 기본값)과
-- 공개 스키마 이름. 쓰기용 연결 문자열은 여기 두지 않고 비밀 저장소(`public_site.database_url`, 암호화)에 둡니다.
CREATE TABLE public_site_config (
  id text NOT NULL PRIMARY KEY DEFAULT 'install',
  target text,
  schema_name text NOT NULL DEFAULT 'ncs_public',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT public_site_config_singleton CHECK (id = 'install'),
  CONSTRAINT public_site_config_target CHECK (target IS NULL OR target IN ('supabase', 'files')),
  CONSTRAINT public_site_config_schema CHECK (schema_name ~ '^[a-z_][a-z0-9_]{0,62}$')
);
