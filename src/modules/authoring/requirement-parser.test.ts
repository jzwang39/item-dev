import assert from "node:assert/strict";
import test from "node:test";
import { parseModelRequirement } from "./requirement-parser";
import { mergeQuota, practicalQuota } from "./generation/quota";

const baseline = {
  occupationName: "劝募员", levelCode: "level_5", assessmentMode: "theory",
  temporaryMinimums: { single: 4, multiple: 0, judgement: 2, practical: 0 },
  qualityRequirements: ["答案准确", "避免重复"],
};
const parse = (fields: Record<string, unknown>) => parseModelRequirement(JSON.stringify({ ...baseline, ...fields }));

test("截图需求的标准响应保留五级理论4单选2判断，不改变题量", () => {
  const result = parse({});
  assert.deepEqual(result, baseline);
  assert.deepEqual(mergeQuota({ single: 3, multiple: 2, judgement: 2, total: 7, hint: "" }, result.temporaryMinimums),
    { single: 4, multiple: 0, judgement: 2, total: 6, hint: "按本次需求，每考评点生成 4 道单选、0 道多选、2 道判断，共 6 道；不额外补齐默认题量。" });
});

test("接受五个等级的中文数字、阿拉伯数字、职称及标准代码等价格式", () => {
  const titles = ["高级技师", "技师", "高级工", "中级工", "初级工"];
  const numerals = ["一", "二", "三", "四", "五"];
  for (let i = 0; i < 5; i++) {
    const level = i + 1;
    for (const value of [level, String(level), `level_${level}`, `${numerals[i]}级`, `${level}级`,
      titles[i], `${numerals[i]}级/${titles[i]}`, `${level}级/${titles[i]}`]) {
      assert.equal(parse({ levelCode: value }).levelCode, `level_${level}`);
    }
  }
  assert.equal(parse({ levelCode: "５级 / 初级工" }).levelCode, "level_5");
});

test("中文理论方式及字符串题量转换后保持原始配额", () => {
  for (const assessmentMode of ["理论知识", "理论", "theory", " THEORY "]) {
    const result = parse({ levelCode: "五级/初级工", assessmentMode,
      temporaryMinimums: { single: "4", multiple: "0", judgement: "2", practical: "0" } });
    assert.deepEqual(result, baseline);
  }
});

test("中文字段及data/result包装都能识别，不猜测缺失职业等级", () => {
  const chinese = {
    职业名称: "劝募员", 技能等级: "五级/初级工", 考核方式: "理论知识",
    临时最低题量: { 单项选择题: "4", 多项选择题: "0", 判断题: "2" }, 质量要求: baseline.qualityRequirements,
  };
  for (const content of [chinese, { data: chinese }, { result: chinese }, { data: baseline }]) {
    assert.deepEqual(parseModelRequirement(JSON.stringify(content)), baseline);
  }
  assert.throws(() => parse({ levelCode: undefined }), /技能等级/);
  assert.throws(() => parse({ occupationName: undefined }), /职业名称/);
  assert.throws(() => parse({ assessmentMode: undefined }), /考核方式/);
});

test("操作技能响应只保留实操配额，不回退理论默认题量", () => {
  const result = parse({ levelCode: "四级/中级工", assessmentMode: "操作技能",
    temporaryMinimums: { practical: "1" } });
  assert.equal(result.assessmentMode, "skill");
  assert.deepEqual(result.temporaryMinimums, { single: 0, multiple: 0, judgement: 0, practical: 1 });
  assert.equal(practicalQuota("操作技能，每个考评点1道实操题", result.temporaryMinimums).practical, 1);
});

test("未指定配额及质量要求保留原有默认行为", () => {
  const result = parse({ temporaryMinimums: undefined, qualityRequirements: undefined });
  assert.deepEqual(result.temporaryMinimums, { single: 0, multiple: 0, judgement: 0, practical: 0 });
  assert.deepEqual(result.qualityRequirements, []);
});

test("JSON围栏和说明性前后文仍能解析", () => {
  assert.deepEqual(parseModelRequirement(`解析结果：\n\`\`\`json\n${JSON.stringify(baseline)}\n\`\`\`\n`), baseline);
  assert.throws(() => parseModelRequirement("无可用信息"), /未返回可解析/);
  assert.throws(() => parseModelRequirement('{"levelCode":'), /未返回可解析/);
  assert.throws(() => parseModelRequirement("{not json}"), /JSON 格式/);
});

test("不把空值、含单位题量、范围、负数、小数或超限题量转成有效数量", () => {
  for (const count of [null, "", true, "4道", "1-4", -1, 0.5, 101, "101", "-1", "1.5"]) {
    assert.throws(() => parse({ temporaryMinimums: { single: count } }), /每个考评点题量/);
  }
  assert.throws(() => parse({ temporaryMinimums: null }), /每个考评点题量/);
});

test("有歧义的枚举及相互矛盾的等级职称仍拒绝", () => {
  for (const levelCode of ["level_5|level_4|level_3|level_2|level_1", "六级", "五级/中级工", "3或5级"]) {
    assert.throws(() => parse({ levelCode }), /技能等级/);
  }
  for (const assessmentMode of ["theory|skill", "理论知识和操作技能", "paper"]) {
    assert.throws(() => parse({ assessmentMode }), /考核方式/);
  }
});

test("质量要求或题量错误不再误报职业等级错误", () => {
  for (const qualityRequirements of ["答案准确", ["x".repeat(201)], Array(11).fill("准确"), null]) {
    assert.throws(() => parse({ qualityRequirements }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /质量要求/);
      assert.doesNotMatch(error.message, /职业名称|技能等级|考核方式/);
      return true;
    });
  }
});
