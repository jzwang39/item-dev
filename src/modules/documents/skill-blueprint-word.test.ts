import assert from "node:assert/strict";
import test from "node:test";
import { extractRawText } from "mammoth";
import { createSkillOutlineWord, createSkillStructureWord } from "./skill-blueprint-word";

test("操作技能内容结构表按Word格式输出已维护字段", async () => {
  const bytes = await createSkillStructureWord({
    occupationName: "劝募员", levelLabel: "五级 / 初级工", pathway: "公益慈善宣讲", totalMinutes: 90,
    rows: [{ code: "A", name: "理念宣传", selection: "required", score: 100, minutes: 90, method: "实操" }],
  });
  const { value } = await extractRawText({ buffer: bytes });
  for (const expected of ["劝募员操作技能考评内容结构表", "技能考核路径：公益慈善宣讲", "理念宣传", "必考", "100", "实操"]) {
    assert.ok(value.includes(expected), expected);
  }
});

test("操作技能鉴定要素细目表不编造缺失字段", async () => {
  const bytes = await createSkillOutlineWord({
    occupationName: "劝募员", levelLabel: "五级 / 初级工",
    rows: [{ code: "A-A-001", name: "完成公益宣讲", importance: "X", questionCount: 0,
      requirement: { primaryNo: "A", primaryName: "公益慈善宣讲", primaryWeight: 100, selection: "required" } }],
  });
  const { value } = await extractRawText({ buffer: bytes });
  for (const expected of ["操作技能鉴定要素细目表", "鉴定方式：技能操作", "完成公益宣讲", "必考", "X", "待核对"]) {
    assert.ok(value.includes(expected), expected);
  }
});
