ALTER TABLE questions
  MODIFY COLUMN current_status ENUM('draft','pending_review','returned','approved','stored','archived') NOT NULL DEFAULT 'draft';

ALTER TABLE question_status_events
  MODIFY COLUMN from_status ENUM('draft','pending_review','returned','approved','stored','archived') NULL,
  MODIFY COLUMN to_status ENUM('draft','pending_review','returned','approved','stored','archived') NOT NULL;
