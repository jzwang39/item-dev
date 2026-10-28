import assert from "node:assert/strict";
import { test } from "node:test";

import { isTheoryOutlineGenerationLevel, theoryOutlineGenerationLevels } from "./policy";

test("批量理论细目表仅包含五级、四级、三级", () => {
  assert.deepEqual(theoryOutlineGenerationLevels, ["level_5", "level_4", "level_3"]);
  for (const level of theoryOutlineGenerationLevels) {
    assert.equal(isTheoryOutlineGenerationLevel(level), true);
  }
});

test("理论生成不允许二级、一级和无效等级", () => {
  for (const level of ["level_2", "level_1", "all", "", "level_6"]) {
    assert.equal(isTheoryOutlineGenerationLevel(level), false);
  }
});
