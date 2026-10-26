CREATE TABLE question_review_confirmations (
  question_version_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  confirmed_by CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  confirmed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  opinion TEXT NOT NULL,
  CONSTRAINT fk_qrc_version FOREIGN KEY (question_version_id) REFERENCES question_versions(id) ON DELETE RESTRICT,
  CONSTRAINT fk_qrc_actor FOREIGN KEY (confirmed_by) REFERENCES accounts(id) ON DELETE RESTRICT
) ENGINE=InnoDB;
