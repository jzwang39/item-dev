import assert from "node:assert/strict";
import { test } from "node:test";
import { allocateWeighted, inventoryKey, rangeTargets, scaleRubric, scoreCents, suggestWeightedSections, type WeightedSection } from "./weight-policy";
import { mapPointRange, type WeightBasis } from "./weight-basis";
import { scoringText } from "@/modules/documents/paper-word";

const ranges = [
  { key: "A", category: "技能要求", name: "募集管理", weight: 30 },
  { key: "B", category: "技能要求", name: "捐赠管理", weight: 70 },
];
const inventory = (type: string, a: number, b: number) => ({
  [inventoryKey("A", type)]: a, [inventoryKey("B", type)]: b,
});

function assertAllocation(sections: WeightedSection[], output: ReturnType<typeof allocateWeighted>, weights = ranges) {
  for (const paper of output) {
    const scores = new Map(weights.map((range) => [range.key, 0]));
    sections.forEach((section, index) => {
      assert.equal(paper.filter((cell) => cell.section === index).reduce((sum, cell) => sum + cell.count, 0), section.itemCount);
    });
    for (const cell of paper) scores.set(cell.range, scores.get(cell.range)! + cell.count * scoreCents(sections[cell.section].scorePerItem));
    for (const range of weights) assert.equal(scores.get(range.key), range.weight * 100);
  }
}

test("理论80单选20判断，按30/70分数抽题，不更改题型题量分值", () => {
  const sections = [
    { questionType: "B 单项选择题", itemCount: 80, scorePerItem: 1 },
    { questionType: "C 判断题", itemCount: 20, scorePerItem: 1 },
  ];
  const available = { ...inventory("单项选择题", 60, 160), ...inventory("判断题", 40, 60) };
  const output = allocateWeighted(sections, ranges, available, 2);
  assertAllocation(sections, output);
  assert.deepEqual(sections.map((row) => row.itemCount), [80, 20]);
});

test("按分数而非题数：1题30分+1题70分满足30/70", () => {
  const sections = [
    { questionType: "实操题", itemCount: 1, scorePerItem: 30 },
    { questionType: "实操题", itemCount: 1, scorePerItem: 70 },
  ];
  assertAllocation(sections, allocateWeighted(sections, ranges, inventory("实操题", 1, 1), 1));
});

test("1题100分不能覆盖30/70，提供2题调整，建议不修改输入", () => {
  const sections = [{ questionType: "实操题", itemCount: 1, scorePerItem: 100 }];
  assert.throws(() => allocateWeighted(sections, ranges, inventory("实操题", 2, 2), 1), /无法精确组成/);
  const suggestion = suggestWeightedSections(sections, ranges, inventory("实操题", 2, 2), 1);
  assert.deepEqual(suggestion.map((row) => row.scorePerItem), [30, 70]);
  assertAllocation(suggestion, allocateWeighted(suggestion, ranges, inventory("实操题", 2, 2), 1));
  assert.equal(sections[0].scorePerItem, 100);
});

test("总库存足够但某范围不足时阻止，不从其他范围借题", () => {
  assert.throws(() => allocateWeighted([{ questionType: "实操题", itemCount: 10, scorePerItem: 10 }],
    ranges, inventory("实操题", 2, 100), 1), /无法同时满足/);
  assert.throws(() => suggestWeightedSections([{ questionType: "实操题", itemCount: 1, scorePerItem: 100 }],
    ranges, inventory("实操题", 0, 100), 1), /募集管理.*补充题库/);
});

test("多套联合分配允许每套不同组合，全批不重复消耗库存", () => {
  const half = ranges.map((range) => ({ ...range, weight: 50 }));
  const sections = [{ questionType: "单项选择题", itemCount: 2, scorePerItem: 25 }, { questionType: "判断题", itemCount: 1, scorePerItem: 50 }];
  const available = { ...inventory("单项选择题", 2, 2), ...inventory("判断题", 1, 1) };
  const result = allocateWeighted(sections, half, available, 2);
  assertAllocation(sections, result, half);
  const consumed: Record<string, number> = {};
  for (const paper of result) for (const cell of paper) {
    const key = inventoryKey(cell.range, sections[cell.section].questionType);
    consumed[key] = (consumed[key] ?? 0) + cell.count;
  }
  assert.deepEqual(consumed, available);
});

