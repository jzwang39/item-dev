import assert from "node:assert/strict";
import test from "node:test";
import { qualityStandardConfigs, qualityStandardContent } from "./quality-standard";

test("理论与操作技能质量标准独立存储，技能默认标准不套用选择题要求", () => {
  assert.notEqual(qualityStandardConfigs.theory.settingKey, qualityStandardConfigs.skill.settingKey);
  assert.match(qualityStandardConfigs.skill.defaultContent, /操作步骤/);
  assert.match(qualityStandardConfigs.skill.defaultContent, /待核对/);
  assert.doesNotMatch(qualityStandardConfigs.skill.defaultContent, /选择题选项/);
});

test("质量标准读取兼容数据库 JSON 字符串和对象，未保存时使用默认内容", () => {
  const fallback = qualityStandardConfigs.skill.defaultContent;
  assert.equal(qualityStandardContent(undefined, fallback), fallback);
  assert.equal(qualityStandardContent(null, fallback), fallback);
  assert.equal(qualityStandardContent({ content: " " }, fallback), fallback);
  assert.equal(qualityStandardContent({ content: 12 }, fallback), fallback);
  assert.equal(qualityStandardContent({ content: "评分依据" }, fallback), "评分依据");
  assert.equal(qualityStandardContent('{"content":"完整操作步骤"}', fallback), "完整操作步骤");
});
