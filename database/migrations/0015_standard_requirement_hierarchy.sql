CREATE TABLE occupation_standard_requirement_scopes (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  occupation_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  direction_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  direction_name VARCHAR(200) NOT NULL,
  level_code ENUM('level_5','level_4','level_3','level_2','level_1') NOT NULL,
  blueprint_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  file_object_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  scope_key VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_osrs_version_scope (blueprint_version_id, scope_key),
  KEY idx_osrs_occupation_direction_level (occupation_id, direction_id, level_code),
  CONSTRAINT fk_osrs_occupation FOREIGN KEY (occupation_id) REFERENCES project_occupations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_osrs_direction FOREIGN KEY (direction_id) REFERENCES project_occupation_directions(id) ON DELETE RESTRICT,
  CONSTRAINT fk_osrs_blueprint_version FOREIGN KEY (blueprint_version_id) REFERENCES blueprint_versions(id) ON DELETE CASCADE,
  CONSTRAINT fk_osrs_file FOREIGN KEY (file_object_id) REFERENCES file_objects(id) ON DELETE RESTRICT,
  CONSTRAINT fk_osrs_source_version FOREIGN KEY (source_version_id) REFERENCES source_versions(id) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE occupation_standard_requirement_nodes (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  scope_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  parent_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  node_kind ENUM('occupational_function','work_content','skill_requirement','related_knowledge') NOT NULL,
  node_key VARCHAR(128) NOT NULL,
  source_code VARCHAR(64) NOT NULL,
  name TEXT NOT NULL,
  ordinal INT UNSIGNED NOT NULL,
  evidence_text TEXT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_osrn_scope_key (scope_id, node_key),
  KEY idx_osrn_parent_order (scope_id, parent_id, ordinal),
  CONSTRAINT fk_osrn_scope FOREIGN KEY (scope_id) REFERENCES occupation_standard_requirement_scopes(id) ON DELETE CASCADE,
  CONSTRAINT fk_osrn_parent FOREIGN KEY (parent_id) REFERENCES occupation_standard_requirement_nodes(id) ON DELETE CASCADE
) ENGINE=InnoDB;
