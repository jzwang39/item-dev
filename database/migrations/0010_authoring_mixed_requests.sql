ALTER TABLE authoring_generation_units
  MODIFY question_type ENUM('single','multiple','judgement','mixed') NOT NULL;

ALTER TABLE authoring_generation_slots
  ADD COLUMN question_type ENUM('single','multiple','judgement') NULL AFTER ordinal;

UPDATE authoring_generation_slots s
JOIN authoring_generation_units u ON u.id=s.unit_id
SET s.question_type=u.question_type
WHERE u.question_type<>'mixed';

-- This singleton row serializes capacity checks across worker processes.
CREATE TABLE authoring_generation_capacity (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  cooldown_until DATETIME(3) NULL
) ENGINE=InnoDB;

INSERT INTO authoring_generation_capacity(id) VALUES(1);
