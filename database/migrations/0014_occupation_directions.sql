CREATE TABLE project_occupation_directions (
  id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  occupation_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ordinal INT UNSIGNED NOT NULL,
  name VARCHAR(200) NOT NULL,
  status ENUM('active','archived') NOT NULL DEFAULT 'active',
  active_name VARCHAR(200) GENERATED ALWAYS AS (
    CASE WHEN status = 'active' THEN name ELSE NULL END
  ) STORED,
  row_version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_pod_occupation_ordinal (occupation_id, ordinal),
  UNIQUE KEY uk_pod_occupation_active_name (occupation_id, active_name),
  CONSTRAINT fk_pod_occupation
    FOREIGN KEY (occupation_id) REFERENCES project_occupations(id) ON DELETE RESTRICT
) ENGINE=InnoDB;
