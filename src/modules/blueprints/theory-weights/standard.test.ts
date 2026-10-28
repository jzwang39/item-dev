import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseDirectionalTheoryWeights, parseStandardRequirements, theoryWeightLevels, theoryWeightTotals, type WeightColumnHint } from "./standard";

const directions = [
  { id: "ordinary", name: "普通车床", directionCode: "01", code: "6-18-01-01-01" },
  { id: "cnc", name: "数控车床", directionCode: "02", code: "6-18-01-01-02" },
];
const occupation = { name: "车工", code: "6-18-01-01", directions };
const labels = ["五级/初级工", "四级/中级工", "三级/高级工", "二级/技师", "一级/高级技师"];
const common = `4.1 理论知识权重表 ${labels.join(" ")}
基本要求 职业道德 5 5 5 5 5
基础知识 20 20 20 15 15
相关知识要求 加工 75 75 75 80 80
合计 100 100 100 100 100`;
const matrix = `4.1 理论知识权重表
五级/初级工 四级/中级工 普通车床 数控车床 三级/高级工 普通车床 数控车床 二级/技师 普通车床 数控车床 一级/高级技师 普通车床 数控车床
基本要求 职业道德 5 5 5 5 5 5 5 5 5
相关知识要求 加工 95 95 85 95 85 95 85 95 85
设备维护 0 0 10 0 10 0 10 0 10
合计 100 100 100 100 100 100 100 100 100`;
const work = `3. 工作要求
${labels.map((label, index) => `3.${index + 1} ${label}
职业功能 工作内容 技能要求 相关知识要求
1. 加工 1.1 作业准备
1.1.1 能选择刀具 1.1.2 能检查设备
1.1.1 刀具类型 1.1.2 设备检查方法`).join("\n")}`;

test("legacy occupation gets a single validated weight scope", () => {
  const scopes = parseDirectionalTheoryWeights(common, { ...occupation, directions: [] });
  assert.equal(scopes.length, 1);
  assert.equal(scopes[0].directionId, null);
  assert.equal(scopes[0].items.length, 3);
  assert.deepEqual(Object.values(theoryWeightTotals(scopes[0].items)), [100, 100, 100, 100, 100]);
});

test("matrix columns match configured names and share the common grade", () => {
  const scopes = parseDirectionalTheoryWeights(matrix, occupation);
  assert.deepEqual(scopes.map((scope) => scope.directionId), ["ordinary", "cnc"]);
  assert.equal(scopes[0].items[1].weights.level_4, 95);
  assert.equal(scopes[1].items[1].weights.level_4, 85);
  assert.equal(scopes[1].items[1].weights.level_5, 95);
});

test("separate direction tables are matched by name, not table order", () => {
  const input = common.replace("权重表", "权重表 数控车床") +
    common.replace("4.1 理论知识权重表", "普通车床").replace("75 75 75 80 80", "75 75 75 80 80");
  const scopes = parseDirectionalTheoryWeights(input, occupation);
  assert.deepEqual(scopes.map((scope) => scope.directionName), ["普通车床", "数控车床"]);
});

test("PDF column hints resolve a physically grouped header", () => {
  const flattened = matrix.replace(/五级\/初级工.*\n/, `${labels.join(" ")}\n普通车床 数控车床 普通车床 数控车床 普通车床 数控车床 普通车床 数控车床\n`);
  const hints: WeightColumnHint[] = theoryWeightLevels.flatMap<WeightColumnHint>((levelCode, index) => index === 0
    ? [{ levelCode, directionName: null }]
    : directions.map((direction) => ({ levelCode, directionName: direction.name })));
  assert.throws(() => parseDirectionalTheoryWeights(flattened, occupation), /无法可靠/);
  assert.equal(parseDirectionalTheoryWeights(flattened, occupation, hints)[1].items[1].weights.level_4, 85);
});

