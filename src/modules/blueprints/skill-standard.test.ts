import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSkillStandard } from "./skill-standard";
import { readFile } from "node:fs/promises";

const five = `4.2 技能要求权重表
项目 五级/初级工 四级/中级工 三级/高级工 二级/技师 一级/高级技师
技能要求 轴类工件加工 60 60 60 60 60
设备维护与保养 40 40 40 40 40
合计 100 100 100 100 100`;

test("five-level standard generates structures without fabricated selection or time", () => {
  const data = parseSkillStandard(five);
  assert.equal(data.columns.length, 5);
  assert.equal(data.scopes.length, 5);
  assert.equal(data.items[0].weights.level_5, 60);
  assert.equal(data.scopes[0].rows[0].minutes, null);
  assert.equal(data.scopes[0].rows[0].selection, null);
  assert.equal(data.scopes[0].totalMinutes, null);
  assert.equal(data.warnings.length, 1);
});

test("flattened PDF text, split lines and full-width percentages", () => {
  for (const input of [five.replace(/\n/g, " "), five.replace("60 60", "６０％\n６０％"), five.replace("轴类工件加工", "轴类工件加\n工")]) {
    const data = parseSkillStandard(input);
    assert.equal(data.items.length, 2);
    assert.equal(data.items[0].name, "轴类工件加工");
  }
});

test("nine-column career directions preserve non-applicable values", () => {
  const data = parseSkillStandard(`技能要求权重表
项目 五级/初级工 四级/中级工 三级/高级工 二级/技师 一级/高级技师
通用 普通车床 数控车床 普通车床 数控车床 普通车床 数控车床 普通车床 数控车床
轴类工件加工 100 60 50 60 50 60 50 — —
设备维护与保养 — 40 50 40 50 40 50 100 100
合计 100 100 100 100 100 100 100 100 100`);
  assert.equal(data.columns.length, 9);
  assert.equal(data.items[0].columnWeights["level_1:数控车床"], null);
  assert.equal(data.items[0].columnWeights["level_4:数控车床"], 50);
  assert.equal(data.items[0].weights.level_4, 60);
  assert.equal(data.scopes.length, 9);
});

const lathePdfTable = `下面是车工国家职业标准中的技能要求权重表，以及依据国家职业标准中的技能要求编制的操作技能考评内容结构表（示例）。
车工职业技能要求权重表 项 目 技能等级
五级 / 初级工 （ % ） 四级 / 中级工 （ % ） 三级 / 高级工 （ % ） 二级 / 技师 （ % ） 一级 / 高级技 师（ % ）
普通 车床 数控 车床 普通 车床 数控 车床 普通 车床 数控 车床 普通 车床 数控 车床
技 能 要 求
轴类工件加工 25 20 20 20 20 20 15 —— ——
套类工件加工 20 20 20 20 20 15 15 —— ——
圆锥面加工 20 —— —— —— —— —— —— —— ——
特性面加工 15 —— —— —— —— —— —— 35 35
螺纹加工 20 20 20 20 20 15 15 —— ——
偏心工件及曲轴 加工 —— 20 15 20 15 15 15 —— ——
畸形工件加工 —— 15 15 15 15 20 20 —— ——
难加工材料加工 —— —— —— — — —— —— 35 35
设备维护与保养 —— 5 10 5 10 5 10 15 15
培训指导 —— —— —— —— —— 5 5 10 10
技术管理 —— —— —— —— —— 5 5 5 5
合计 100 100 100 100 100 100 100 100 100`;

function assertLatheTable(input: string) {
  const data = parseSkillStandard(input);
  assert.equal(data.columns.length, 9);
  assert.equal(data.items.length, 11);
  assert.equal(data.items[0].name, "轴类工件加工");
  assert.equal(data.items[5].name, "偏心工件及曲轴加工");
  assert.equal(data.items[0].columnWeights["level_1:普通车床"], null);
  assert.equal(data.items[0].columnWeights["level_2:数控车床"], 15);
  for (const column of data.columns) {
    assert.equal(data.items.reduce((sum, item) => sum + (item.columnWeights[column.key] ?? 0), 0), 100);
  }
  assert.equal(data.scopes.length, 9);
}

test("actual PDF table layout: doubled dashes, split headings and prose references", () => {
  for (const input of [lathePdfTable, lathePdfTable.replace(/\n/g, " "), lathePdfTable.replace(/——/g, "──")]) {
    assertLatheTable(input);
  }
});

test("real uploaded lathe PDF extraction", { skip: !process.env.SKILL_STANDARD_PDF }, async () => {
  const { extractPdfText } = await import("../documents/extraction/service");
  const extracted = await extractPdfText(await readFile(process.env.SKILL_STANDARD_PDF!));
  assertLatheTable(extracted.text);
});

test("explicit long-form structure is extracted", () => {
  const data = parseSkillStandard(`${five}
操作技能考评内容结构表
五级/初级工 轴类工件加工 必考 60 80 分钟 实操与口试
五级/初级工 设备维护与保养 选考 40 40 分钟 实操`);
  assert.equal(data.scopes[0].rows[0].method, "实操与口试");
  assert.equal(data.scopes[0].rows[1].selection, "选考");
  assert.equal(data.scopes[0].totalMinutes, 120);
});

test("horizontal matrix rows are extracted without shifting project cells", () => {
  const data = parseSkillStandard(`${five}
操作技能考评内容结构表
考评要求 轴类工件加工 设备维护与保养 合计
五级/初级工
选考方式 必考 选考
考核权重（%） 60 40 100
考试时间（min） 80 40 120
考核方式 实操 模拟
四级/中级工`);
  assert.equal(data.scopes[0].rows[0].minutes, 80);
  assert.equal(data.scopes[0].rows[1].method, "模拟");
  assert.equal(data.scopes[0].totalMinutes, 120);
});

test("invalid totals, duplicate projects and conflicting structure reject publication", () => {
  assert.throws(() => parseSkillStandard(five.replace("40 40 40 40 40", "30 40 40 40 40")), /合计/);
  assert.throws(() => parseSkillStandard(five.replace("设备维护与保养", "轴类工件加工")), /重复/);
  assert.throws(() => parseSkillStandard(`${five}\n操作技能考评内容结构表\n五级/初级工 轴类工件加工 必考 50 80 分钟 实操`), /不一致/);
  assert.throws(() => parseSkillStandard("没有权重表"), /未找到/);
});
