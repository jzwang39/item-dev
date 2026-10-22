USE itembank;

CREATE TABLE model_connection_settings (
  id TINYINT UNSIGNED NOT NULL,
  provider VARCHAR(100) NOT NULL,
  base_url VARCHAR(500) NOT NULL,
  model_name VARCHAR(200) NULL,
  api_key_ciphertext VARBINARY(2048) NOT NULL,
  api_key_iv VARBINARY(32) NOT NULL,
  api_key_tag VARBINARY(32) NOT NULL,
  created_by CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  updated_by CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT chk_model_connection_settings_singleton CHECK (id = 1),
  CONSTRAINT fk_model_connection_settings_created_by FOREIGN KEY (created_by) REFERENCES accounts(id) ON DELETE SET NULL,
  CONSTRAINT fk_model_connection_settings_updated_by FOREIGN KEY (updated_by) REFERENCES accounts(id) ON DELETE SET NULL
) ENGINE=InnoDB;
