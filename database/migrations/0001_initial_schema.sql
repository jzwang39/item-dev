-- 智能命题平台 MySQL 8.0 首版架构
-- 业务内容版本通过 INSERT 追加；本迁移不包含任何明文密钥或初始管理员。

CREATE DATABASE IF NOT EXISTS itembank
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

USE itembank;

CREATE TABLE accounts (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  username VARCHAR(64) NOT NULL,
  display_name VARCHAR(128) NOT NULL,
  role ENUM('admin','expert') NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  phone VARCHAR(32) NULL,
  email VARCHAR(254) NULL,
  status ENUM('active','disabled') NOT NULL DEFAULT 'active',
  must_change_password TINYINT(1) NOT NULL DEFAULT 1,
  password_changed_at DATETIME(3) NULL,
  last_login_at DATETIME(3) NULL,
  row_version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_accounts_username (username),
  KEY idx_accounts_status (status)
) ENGINE=InnoDB;

CREATE TABLE permissions (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  code VARCHAR(128) NOT NULL,
  module VARCHAR(64) NOT NULL,
  action VARCHAR(64) NOT NULL,
  display_name VARCHAR(128) NOT NULL,
  description VARCHAR(500) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_permissions_code (code)
) ENGINE=InnoDB;

CREATE TABLE role_permissions (
  role ENUM('admin','expert') NOT NULL,
  permission_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (role, permission_id),
  CONSTRAINT fk_role_permissions_permission FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE projects (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  code VARCHAR(64) NOT NULL,
  name VARCHAR(200) NOT NULL,
  description TEXT NULL,
  status ENUM('active','archived') NOT NULL DEFAULT 'active',
  row_version INT UNSIGNED NOT NULL DEFAULT 1,
  created_by CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  updated_by CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_projects_code (code),
  KEY idx_projects_status (status),
  CONSTRAINT fk_projects_created_by FOREIGN KEY (created_by) REFERENCES accounts(id) ON DELETE SET NULL,
  CONSTRAINT fk_projects_updated_by FOREIGN KEY (updated_by) REFERENCES accounts(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE project_members (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  project_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status ENUM('active','disabled') NOT NULL DEFAULT 'active',
  row_version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_project_members_project_account (project_id, account_id),
  KEY idx_project_members_account_status (account_id, status),
  CONSTRAINT fk_project_members_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
  CONSTRAINT fk_project_members_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE project_member_permissions (
  project_member_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  permission_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (project_member_id, permission_id),
  CONSTRAINT fk_pmp_member FOREIGN KEY (project_member_id) REFERENCES project_members(id) ON DELETE CASCADE,
  CONSTRAINT fk_pmp_permission FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE project_occupations (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  project_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  code VARCHAR(64) NOT NULL,
  name VARCHAR(200) NOT NULL,
  status ENUM('active','archived') NOT NULL DEFAULT 'active',
  row_version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_project_occupations_project_code (project_id, code),
  KEY idx_project_occupations_project_name (project_id, name),
  CONSTRAINT fk_project_occupations_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE project_occupation_levels (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  occupation_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  level_code ENUM('level_5','level_4','level_3','level_2','level_1') NOT NULL,
  assessment_mode ENUM('theory','skill') NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_pol_scope (occupation_id, level_code, assessment_mode),
  CONSTRAINT fk_pol_occupation FOREIGN KEY (occupation_id) REFERENCES project_occupations(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE auth_sessions (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  session_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ip_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  user_agent VARCHAR(512) NULL,
  expires_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_auth_sessions_hash (session_hash),
  KEY idx_auth_sessions_account_expiry (account_id, expires_at),
  CONSTRAINT fk_auth_sessions_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE file_objects (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  project_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  storage_provider VARCHAR(32) NOT NULL DEFAULT 'cos',
  bucket VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  object_key VARCHAR(1024) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  original_name VARCHAR(512) NOT NULL,
  mime_type VARCHAR(128) NOT NULL,
  size_bytes BIGINT UNSIGNED NOT NULL,
  sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  purpose VARCHAR(64) NOT NULL,
  created_by CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_file_objects_location (bucket, object_key),
  KEY idx_file_objects_project_purpose_created (project_id, purpose, created_at),
  KEY idx_file_objects_sha256 (sha256),
  CONSTRAINT fk_file_objects_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
  CONSTRAINT fk_file_objects_created_by FOREIGN KEY (created_by) REFERENCES accounts(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE sources (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  project_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(300) NOT NULL,
  source_type ENUM('occupation_standard','textbook','general_document','sample_paper','outline_sheet','structure_sheet','other') NOT NULL,
  remark VARCHAR(2000) NULL,
  status ENUM('active','archived') NOT NULL DEFAULT 'active',
  current_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  row_version INT UNSIGNED NOT NULL DEFAULT 1,
  created_by CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_sources_project_type_status (project_id, source_type, status),
  CONSTRAINT fk_sources_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
  CONSTRAINT fk_sources_created_by FOREIGN KEY (created_by) REFERENCES accounts(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE source_versions (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version_no INT UNSIGNED NOT NULL,
  file_object_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  parse_status ENUM('pending','running','succeeded','failed','unsupported') NOT NULL DEFAULT 'pending',
  parser_version VARCHAR(64) NULL,
  parsed_artifact_file_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  content_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  error_code VARCHAR(64) NULL,
  error_message VARCHAR(1000) NULL,
  created_by CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_source_versions_source_version (source_id, version_no),
  KEY idx_source_versions_parse_created (parse_status, created_at),
  CONSTRAINT fk_source_versions_source FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE RESTRICT,
  CONSTRAINT fk_source_versions_file FOREIGN KEY (file_object_id) REFERENCES file_objects(id) ON DELETE RESTRICT,
  CONSTRAINT fk_source_versions_artifact FOREIGN KEY (parsed_artifact_file_id) REFERENCES file_objects(id) ON DELETE RESTRICT,
  CONSTRAINT fk_source_versions_created_by FOREIGN KEY (created_by) REFERENCES accounts(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE source_scopes (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  occupation_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  level_code ENUM('level_5','level_4','level_3','level_2','level_1') NOT NULL,
  assessment_mode ENUM('theory','skill') NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_source_scopes_scope (source_version_id, occupation_id, level_code, assessment_mode),
  CONSTRAINT fk_source_scopes_version FOREIGN KEY (source_version_id) REFERENCES source_versions(id) ON DELETE CASCADE,
  CONSTRAINT fk_source_scopes_occupation FOREIGN KEY (occupation_id) REFERENCES project_occupations(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE source_segments (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ordinal INT UNSIGNED NOT NULL,
  page_no INT UNSIGNED NULL,
  section_path VARCHAR(1000) NULL,
  locator VARCHAR(500) NOT NULL,
  content_excerpt TEXT NOT NULL,
  content_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_source_segments_version_ordinal (source_version_id, ordinal),
  KEY idx_source_segments_version_page (source_version_id, page_no),
  FULLTEXT KEY ft_source_segments_excerpt (content_excerpt),
  CONSTRAINT fk_source_segments_version FOREIGN KEY (source_version_id) REFERENCES source_versions(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE blueprints (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  project_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(300) NOT NULL,
  blueprint_kind ENUM('theory_weight','theory_outline','skill_structure','skill_outline') NOT NULL,
  occupation_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  level_code ENUM('level_5','level_4','level_3','level_2','level_1') NOT NULL,
  assessment_mode ENUM('theory','skill') NOT NULL,
  current_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  status ENUM('draft','published','superseded','archived') NOT NULL DEFAULT 'draft',
  row_version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_blueprints_scope (project_id, occupation_id, level_code, assessment_mode, blueprint_kind),
  CONSTRAINT fk_blueprints_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
  CONSTRAINT fk_blueprints_occupation FOREIGN KEY (occupation_id) REFERENCES project_occupations(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE blueprint_versions (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  blueprint_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version_no INT UNSIGNED NOT NULL,
  status ENUM('draft','published','superseded','archived') NOT NULL DEFAULT 'draft',
  content_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  snapshot_json JSON NOT NULL,
  published_at DATETIME(3) NULL,
  created_by CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_blueprint_versions_blueprint_version (blueprint_id, version_no),
  KEY idx_blueprint_versions_status_published (status, published_at),
  CONSTRAINT fk_blueprint_versions_blueprint FOREIGN KEY (blueprint_id) REFERENCES blueprints(id) ON DELETE RESTRICT,
  CONSTRAINT fk_blueprint_versions_created_by FOREIGN KEY (created_by) REFERENCES accounts(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE blueprint_nodes (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  blueprint_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  parent_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  node_kind ENUM('weight_item','structure_item','assessment_point','scoring_item') NOT NULL,
  node_code VARCHAR(128) NOT NULL,
  name VARCHAR(500) NOT NULL,
  ordinal INT UNSIGNED NOT NULL,
  weight DECIMAL(8,4) NULL,
  importance ENUM('low','medium','high','critical') NULL,
  requirement_json JSON NULL,
  source_ref_json JSON NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_blueprint_nodes_version_code (blueprint_version_id, node_code),
  KEY idx_blueprint_nodes_parent_order (blueprint_version_id, parent_id, ordinal),
  CONSTRAINT fk_blueprint_nodes_version FOREIGN KEY (blueprint_version_id) REFERENCES blueprint_versions(id) ON DELETE CASCADE,
  CONSTRAINT fk_blueprint_nodes_parent FOREIGN KEY (parent_id) REFERENCES blueprint_nodes(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE blueprint_node_source_refs (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  blueprint_node_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_segment_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  citation VARCHAR(1000) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_blueprint_node_source_segment (blueprint_node_id, source_segment_id),
  CONSTRAINT fk_bnsr_node FOREIGN KEY (blueprint_node_id) REFERENCES blueprint_nodes(id) ON DELETE CASCADE,
  CONSTRAINT fk_bnsr_source_version FOREIGN KEY (source_version_id) REFERENCES source_versions(id) ON DELETE RESTRICT,
  CONSTRAINT fk_bnsr_source_segment FOREIGN KEY (source_segment_id) REFERENCES source_segments(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE model_configs (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  project_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(128) NOT NULL,
  current_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  status ENUM('active','disabled') NOT NULL DEFAULT 'active',
  row_version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_model_configs_project_name (project_id, name),
  KEY idx_model_configs_project_default (project_id, is_default),
  CONSTRAINT fk_model_configs_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE model_config_versions (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  model_config_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version_no INT UNSIGNED NOT NULL,
  base_url VARCHAR(1000) NOT NULL,
  api_key_ciphertext MEDIUMBLOB NOT NULL,
  api_key_key_version VARCHAR(64) NOT NULL,
  default_model VARCHAR(200) NOT NULL,
  capabilities_json JSON NOT NULL,
  runtime_json JSON NOT NULL,
  created_by CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_model_config_versions_config_version (model_config_id, version_no),
  CONSTRAINT fk_model_config_versions_config FOREIGN KEY (model_config_id) REFERENCES model_configs(id) ON DELETE RESTRICT,
  CONSTRAINT fk_model_config_versions_created_by FOREIGN KEY (created_by) REFERENCES accounts(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE authoring_plans (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  project_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(300) NOT NULL,
  raw_requirement TEXT NOT NULL,
  scope_json JSON NOT NULL,
  quota_json JSON NOT NULL,
  blockers_json JSON NULL,
  status ENUM('draft','blocked','confirmed','cancelled') NOT NULL DEFAULT 'draft',
  row_version INT UNSIGNED NOT NULL DEFAULT 1,
  created_by CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_authoring_plans_project_status_updated (project_id, status, updated_at),
  CONSTRAINT fk_authoring_plans_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
  CONSTRAINT fk_authoring_plans_created_by FOREIGN KEY (created_by) REFERENCES accounts(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE authoring_plan_sources (
  plan_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (plan_id, source_version_id),
  CONSTRAINT fk_aps_plan FOREIGN KEY (plan_id) REFERENCES authoring_plans(id) ON DELETE CASCADE,
  CONSTRAINT fk_aps_source_version FOREIGN KEY (source_version_id) REFERENCES source_versions(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE authoring_plan_blueprints (
  plan_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  blueprint_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (plan_id, blueprint_version_id),
  CONSTRAINT fk_apb_plan FOREIGN KEY (plan_id) REFERENCES authoring_plans(id) ON DELETE CASCADE,
  CONSTRAINT fk_apb_blueprint_version FOREIGN KEY (blueprint_version_id) REFERENCES blueprint_versions(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE authoring_tasks (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  project_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  plan_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  task_no VARCHAR(64) NOT NULL,
  status ENUM('queued','running','paused','failed','awaiting_expert','completed','cancelled') NOT NULL DEFAULT 'queued',
  model_config_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  input_snapshot_json JSON NOT NULL,
  checkpoint_json JSON NULL,
  actual_output_summary_json JSON NULL,
  row_version INT UNSIGNED NOT NULL DEFAULT 1,
  created_by CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_authoring_tasks_project_task_no (project_id, task_no),
  KEY idx_authoring_tasks_project_status_updated (project_id, status, updated_at),
  CONSTRAINT fk_authoring_tasks_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
  CONSTRAINT fk_authoring_tasks_plan FOREIGN KEY (plan_id) REFERENCES authoring_plans(id) ON DELETE RESTRICT,
  CONSTRAINT fk_authoring_tasks_model_config_version FOREIGN KEY (model_config_version_id) REFERENCES model_config_versions(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE authoring_batches (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  task_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  batch_no INT UNSIGNED NOT NULL,
  status ENUM('queued','running','paused','failed','succeeded','cancelled') NOT NULL DEFAULT 'queued',
  requested_quota_json JSON NOT NULL,
  checkpoint_json JSON NULL,
  output_summary_json JSON NULL,
  started_at DATETIME(3) NULL,
  finished_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_authoring_batches_task_batch (task_id, batch_no),
  KEY idx_authoring_batches_task_status (task_id, status),
  CONSTRAINT fk_authoring_batches_task FOREIGN KEY (task_id) REFERENCES authoring_tasks(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE questions (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  project_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  question_no VARCHAR(64) NOT NULL,
  occupation_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  level_code ENUM('level_5','level_4','level_3','level_2','level_1') NOT NULL,
  assessment_mode ENUM('theory','skill') NOT NULL,
  question_type VARCHAR(32) NOT NULL,
  current_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  current_status ENUM('draft','pending_review','returned','approved','archived') NOT NULL DEFAULT 'draft',
  difficulty ENUM('easy','medium','hard') NULL,
  archived_at DATETIME(3) NULL,
  row_version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_questions_project_question_no (project_id, question_no),
  KEY idx_questions_project_status_scope (project_id, current_status, assessment_mode, level_code),
  KEY idx_questions_project_occupation_type (project_id, occupation_id, question_type),
  CONSTRAINT fk_questions_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
  CONSTRAINT fk_questions_occupation FOREIGN KEY (occupation_id) REFERENCES project_occupations(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE question_versions (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  question_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version_no INT UNSIGNED NOT NULL,
  parent_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  authoring_task_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  authoring_batch_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  revision_reason VARCHAR(1000) NULL,
  stem TEXT NOT NULL,
  content_json JSON NOT NULL,
  answer_json JSON NOT NULL,
  analysis_text TEXT NULL,
  score_rubric_json JSON NULL,
  source_snapshot_json JSON NOT NULL,
  content_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_by CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_question_versions_question_version (question_id, version_no),
  UNIQUE KEY uk_question_versions_question_content_hash (question_id, content_hash),
  FULLTEXT KEY ft_question_versions_content (stem, analysis_text),
  CONSTRAINT fk_question_versions_question FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE RESTRICT,
  CONSTRAINT fk_question_versions_parent FOREIGN KEY (parent_version_id) REFERENCES question_versions(id) ON DELETE RESTRICT,
  CONSTRAINT fk_question_versions_task FOREIGN KEY (authoring_task_id) REFERENCES authoring_tasks(id) ON DELETE RESTRICT,
  CONSTRAINT fk_question_versions_batch FOREIGN KEY (authoring_batch_id) REFERENCES authoring_batches(id) ON DELETE RESTRICT,
  CONSTRAINT fk_question_versions_created_by FOREIGN KEY (created_by) REFERENCES accounts(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE question_options (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  question_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  option_key VARCHAR(8) NOT NULL,
  content TEXT NOT NULL,
  is_correct TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uk_question_options_version_key (question_version_id, option_key),
  CONSTRAINT fk_question_options_version FOREIGN KEY (question_version_id) REFERENCES question_versions(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE question_assessment_points (
  question_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  blueprint_node_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  coverage_weight DECIMAL(8,4) NOT NULL DEFAULT 1.0000,
  PRIMARY KEY (question_version_id, blueprint_node_id),
  KEY idx_question_assessment_points_node (blueprint_node_id),
  CONSTRAINT fk_qap_version FOREIGN KEY (question_version_id) REFERENCES question_versions(id) ON DELETE CASCADE,
  CONSTRAINT fk_qap_node FOREIGN KEY (blueprint_node_id) REFERENCES blueprint_nodes(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE question_source_refs (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  question_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_segment_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  citation VARCHAR(1000) NOT NULL,
  quote_excerpt TEXT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_question_source_refs_version_segment (question_version_id, source_segment_id),
  CONSTRAINT fk_qsr_version FOREIGN KEY (question_version_id) REFERENCES question_versions(id) ON DELETE CASCADE,
  CONSTRAINT fk_qsr_source_version FOREIGN KEY (source_version_id) REFERENCES source_versions(id) ON DELETE RESTRICT,
  CONSTRAINT fk_qsr_source_segment FOREIGN KEY (source_segment_id) REFERENCES source_segments(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE question_quality_checks (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  question_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  check_round ENUM('rule','independent_review','auto_revision') NOT NULL,
  check_code VARCHAR(128) NOT NULL,
  severity ENUM('info','warning','error') NOT NULL,
  result ENUM('pass','fail','manual_required') NOT NULL,
  detail_json JSON NULL,
  model_run_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_question_quality_checks_unique (question_version_id, check_round, check_code),
  KEY idx_question_quality_checks_version_result (question_version_id, result),
  CONSTRAINT fk_qqc_version FOREIGN KEY (question_version_id) REFERENCES question_versions(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE question_status_events (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  question_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  question_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  from_status ENUM('draft','pending_review','returned','approved','archived') NULL,
  to_status ENUM('draft','pending_review','returned','approved','archived') NOT NULL,
  reason VARCHAR(2000) NULL,
  actor_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  request_id VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_question_status_events_question_created (question_id, created_at),
  KEY idx_question_status_events_version_created (question_version_id, created_at),
  CONSTRAINT fk_qse_question FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE RESTRICT,
  CONSTRAINT fk_qse_version FOREIGN KEY (question_version_id) REFERENCES question_versions(id) ON DELETE RESTRICT,
  CONSTRAINT fk_qse_actor FOREIGN KEY (actor_id) REFERENCES accounts(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE review_assignments (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  project_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  question_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  question_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expert_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  assigned_by CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  status ENUM('assigned','submitted','cancelled','superseded') NOT NULL DEFAULT 'assigned',
  active_token VARCHAR(16) NULL,
  assigned_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  due_at DATETIME(3) NULL,
  row_version INT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uk_review_assignments_active_version (question_version_id, active_token),
  KEY idx_review_assignments_expert_queue (project_id, expert_id, status, assigned_at),
  CONSTRAINT fk_review_assignments_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
  CONSTRAINT fk_review_assignments_question FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE RESTRICT,
  CONSTRAINT fk_review_assignments_version FOREIGN KEY (question_version_id) REFERENCES question_versions(id) ON DELETE RESTRICT,
  CONSTRAINT fk_review_assignments_expert FOREIGN KEY (expert_id) REFERENCES accounts(id) ON DELETE RESTRICT,
  CONSTRAINT fk_review_assignments_assigned_by FOREIGN KEY (assigned_by) REFERENCES accounts(id) ON DELETE SET NULL,
  CONSTRAINT chk_review_assignments_active CHECK ((status = 'assigned' AND active_token = 'ACTIVE') OR (status <> 'assigned' AND active_token IS NULL))
) ENGINE=InnoDB;

CREATE TABLE review_records (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  assignment_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  question_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expert_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  stage VARCHAR(32) NOT NULL,
  decision ENUM('approved','returned','rejected') NOT NULL,
  comment TEXT NOT NULL,
  alignment ENUM('aligned','partially_aligned','not_aligned') NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  submitted_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_review_records_assignment_stage (assignment_id, stage),
  UNIQUE KEY uk_review_records_expert_version_stage (expert_id, question_version_id, stage),
  UNIQUE KEY uk_review_records_idempotency (idempotency_key),
  CONSTRAINT fk_review_records_assignment FOREIGN KEY (assignment_id) REFERENCES review_assignments(id) ON DELETE RESTRICT,
  CONSTRAINT fk_review_records_version FOREIGN KEY (question_version_id) REFERENCES question_versions(id) ON DELETE RESTRICT,
  CONSTRAINT fk_review_records_expert FOREIGN KEY (expert_id) REFERENCES accounts(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE question_revision_links (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  from_question_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  to_question_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  review_record_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  relation_type ENUM('returned_revision','manual_revision','auto_revision') NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_question_revision_links_versions (from_question_version_id, to_question_version_id),
  CONSTRAINT fk_qrl_from FOREIGN KEY (from_question_version_id) REFERENCES question_versions(id) ON DELETE RESTRICT,
  CONSTRAINT fk_qrl_to FOREIGN KEY (to_question_version_id) REFERENCES question_versions(id) ON DELETE RESTRICT,
  CONSTRAINT fk_qrl_review FOREIGN KEY (review_record_id) REFERENCES review_records(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE paper_structures (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  project_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(300) NOT NULL,
  occupation_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  level_code ENUM('level_5','level_4','level_3','level_2','level_1') NOT NULL,
  assessment_mode ENUM('theory','skill') NOT NULL,
  current_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  status ENUM('draft','published','superseded','archived') NOT NULL DEFAULT 'draft',
  row_version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_paper_structures_scope_status (project_id, occupation_id, level_code, assessment_mode, status),
  CONSTRAINT fk_paper_structures_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
  CONSTRAINT fk_paper_structures_occupation FOREIGN KEY (occupation_id) REFERENCES project_occupations(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE paper_structure_versions (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  paper_structure_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version_no INT UNSIGNED NOT NULL,
  status ENUM('draft','published','superseded','archived') NOT NULL DEFAULT 'draft',
  template_code VARCHAR(64) NOT NULL,
  duration_minutes INT UNSIGNED NULL,
  total_items INT UNSIGNED NOT NULL,
  total_score DECIMAL(10,2) NOT NULL,
  form_json JSON NULL,
  snapshot_json JSON NOT NULL,
  published_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_paper_structure_versions_structure_version (paper_structure_id, version_no),
  CONSTRAINT fk_paper_structure_versions_structure FOREIGN KEY (paper_structure_id) REFERENCES paper_structures(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE paper_structure_sections (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  paper_structure_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  section_no INT UNSIGNED NOT NULL,
  question_type VARCHAR(32) NOT NULL,
  item_count INT UNSIGNED NOT NULL,
  score_per_item DECIMAL(10,2) NOT NULL,
  section_score DECIMAL(10,2) NOT NULL,
  ordering INT UNSIGNED NOT NULL,
  requirements_json JSON NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_paper_structure_sections_version_section (paper_structure_version_id, section_no),
  CONSTRAINT fk_paper_structure_sections_version FOREIGN KEY (paper_structure_version_id) REFERENCES paper_structure_versions(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE assembly_plans (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  project_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(300) NOT NULL,
  occupation_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  level_code ENUM('level_5','level_4','level_3','level_2','level_1') NOT NULL,
  assessment_mode ENUM('theory','skill') NOT NULL,
  current_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  status ENUM('draft','ready','running','incomplete','completed','cancelled') NOT NULL DEFAULT 'draft',
  row_version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_assembly_plans_scope_status (project_id, status, occupation_id, level_code, assessment_mode),
  CONSTRAINT fk_assembly_plans_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
  CONSTRAINT fk_assembly_plans_occupation FOREIGN KEY (occupation_id) REFERENCES project_occupations(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE assembly_plan_versions (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  assembly_plan_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version_no INT UNSIGNED NOT NULL,
  paper_structure_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status ENUM('draft','ready','running','incomplete','completed','cancelled') NOT NULL DEFAULT 'draft',
  candidate_filter_json JSON NOT NULL,
  snapshot_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_assembly_plan_versions_plan_version (assembly_plan_id, version_no),
  CONSTRAINT fk_assembly_plan_versions_plan FOREIGN KEY (assembly_plan_id) REFERENCES assembly_plans(id) ON DELETE RESTRICT,
  CONSTRAINT fk_assembly_plan_versions_structure_version FOREIGN KEY (paper_structure_version_id) REFERENCES paper_structure_versions(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE assembly_plan_slots (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  assembly_plan_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  slot_no INT UNSIGNED NOT NULL,
  section_no INT UNSIGNED NOT NULL,
  question_type VARCHAR(32) NOT NULL,
  assessment_point_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  required_count INT UNSIGNED NOT NULL DEFAULT 1,
  requirements_json JSON NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_assembly_plan_slots_version_slot (assembly_plan_version_id, slot_no),
  KEY idx_assembly_plan_slots_assessment_point (assessment_point_id),
  CONSTRAINT fk_assembly_plan_slots_version FOREIGN KEY (assembly_plan_version_id) REFERENCES assembly_plan_versions(id) ON DELETE CASCADE,
  CONSTRAINT fk_assembly_plan_slots_point FOREIGN KEY (assessment_point_id) REFERENCES blueprint_nodes(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE assembly_runs (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  assembly_plan_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  project_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  job_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  status ENUM('queued','running','succeeded','failed','cancelled') NOT NULL DEFAULT 'queued',
  gap_json JSON NULL,
  selection_summary_json JSON NULL,
  requested_by CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  started_at DATETIME(3) NULL,
  finished_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_assembly_runs_plan_status_created (assembly_plan_version_id, status, created_at),
  CONSTRAINT fk_assembly_runs_plan_version FOREIGN KEY (assembly_plan_version_id) REFERENCES assembly_plan_versions(id) ON DELETE RESTRICT,
  CONSTRAINT fk_assembly_runs_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
  CONSTRAINT fk_assembly_runs_requested_by FOREIGN KEY (requested_by) REFERENCES accounts(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE papers (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  project_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  paper_no VARCHAR(64) NOT NULL,
  assembly_run_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  assembly_plan_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  paper_structure_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status ENUM('generated','archived') NOT NULL DEFAULT 'generated',
  title VARCHAR(500) NOT NULL,
  snapshot_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  generated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_papers_project_paper_no (project_id, paper_no),
  UNIQUE KEY uk_papers_assembly_run (assembly_run_id),
  KEY idx_papers_project_status_generated (project_id, status, generated_at),
  CONSTRAINT fk_papers_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
  CONSTRAINT fk_papers_run FOREIGN KEY (assembly_run_id) REFERENCES assembly_runs(id) ON DELETE RESTRICT,
  CONSTRAINT fk_papers_plan_version FOREIGN KEY (assembly_plan_version_id) REFERENCES assembly_plan_versions(id) ON DELETE RESTRICT,
  CONSTRAINT fk_papers_structure_version FOREIGN KEY (paper_structure_version_id) REFERENCES paper_structure_versions(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE paper_items (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  paper_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  item_no INT UNSIGNED NOT NULL,
  section_no INT UNSIGNED NOT NULL,
  question_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  question_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  question_no_snapshot VARCHAR(64) NOT NULL,
  question_type VARCHAR(32) NOT NULL,
  stem_snapshot TEXT NOT NULL,
  content_snapshot_json JSON NOT NULL,
  answer_snapshot_json JSON NOT NULL,
  score_rubric_snapshot_json JSON NULL,
  score DECIMAL(10,2) NOT NULL,
  ordering INT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_paper_items_paper_item_no (paper_id, item_no),
  UNIQUE KEY uk_paper_items_paper_question_version (paper_id, question_version_id),
  KEY idx_paper_items_question_version (question_version_id),
  CONSTRAINT fk_paper_items_paper FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE,
  CONSTRAINT fk_paper_items_question FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE RESTRICT,
  CONSTRAINT fk_paper_items_question_version FOREIGN KEY (question_version_id) REFERENCES question_versions(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE jobs (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  project_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  queue_name VARCHAR(64) NOT NULL,
  job_type VARCHAR(64) NOT NULL,
  business_type VARCHAR(64) NOT NULL,
  business_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  status ENUM('queued','running','retrying','succeeded','failed','cancelled') NOT NULL DEFAULT 'queued',
  progress TINYINT UNSIGNED NOT NULL DEFAULT 0,
  stage VARCHAR(128) NULL,
  input_summary_json JSON NULL,
  output_summary_json JSON NULL,
  error_code VARCHAR(64) NULL,
  retryable TINYINT(1) NOT NULL DEFAULT 0,
  requested_by CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_jobs_idempotency (project_id, job_type, idempotency_key),
  KEY idx_jobs_status_queue_created (status, queue_name, created_at),
  KEY idx_jobs_business (business_type, business_id),
  CONSTRAINT fk_jobs_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
  CONSTRAINT fk_jobs_requested_by FOREIGN KEY (requested_by) REFERENCES accounts(id) ON DELETE SET NULL,
  CONSTRAINT chk_jobs_progress CHECK (progress <= 100)
) ENGINE=InnoDB;

CREATE TABLE job_attempts (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  job_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  attempt_no INT UNSIGNED NOT NULL,
  worker_id VARCHAR(128) NULL,
  status ENUM('running','succeeded','failed','abandoned') NOT NULL,
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finished_at DATETIME(3) NULL,
  error_code VARCHAR(64) NULL,
  error_summary VARCHAR(2000) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_job_attempts_job_attempt (job_id, attempt_no),
  CONSTRAINT fk_job_attempts_job FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE idempotency_records (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  scope VARCHAR(256) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status_code SMALLINT UNSIGNED NOT NULL,
  response_json JSON NULL,
  resource_type VARCHAR(64) NULL,
  resource_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_idempotency_records_scope_key (scope, idempotency_key),
  KEY idx_idempotency_records_expiry (expires_at)
) ENGINE=InnoDB;

CREATE TABLE audit_logs (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  project_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  actor_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  action VARCHAR(128) NOT NULL,
  object_type VARCHAR(64) NOT NULL,
  object_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  object_version VARCHAR(64) NULL,
  request_id VARCHAR(64) NULL,
  before_json JSON NULL,
  after_json JSON NULL,
  result ENUM('success','failure') NOT NULL,
  ip_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_audit_logs_project_created (project_id, created_at),
  KEY idx_audit_logs_object_created (object_type, object_id, created_at),
  KEY idx_audit_logs_actor_created (actor_id, created_at),
  CONSTRAINT fk_audit_logs_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
  CONSTRAINT fk_audit_logs_actor FOREIGN KEY (actor_id) REFERENCES accounts(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE system_settings (
  setting_key VARCHAR(128) NOT NULL,
  setting_value_json JSON NOT NULL,
  row_version INT UNSIGNED NOT NULL DEFAULT 1,
  updated_by CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (setting_key),
  CONSTRAINT fk_system_settings_updated_by FOREIGN KEY (updated_by) REFERENCES accounts(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE source_parse_runs (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  job_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  status ENUM('queued','running','succeeded','failed','cancelled') NOT NULL,
  summary_json JSON NULL,
  error_code VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_source_parse_runs_version_created (source_version_id, created_at),
  CONSTRAINT fk_source_parse_runs_version FOREIGN KEY (source_version_id) REFERENCES source_versions(id) ON DELETE RESTRICT,
  CONSTRAINT fk_source_parse_runs_job FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE blueprint_imports (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  project_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  file_object_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  blueprint_kind ENUM('theory_weight','theory_outline','skill_structure','skill_outline') NOT NULL,
  scope_json JSON NOT NULL,
  job_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  status ENUM('queued','running','succeeded','failed','cancelled') NOT NULL,
  validation_json JSON NULL,
  created_by CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_blueprint_imports_project_status_created (project_id, status, created_at),
  CONSTRAINT fk_blueprint_imports_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
  CONSTRAINT fk_blueprint_imports_file FOREIGN KEY (file_object_id) REFERENCES file_objects(id) ON DELETE RESTRICT,
  CONSTRAINT fk_blueprint_imports_job FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE SET NULL,
  CONSTRAINT fk_blueprint_imports_created_by FOREIGN KEY (created_by) REFERENCES accounts(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE blueprint_version_sources (
  blueprint_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (blueprint_version_id, source_version_id),
  CONSTRAINT fk_blueprint_version_sources_version FOREIGN KEY (blueprint_version_id) REFERENCES blueprint_versions(id) ON DELETE CASCADE,
  CONSTRAINT fk_blueprint_version_sources_source FOREIGN KEY (source_version_id) REFERENCES source_versions(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE blueprint_publish_checks (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  blueprint_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  check_code VARCHAR(128) NOT NULL,
  severity ENUM('info','warning','error') NOT NULL,
  result ENUM('pass','fail') NOT NULL,
  detail_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_blueprint_publish_checks_version_code (blueprint_version_id, check_code),
  CONSTRAINT fk_blueprint_publish_checks_version FOREIGN KEY (blueprint_version_id) REFERENCES blueprint_versions(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE model_runs (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  project_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  task_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  batch_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  model_config_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  capability ENUM('plan','author','review','parse') NOT NULL,
  model_name VARCHAR(200) NOT NULL,
  request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provider_request_id VARCHAR(256) NULL,
  input_tokens INT UNSIGNED NULL,
  output_tokens INT UNSIGNED NULL,
  duration_ms INT UNSIGNED NULL,
  status ENUM('succeeded','failed') NOT NULL,
  error_code VARCHAR(64) NULL,
  summary_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_model_runs_project_capability_created (project_id, capability, created_at),
  KEY idx_model_runs_task_batch (task_id, batch_id),
  KEY idx_model_runs_provider_request (provider_request_id),
  CONSTRAINT fk_model_runs_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
  CONSTRAINT fk_model_runs_task FOREIGN KEY (task_id) REFERENCES authoring_tasks(id) ON DELETE RESTRICT,
  CONSTRAINT fk_model_runs_batch FOREIGN KEY (batch_id) REFERENCES authoring_batches(id) ON DELETE RESTRICT,
  CONSTRAINT fk_model_runs_config_version FOREIGN KEY (model_config_version_id) REFERENCES model_config_versions(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

ALTER TABLE question_quality_checks
  ADD CONSTRAINT fk_question_quality_checks_model_run
  FOREIGN KEY (model_run_id) REFERENCES model_runs(id) ON DELETE SET NULL;

CREATE TABLE question_tags (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  project_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(128) NOT NULL,
  code VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_question_tags_project_code (project_id, code),
  CONSTRAINT fk_question_tags_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE question_version_tags (
  question_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  tag_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (question_version_id, tag_id),
  CONSTRAINT fk_question_version_tags_version FOREIGN KEY (question_version_id) REFERENCES question_versions(id) ON DELETE CASCADE,
  CONSTRAINT fk_question_version_tags_tag FOREIGN KEY (tag_id) REFERENCES question_tags(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE paper_item_points (
  paper_item_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  assessment_point_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  coverage_weight DECIMAL(8,4) NOT NULL DEFAULT 1.0000,
  PRIMARY KEY (paper_item_id, assessment_point_id),
  CONSTRAINT fk_paper_item_points_item FOREIGN KEY (paper_item_id) REFERENCES paper_items(id) ON DELETE CASCADE,
  CONSTRAINT fk_paper_item_points_point FOREIGN KEY (assessment_point_id) REFERENCES blueprint_nodes(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE exports (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  project_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  export_type VARCHAR(64) NOT NULL,
  source_type VARCHAR(64) NOT NULL,
  source_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_version VARCHAR(64) NULL,
  snapshot_json JSON NOT NULL,
  template_version VARCHAR(64) NOT NULL,
  status ENUM('queued','running','succeeded','failed','expired') NOT NULL DEFAULT 'queued',
  job_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  requested_by CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  expires_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_exports_project_status_created (project_id, status, created_at),
  KEY idx_exports_source (source_type, source_id),
  CONSTRAINT fk_exports_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
  CONSTRAINT fk_exports_job FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE SET NULL,
  CONSTRAINT fk_exports_requested_by FOREIGN KEY (requested_by) REFERENCES accounts(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE export_files (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  export_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  file_object_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  file_role VARCHAR(64) NOT NULL,
  content_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_export_files_export_role (export_id, file_role),
  CONSTRAINT fk_export_files_export FOREIGN KEY (export_id) REFERENCES exports(id) ON DELETE RESTRICT,
  CONSTRAINT fk_export_files_file FOREIGN KEY (file_object_id) REFERENCES file_objects(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE download_events (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  export_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  file_object_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ip_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  downloaded_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_download_events_export_downloaded (export_id, downloaded_at),
  CONSTRAINT fk_download_events_export FOREIGN KEY (export_id) REFERENCES exports(id) ON DELETE RESTRICT,
  CONSTRAINT fk_download_events_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT,
  CONSTRAINT fk_download_events_file FOREIGN KEY (file_object_id) REFERENCES file_objects(id) ON DELETE RESTRICT
) ENGINE=InnoDB;
