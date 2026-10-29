-- Keep attempts cumulative. Legacy attempts are not reset during manual retry.
ALTER TABLE authoring_generation_units
  ADD COLUMN retry_state_json JSON NULL;
