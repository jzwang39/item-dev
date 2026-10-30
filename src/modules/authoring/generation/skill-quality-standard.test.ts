import assert from "node:assert/strict";
import test from "node:test";
import type { RowDataPacket } from "mysql2/promise";
import { readSkillQualityStandard } from "./skill-quality-standard";
import { qualityStandardConfigs } from "../quality-standard";

test("每次读取最新保存标准，完整保留文本并记录版本，不缓存旧任务标准", async () => {
  let version = 1;
  let content = "评分标准V1";
  const read = async () => [{
    setting_value_json: JSON.stringify({ content }), row_version: version, updated_at: new Date("2026-10-30T00:00:00Z"),
  } as RowDataPacket & { setting_value_json: unknown; row_version: number; updated_at: Date }];
  const first = await readSkillQualityStandard(read);
  content = "9. 题干不出现“作为劝募员”等身份铺垫。\n评分标准V2";
  version = 2;
  const second = await readSkillQualityStandard(read);
  assert.equal(first.content, "评分标准V1");
  assert.equal(second.content, content);
  assert.equal(second.version, 2);
  assert.equal(second.source, "saved");
  assert.equal(second.updatedAt, "2026-10-30T00:00:00.000Z");
  assert.ok(second.appliedAt);
});

test("尚未配置时带入默认标准，数据库读取失败不使用旧快照继续出题", async () => {
  const result = await readSkillQualityStandard(async () => []);
  assert.equal(result.content, qualityStandardConfigs.skill.defaultContent);
  assert.equal(result.version, null);
  assert.equal(result.source, "default");
  await assert.rejects(readSkillQualityStandard(async () => { throw new Error("database unavailable"); }), /database unavailable/);
});
