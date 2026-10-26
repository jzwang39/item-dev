-- 完整命题计划的持久化批次、请求和逐题幂等槽位。
CREATE TABLE authoring_generation_jobs (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  plan_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  snapshot_json JSON NOT NULL,
  status ENUM('queued','running','partial','succeeded') NOT NULL DEFAULT 'queued',
  target_count INT UNSIGNED NOT NULL,
  created_by CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_authoring_generation_plan (plan_id),
  CONSTRAINT fk_agj_plan FOREIGN KEY (plan_id) REFERENCES authoring_plans(id) ON DELETE RESTRICT,
  CONSTRAINT fk_agj_actor FOREIGN KEY (created_by) REFERENCES accounts(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE authoring_generation_batches (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  job_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ordinal INT UNSIGNED NOT NULL,
  target_count INT UNSIGNED NOT NULL,
  UNIQUE KEY uk_agb_ordinal (job_id, ordinal),
  CONSTRAINT fk_agb_job FOREIGN KEY (job_id) REFERENCES authoring_generation_jobs(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE authoring_generation_units (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  job_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  batch_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ordinal INT UNSIGNED NOT NULL,
  point_code VARCHAR(200) NOT NULL,
  question_type ENUM('single','multiple','judgement') NOT NULL,
  status ENUM('queued','running','failed','succeeded') NOT NULL DEFAULT 'queued',
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  error_message VARCHAR(2000) NULL,
  next_attempt_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  lease_token CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_until DATETIME(3) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_agu_claim (status, next_attempt_at, lease_until),
  KEY idx_agu_job_batch (job_id, batch_id, ordinal),
  CONSTRAINT fk_agu_job FOREIGN KEY (job_id) REFERENCES authoring_generation_jobs(id) ON DELETE RESTRICT,
  CONSTRAINT fk_agu_batch FOREIGN KEY (batch_id) REFERENCES authoring_generation_batches(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE authoring_generation_slots (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  job_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  unit_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ordinal INT UNSIGNED NOT NULL,
  question_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  stem_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  UNIQUE KEY uk_ags_job_ordinal (job_id, ordinal),
  UNIQUE KEY uk_ags_job_stem (job_id, stem_hash),
  UNIQUE KEY uk_ags_question (question_id),
  KEY idx_ags_unit (unit_id, ordinal),
  CONSTRAINT fk_ags_job FOREIGN KEY (job_id) REFERENCES authoring_generation_jobs(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ags_unit FOREIGN KEY (unit_id) REFERENCES authoring_generation_units(id) ON DELETE RESTRICT,
  CONSTRAINT fk_ags_question FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE RESTRICT
) ENGINE=InnoDB;
