-- 0007_role_model_defaults — 새 작품의 역할별 기본 모델(설치 단위, module llm).
-- 작품을 만들 때 역할마다 이 공급자·모델로 role_model_bindings를 만듭니다. 행이 없는 역할은 설치 기본 공급자
-- (InstallConfig llm.provider)의 내장 기본 모델을 씁니다. 공급자 프로필은 단가가 바뀔 때마다 새 버전 행이 생기므로
-- 프로필 id가 아니라 공급자 이름으로 가리킵니다(작품 생성 때 그 공급자의 활성 프로필로 해석).
CREATE TABLE role_model_defaults (
  agent_role text NOT NULL,
  CONSTRAINT role_model_defaults_agent_role_enum CHECK (agent_role IN ('concept_partner', 'showrunner', 'planner', 'world_keeper', 'writer', 'continuity_editor', 'foreshadow_manager', 'line_editor', 'scene_director', 'visual_producer')),
  provider text NOT NULL,
  model_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_role),
  CONSTRAINT role_model_defaults_ck_model CHECK (length(model_id) BETWEEN 1 AND 200)
);
COMMENT ON COLUMN role_model_defaults.agent_role IS 'enum:agent_role';
