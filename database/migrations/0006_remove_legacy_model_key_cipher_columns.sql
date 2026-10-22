USE itembank;

ALTER TABLE model_connection_settings
  DROP COLUMN api_key_ciphertext,
  DROP COLUMN api_key_iv,
  DROP COLUMN api_key_tag;
