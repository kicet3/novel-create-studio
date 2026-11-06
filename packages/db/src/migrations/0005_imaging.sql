-- 0005_imaging — 이미지 생성 탭(module imaging). 설치 단위(novel_id NULL) 또는 작품 소속 요청.
-- 이미지 바이트는 DB가 아니라 StorageProvider(local_disk)의 storage_key에 있습니다.
CREATE TABLE image_generations (
  id text NOT NULL,
  novel_id text,
  provider text NOT NULL,
  model_id text NOT NULL,
  credential_method text,
  prompt text NOT NULL,
  params jsonb NOT NULL DEFAULT '{}',
  image_count integer NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  CONSTRAINT image_generations_status_enum CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  error_family text,
  error_message text,
  estimated_micros bigint,
  cost_micros bigint,
  cost_basis text,
  CONSTRAINT image_generations_cost_basis_ck CHECK (cost_basis IS NULL OR cost_basis IN ('measured', 'estimated', 'plan')),
  cost_event_id text,
  revised_prompt text,
  provider_profile_id text,
  requested_by_actor_type text NOT NULL,
  requested_by_actor_id text NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT image_generations_id_format CHECK (id ~ '^img_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT image_generations_tenant_key UNIQUE (novel_id, id),
  CONSTRAINT image_generations_ck_count CHECK (image_count BETWEEN 1 AND 10),
  CONSTRAINT image_generations_ck_cost CHECK ((cost_micros IS NULL OR cost_micros >= 0) AND (estimated_micros IS NULL OR estimated_micros >= 0))
);
COMMENT ON COLUMN image_generations.status IS 'enum:image_generation_status';
ALTER TABLE image_generations ADD CONSTRAINT image_generations_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE image_generations ADD CONSTRAINT image_generations_provider_profile_id_fk FOREIGN KEY (provider_profile_id) REFERENCES provider_profiles (id) DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX image_generations_list_idx ON image_generations (novel_id, created_at DESC);
CREATE INDEX image_generations_open_idx ON image_generations (status) WHERE status IN ('queued', 'running');

CREATE TABLE image_assets (
  id text NOT NULL,
  generation_id text NOT NULL,
  novel_id text,
  ord integer NOT NULL,
  storage_key text NOT NULL,
  mime_type text NOT NULL,
  byte_size integer NOT NULL,
  sha256 text NOT NULL,
  width integer,
  height integer,
  revised_prompt text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  CONSTRAINT image_assets_id_format CHECK (id ~ '^ast_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT image_assets_tenant_key UNIQUE (novel_id, id),
  CONSTRAINT image_assets_ord_key UNIQUE (generation_id, ord),
  CONSTRAINT image_assets_storage_key_key UNIQUE (storage_key),
  CONSTRAINT image_assets_ck_size CHECK (byte_size > 0 AND ord >= 0 AND (width IS NULL OR width > 0) AND (height IS NULL OR height > 0))
);
ALTER TABLE image_assets ADD CONSTRAINT image_assets_generation_fk FOREIGN KEY (generation_id) REFERENCES image_generations (id) ON DELETE CASCADE;
ALTER TABLE image_assets ADD CONSTRAINT image_assets_novel_fk FOREIGN KEY (novel_id) REFERENCES novels (id) DEFERRABLE INITIALLY IMMEDIATE;
