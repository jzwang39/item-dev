CREATE TABLE IF NOT EXISTS theory_outline_export_mappings (
  blueprint_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  blueprint_node_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_point_code VARCHAR(64) NOT NULL,
  export_point_code VARCHAR(64) NOT NULL,
  point_name VARCHAR(500) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (blueprint_version_id, blueprint_node_id),
  UNIQUE KEY uk_toem_node (blueprint_node_id),
  KEY idx_toem_export_code (export_point_code),
  CONSTRAINT fk_toem_version FOREIGN KEY (blueprint_version_id) REFERENCES blueprint_versions(id),
  CONSTRAINT fk_toem_node FOREIGN KEY (blueprint_node_id) REFERENCES blueprint_nodes(id)
) ENGINE=InnoDB;