test("多个同题型分区共享库存，不重复计算容量", () => {
  const sections = [{ questionType: "实操题", itemCount: 1, scorePerItem: 30 }, { questionType: "实操题", itemCount: 1, scorePerItem: 70 }];
  assert.throws(() => allocateWeighted(sections, ranges, inventory("实操题", 1, 0), 1), /库存不足/);
});

test("范围锁定分区不可跨范围，未知范围阻止", () => {
  const sections = [{ questionType: "实操题", rangeKey: "B", itemCount: 1, scorePerItem: 30 }, { questionType: "实操题", rangeKey: "A", itemCount: 1, scorePerItem: 70 }];
  assert.throws(() => allocateWeighted(sections, ranges, inventory("实操题", 10, 10), 1), /无法精确组成/);
});

test("严格目标不允许四舍五入，分值精度与权重合计校验", () => {
  assert.throws(() => scoreCents(0.333), /两位小数/);
  assert.throws(() => rangeTargets([{ ...ranges[0], weight: 30.005 }, { ...ranges[1], weight: 69.995 }], 100), /不能舍入/);
  assert.throws(() => rangeTargets([{ ...ranges[0], weight: 31 }, ranges[1]], 100), /合计为100/);
});

test("调整建议不均分舍入：50分三题拆成16.66与16.67，范围总分精确", () => {
  const half = ranges.map((range) => ({ ...range, weight: 50 }));
  const suggestion = suggestWeightedSections([{ questionType: "实操题", itemCount: 6, scorePerItem: 100 / 6 }],
    half, inventory("实操题", 3, 3), 1);
  assertAllocation(suggestion, allocateWeighted(suggestion, half, inventory("实操题", 3, 3), 1), half);
  assert.deepEqual(suggestion.slice(0, 2).map((row) => [row.itemCount, row.scorePerItem]), [[1, 16.66], [2, 16.67]]);
});

test("明确完整父级路径映射，不把多范围题重复算分", () => {
  const basis: WeightBasis = { versionId: "v1", versionNo: 1, direction: "通用", ranges };
  assert.equal(mapPointRange({ direction: "通用", sourceStandardRequirement: { functionName: "募集管理" } }, basis, "skill"), "A");
  assert.equal(mapPointRange({ direction: "数控", sourceStandardRequirement: { functionName: "募集管理" } }, basis, "skill"), null);
  assert.equal(mapPointRange({ sourceStandardRequirement: { functionName: "募集管理" }, level2Name: "捐赠管理" }, basis, "skill"), null);
  assert.equal(mapPointRange({ level2Name: "测试考评点" }, basis, "skill"), null);
});

test("理论相关知识映射职业功能，公共基本要求不会因同名误归类", () => {
  const theory = { versionId: "v", versionNo: 1, direction: "通用", ranges: [
    { key: "K", category: "相关知识要求", name: "捐赠管理", weight: 80 },
    { key: "F", category: "基本要求", name: "基础知识", weight: 20 },
  ] };
  assert.equal(mapPointRange({ sectionKind: "related_knowledge", standardSource: { functionName: "捐赠管理" } }, theory, "theory"), "K");
  assert.equal(mapPointRange({ sectionKind: "basic", secondaryName: "基础知识" }, theory, "theory"), "F");
  assert.equal(mapPointRange({ sectionKind: "basic", secondaryName: "捐赠管理" }, theory, "theory"), null);
});

test("实操评分同比换算仅写试卷快照，分值和准确，原题不变", () => {
  const rubric = { totalScore: 100, criteria: [
    { item: "准备", score: 33, standard: "完成材料核验" },
    { item: "执行", score: 33, standard: "完整执行任务" },
    { item: "整理", score: 34, standard: "完成成果提交" },
  ] };
  const scaled = scaleRubric(rubric, 30);
  assert.equal(scaled.criteria.reduce((sum, item) => sum + scoreCents(item.score), 0), 3000);
  assert.deepEqual(scaled.originalRubric, rubric);
  assert.equal(rubric.totalScore, 100);
  const text = scoringText({ item_no: 1, section_no: 1, question_type: "实操题", stem_snapshot: "", content_snapshot_json: {},
    answer_snapshot_json: {}, score_rubric_snapshot_json: scaled, score: 30 }).join("\n");
  assert.match(text, /总分：30分/);
  assert.doesNotMatch(text, /originalRubric/);
  assert.throws(() => scaleRubric(null, 30), /评分标准缺失/);
});
