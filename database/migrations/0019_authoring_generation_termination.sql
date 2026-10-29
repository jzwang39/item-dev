ALTER TABLE authoring_generation_jobs
  MODIFY status ENUM('queued','running','partial','succeeded','cancelled') NOT NULL DEFAULT 'queued',
  ADD COLUMN termination_summary_json JSON NULL;
