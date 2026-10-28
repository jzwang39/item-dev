-- A dedicated project retains the existing review/audit authorization boundary.
INSERT IGNORE INTO projects(id,code,name,description,status)
VALUES('00000000000000000000000018','SYSTEM-GENERIC-LEGAL','通用法律法规题库','不绑定职业、技能等级或考评点的通用法律法规试题。','active');

ALTER TABLE questions
  MODIFY occupation_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  MODIFY level_code ENUM('level_5','level_4','level_3','level_2','level_1') NULL;

ALTER TABLE legal_agent_jobs
  MODIFY occupation_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  MODIFY level_code VARCHAR(16) NULL;
