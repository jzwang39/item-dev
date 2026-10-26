CREATE TABLE outline_point_reviews (
  node_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  expert_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  assigned_by CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  assigned_at DATETIME(3) NULL,
  status ENUM('pending','returned','awaiting_confirmation','confirmed') NOT NULL DEFAULT 'pending',
  opinion TEXT NULL,
  reviewed_by CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  reviewed_at DATETIME(3) NULL,
  confirmed_by CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  confirmed_at DATETIME(3) NULL,
  CONSTRAINT fk_opr_node FOREIGN KEY (node_id) REFERENCES blueprint_nodes(id) ON DELETE RESTRICT,
  CONSTRAINT fk_opr_expert FOREIGN KEY (expert_id) REFERENCES accounts(id) ON DELETE RESTRICT,
  CONSTRAINT fk_opr_assigner FOREIGN KEY (assigned_by) REFERENCES accounts(id) ON DELETE RESTRICT,
  CONSTRAINT fk_opr_reviewer FOREIGN KEY (reviewed_by) REFERENCES accounts(id) ON DELETE RESTRICT,
  CONSTRAINT fk_opr_confirmer FOREIGN KEY (confirmed_by) REFERENCES accounts(id) ON DELETE RESTRICT,
  KEY idx_opr_expert_status (expert_id,status)
) ENGINE=InnoDB;

ALTER TABLE review_records
  ADD COLUMN submitted_by CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN acting_role ENUM('expert','admin') NOT NULL DEFAULT 'expert',
  ADD CONSTRAINT fk_rr_submitter FOREIGN KEY (submitted_by) REFERENCES accounts(id) ON DELETE RESTRICT;
