-- 业务样例确认后的题型档案与 DOCX 操作技能模板支持。
-- 在应用写入 legacy / beijing_2024 的受控字典后，再发布依赖此档案的理论试卷结构。

USE itembank;

CREATE TABLE question_type_profiles (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  code VARCHAR(64) NOT NULL,
  name VARCHAR(128) NOT NULL,
  status ENUM('active','disabled') NOT NULL DEFAULT 'active',
  description VARCHAR(500) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_question_type_profiles_code (code)
) ENGINE=InnoDB;

CREATE TABLE question_type_profile_mappings (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  profile_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  canonical_type VARCHAR(32) NOT NULL,
  external_code VARCHAR(16) NOT NULL,
  display_name VARCHAR(128) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_question_type_profile_mappings_canonical (profile_id, canonical_type),
  UNIQUE KEY uk_question_type_profile_mappings_external (profile_id, external_code),
  CONSTRAINT fk_question_type_profile_mappings_profile
    FOREIGN KEY (profile_id) REFERENCES question_type_profiles(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

ALTER TABLE blueprint_imports
  ADD COLUMN template_format ENUM('xlsx','docx') NULL AFTER blueprint_kind;

ALTER TABLE question_versions
  ADD COLUMN source_type_profile_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER authoring_batch_id,
  ADD COLUMN source_question_no VARCHAR(64) NULL AFTER source_type_profile_id,
  ADD CONSTRAINT fk_question_versions_source_type_profile
    FOREIGN KEY (source_type_profile_id) REFERENCES question_type_profiles(id) ON DELETE RESTRICT;

ALTER TABLE paper_structure_versions
  ADD COLUMN question_type_profile_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER template_code,
  ADD CONSTRAINT fk_paper_structure_versions_type_profile
    FOREIGN KEY (question_type_profile_id) REFERENCES question_type_profiles(id) ON DELETE RESTRICT;

-- 迁移后由 Seed 写入两套映射：
-- legacy: A/B/D/C/E/F/I
-- beijing_2024: A/B/G/C/D/E/F
-- 理论结构发布时由服务层强制 question_type_profile_id 非空。
