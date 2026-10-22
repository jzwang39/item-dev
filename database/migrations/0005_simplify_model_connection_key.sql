USE itembank;

ALTER TABLE model_connection_settings
  ADD COLUMN api_key VARCHAR(1000) NULL AFTER model_name,
  MODIFY COLUMN api_key_ciphertext VARBINARY(2048) NULL,
  MODIFY COLUMN api_key_iv VARBINARY(32) NULL,
  MODIFY COLUMN api_key_tag VARBINARY(32) NULL;
