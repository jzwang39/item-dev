-- Public basic questions keep one editorial identity and immutable releases.
CREATE TABLE IF NOT EXISTS common_question_groups (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  project_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  occupation_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  basis_json JSON NOT NULL,
  quota_json JSON NOT NULL,
  current_release_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  generation_plan_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  row_version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_common_occupation (occupation_id),
  CONSTRAINT fk_common_project FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT fk_common_occupation FOREIGN KEY (occupation_id) REFERENCES project_occupations(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS common_question_points (
  group_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  point_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  level_code VARCHAR(16) NOT NULL,
  blueprint_node_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (group_id,point_key,level_code),
  UNIQUE KEY uk_common_node (blueprint_node_id),
  CONSTRAINT fk_cqp_group FOREIGN KEY (group_id) REFERENCES common_question_groups(id),
  CONSTRAINT fk_cqp_node FOREIGN KEY (blueprint_node_id) REFERENCES blueprint_nodes(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS common_question_members (
  question_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  group_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  point_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  suspended TINYINT NOT NULL DEFAULT 0,
  origin_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_cqm_group (group_id,point_key),
  CONSTRAINT fk_cqm_group FOREIGN KEY (group_id) REFERENCES common_question_groups(id),
  CONSTRAINT fk_cqm_question FOREIGN KEY (question_id) REFERENCES questions(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS common_question_releases (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  group_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version_no INT UNSIGNED NOT NULL,
  snapshot_json JSON NOT NULL,
  published_by CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  published_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_cqr_version (group_id,version_no),
  CONSTRAINT fk_cqr_group FOREIGN KEY (group_id) REFERENCES common_question_groups(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS common_question_release_items (
  release_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  question_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  question_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  point_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (release_id,question_id),
  CONSTRAINT fk_cqri_release FOREIGN KEY (release_id) REFERENCES common_question_releases(id),
  CONSTRAINT fk_cqri_question FOREIGN KEY (question_id) REFERENCES questions(id),
  CONSTRAINT fk_cqri_version FOREIGN KEY (question_version_id) REFERENCES question_versions(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS common_question_plan_links (
  plan_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  group_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  release_at_confirmation CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  snapshot_json JSON NOT NULL,
  CONSTRAINT fk_cqpl_plan FOREIGN KEY (plan_id) REFERENCES authoring_plans(id),
  CONSTRAINT fk_cqpl_group FOREIGN KEY (group_id) REFERENCES common_question_groups(id),
  CONSTRAINT fk_cqpl_release FOREIGN KEY (release_at_confirmation) REFERENCES common_question_releases(id)
) ENGINE=InnoDB;

-- This migration may resume after a previous deployment created the tables
-- but failed before it could be recorded. MySQL has no portable CREATE INDEX
-- IF NOT EXISTS syntax, so check information_schema before each index change.
SET @idx_ags_question_exists := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'authoring_generation_slots'
    AND index_name = 'idx_ags_question'
);
SET @sql := IF(
  @idx_ags_question_exists = 0,
  'ALTER TABLE authoring_generation_slots ADD KEY idx_ags_question (question_id)',
  'SELECT 1'
);
PREPARE migration_stmt FROM @sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;

SET @uk_ags_question_exists := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'authoring_generation_slots'
    AND index_name = 'uk_ags_question'
);
SET @uk_ags_job_question_exists := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'authoring_generation_slots'
    AND index_name = 'uk_ags_job_question'
);
SET @sql := IF(
  @uk_ags_question_exists > 0 AND @uk_ags_job_question_exists = 0,
  'ALTER TABLE authoring_generation_slots DROP INDEX uk_ags_question, ADD UNIQUE KEY uk_ags_job_question (job_id,question_id)',
  IF(
    @uk_ags_question_exists > 0,
    'ALTER TABLE authoring_generation_slots DROP INDEX uk_ags_question',
    IF(
      @uk_ags_job_question_exists = 0,
      'ALTER TABLE authoring_generation_slots ADD UNIQUE KEY uk_ags_job_question (job_id,question_id)',
      'SELECT 1'
    )
  )
);
PREPARE migration_stmt FROM @sql;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
