ALTER TABLE authoring_generation_jobs
  MODIFY status ENUM('queued','running','partial','succeeded','cancelled','stopped') NOT NULL DEFAULT 'queued',
  ADD COLUMN stop_summary_json JSON NULL;

ALTER TABLE authoring_generation_units
  MODIFY status ENUM('queued','running','failed','succeeded','stopped') NOT NULL DEFAULT 'queued';