test("missing directions, overlapping names, bad totals and incomplete tables reject import", () => {
  assert.throws(() => parseDirectionalTheoryWeights(common, occupation), /未标明/);
  assert.throws(() => parseDirectionalTheoryWeights(common.replace("权重表", "权重表 普通车床"), occupation), /未匹配.*数控车床/);
  assert.throws(() => parseDirectionalTheoryWeights(matrix.replace("95 95 85", "94 95 85"), occupation), /不等于 100/);
  assert.throws(() => parseDirectionalTheoryWeights(common.replace(/合计.*/, ""), { ...occupation, directions: [] }), /合计/);
});

test("full-width numbers, split direction names and dashes are normalized", () => {
  const normalized = matrix.replace(/普通车床/g, "普 通 车 床").replace(/数控车床/g, "数 控 车 床").replace(/95/g, "９５");
  assert.equal(parseDirectionalTheoryWeights(normalized, occupation)[1].items[1].weights.level_4, 85);
});

test("skill requirements and related knowledge have separate child kinds", () => {
  const scopes = parseDirectionalTheoryWeights(common, { ...occupation, directions: [] });
  const requirements = parseStandardRequirements(work + "\n" + common, scopes);
  assert.equal(requirements.length, 5);
  const fn = requirements[0].functions[0];
  assert.equal(fn.name, "加工");
  assert.equal(fn.contents[0].name, "作业准备");
  assert.deepEqual(fn.contents[0].requirements.map((item) => item.kind), [
    "skill_requirement", "skill_requirement", "related_knowledge", "related_knowledge",
  ]);
});

test("explicit direction sections produce separate requirement scopes", () => {
  const scopes = parseDirectionalTheoryWeights(matrix, occupation);
  const text = `3. 工作要求\n${labels.map((label, index) => `3.${index + 1} ${label}
3.${index + 1}.1 普通车床
职业功能 工作内容 技能要求 相关知识要求
1. 普通加工 1.1 作业准备 1.1.1 能选择刀具 1.1.1 刀具类型
3.${index + 1}.2 数控车床
职业功能 工作内容 技能要求 相关知识要求
1. 数控加工 1.1 程序准备 1.1.1 能检查程序 1.1.1 程序格式`).join("\n")}`;
  const requirements = parseStandardRequirements(text + "\n" + matrix, scopes);
  assert.equal(requirements.length, 10);
  assert.equal(requirements[0].directionId, "ordinary");
  assert.equal(requirements[1].directionId, "cnc");
});

test("missing work section or missing parent cannot silently publish weights alone", () => {
  const scopes = parseDirectionalTheoryWeights(common, { ...occupation, directions: [] });
  assert.throws(() => parseStandardRequirements(common, scopes), /工作要求/);
  assert.throws(() => parseStandardRequirements(work.replace("1. 加工", "") + common, scopes), /父级/);
});

test("real donation standard retains all five levels and screenshot hierarchy", async () => {
  const { extractPdfText } = await import("../../documents/extraction/service");
  const text = (await extractPdfText(await readFile("docs/测试真实数据/劝募员-标准（技能水平和理论知识&一级到五级）.pdf"))).text;
  const scopes = parseDirectionalTheoryWeights(text, { name: "劝募员", code: "3-01-01-05", directions: [] });
  const requirements = parseStandardRequirements(text, scopes);
  assert.equal(requirements.length, 5);
  assert.equal(requirements[0].functions[0].name, "公益慈善宣讲");
  assert.equal(requirements[0].functions[0].contents[0].name, "理念宣传");
  assert.equal(requirements[0].functions[0].contents[0].requirements[0].name, "能宣讲募捐工作基本理念");
  assert.deepEqual(requirements.map((scope) => scope.functions.reduce((sum, fn) => sum +
    fn.contents.reduce((sum, content) => sum + content.requirements.filter((item) => item.kind === "skill_requirement").length, 0), 0)), [17, 17, 17, 18, 19]);
});
