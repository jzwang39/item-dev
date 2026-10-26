-- 理论知识教材章节、细目表生成任务及题量配额

CREATE TABLE textbook_chapters (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ordinal INT UNSIGNED NOT NULL,
  chapter_no VARCHAR(64) NULL,
  chapter_title VARCHAR(500) NOT NULL,
  section_no VARCHAR(64) NULL,
  section_title VARCHAR(500) NULL,
  content_text MEDIUMTEXT NOT NULL,
  content_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_textbook_chapters_version_ordinal (source_version_id, ordinal),
  KEY idx_textbook_chapters_version_title (source_version_id, chapter_title(128)),
  CONSTRAINT fk_textbook_chapters_version
    FOREIGN KEY (source_version_id) REFERENCES source_versions(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE theory_outline_generation_jobs (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  project_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  occupation_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  level_code ENUM('level_5','level_4','level_3','level_2','level_1') NOT NULL,
  textbook_source_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  generation_mode ENUM('textbook','model') NOT NULL,
  status ENUM('queued','running','succeeded','failed') NOT NULL DEFAULT 'queued',
  total_batches INT UNSIGNED NOT NULL DEFAULT 0,
  completed_batches INT UNSIGNED NOT NULL DEFAULT 0,
  generated_point_count INT UNSIGNED NOT NULL DEFAULT 0,
  error_message VARCHAR(2000) NULL,
  draft_snapshot_json JSON NULL,
  result_blueprint_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_by CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  started_at DATETIME(3) NULL,
  finished_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_theory_outline_jobs_scope (project_id, occupation_id, level_code, created_at),
  KEY idx_theory_outline_jobs_status (status, updated_at),
  CONSTRAINT fk_theory_outline_jobs_project
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
  CONSTRAINT fk_theory_outline_jobs_occupation
    FOREIGN KEY (occupation_id) REFERENCES project_occupations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_theory_outline_jobs_textbook
    FOREIGN KEY (textbook_source_version_id) REFERENCES source_versions(id) ON DELETE RESTRICT,
  CONSTRAINT fk_theory_outline_jobs_result
    FOREIGN KEY (result_blueprint_version_id) REFERENCES blueprint_versions(id) ON DELETE RESTRICT,
  CONSTRAINT fk_theory_outline_jobs_created_by
    FOREIGN KEY (created_by) REFERENCES accounts(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE theory_outline_point_quotas (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  blueprint_node_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  question_type ENUM('single','judgement') NOT NULL,
  target_count INT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_theory_outline_point_quotas_node_type (blueprint_node_id, question_type),
  CONSTRAINT fk_theory_outline_point_quotas_node
    FOREIGN KEY (blueprint_node_id) REFERENCES blueprint_nodes(id) ON DELETE CASCADE
) ENGINE=InnoDB;
