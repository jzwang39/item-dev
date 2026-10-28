ALTER TABLE authoring_generation_units
  MODIFY question_type ENUM('single','multiple','judgement','mixed','practical') NOT NULL;

ALTER TABLE authoring_generation_slots
  MODIFY question_type ENUM('single','multiple','judgement','practical') NULL;
