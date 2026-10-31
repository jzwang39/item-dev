import assert from "node:assert/strict";
import test from "node:test";
import { resultQualityRelaxations } from "./results";
import type { QualityRelaxation } from "./quality-policy";

test("历史成果没有放宽记录时正常读取，新成果兼容数据库JSON对象和字符串", () => {
  const notes: QualityRelaxation[] = [{
    rule: "knowledge_independence", reason: "知识已覆盖，补足判断题",
    knowledge: "分类规则", task: "诊断分类错误", questionType: "judgement",
    recordedAt: "2026-10-31T00:00:00Z",
  }];
  assert.deepEqual(resultQualityRelaxations(null), []);
  assert.deepEqual(resultQualityRelaxations("null"), []);
  assert.deepEqual(resultQualityRelaxations(notes), notes);
  assert.deepEqual(resultQualityRelaxations(JSON.stringify(notes)), notes);
});
