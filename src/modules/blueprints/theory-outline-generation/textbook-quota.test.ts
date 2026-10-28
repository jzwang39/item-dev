import assert from "node:assert/strict";
import test from "node:test";
import { allocateQuota, planTextbookQuotas, type TextbookWeight } from "./textbook-quota";
import type { StandardKnowledge } from "./textbook-generation";

const chapters = [
  { id: "foundation", ordinal: 1, chapterTitle: "基础知识", sectionTitle: null, content: "知识内容".repeat(30) },
  { id: "ethics", ordinal: 2, chapterTitle: "职业道德", sectionTitle: null, content: "职业道德规范".repeat(20) },
];
const knowledge: StandardKnowledge[] = ["1.1.1", "1.1.2", "2.1.1"].map((code) => ({
  id: code, code, levelCode: "level_5", name: "知识要求", evidence: "相关知识的原文",
  functionCode: code[0], functionName: code[0] === "1" ? "宣讲" : "组织",
  contentCode: `${code[0]}.1`, contentName: "工作内容", blueprintVersionId: "version", fileObjectId: "file", sourceVersionId: null,
}));
const weights: TextbookWeight[] = [
  { id: "basic", name: "基础知识", category: "基本要求", weights: { level_5: 15 }, blueprintVersionId: "version" },
  { id: "ethics", name: "职业道德", category: "基本要求", weights: { level_5: 5 }, blueprintVersionId: "version" },
  { id: "function1", name: "宣讲", category: "相关知识要求", weights: { level_5: 30 }, blueprintVersionId: "version" },
  { id: "function2", name: "组织", category: "相关知识要求", weights: { level_5: 50 }, blueprintVersionId: "version" },
];
test("最大余数分配保持整数与父级总额，平局按来源顺序", () => {
  assert.deepEqual([...allocateQuota(5, [{ id: "a", size: 1 }, { id: "b", size: 1 }])], [["a", 3], ["b", 2]]);
  assert.deepEqual([...allocateQuota(8, [{ id: "a", size: 3 }, { id: "b", size: 1 }])], [["a", 6], ["b", 2]]);
  assert.throws(() => allocateQuota(3, []), /缺少/);
});
test("先算范围配额，不对每个下属条目重复乘权重", () => {
  const plan = planTextbookQuotas(chapters, knowledge, ["level_5"], weights).get("level_5")!;
  assert.equal(plan.total, 200);
  assert.equal(plan.basic.reduce((sum, quota) => sum + quota.count, 0), 40);
  assert.deepEqual(plan.related.map((quota) => quota.count), [30, 30, 100]);
  assert.equal(plan.basic.find((quota) => quota.sourceId === "ethics")?.count, 10);
});
test("权重缺失、合计错误、重复范围与未匹配来源均拒绝", () => {
  assert.throws(() => planTextbookQuotas(chapters, knowledge, ["level_5"], []), /缺少/);
  assert.throws(() => planTextbookQuotas(chapters, knowledge, ["level_5"], weights.slice(1)), /100%/);
  assert.throws(() => planTextbookQuotas(chapters, knowledge, ["level_5"], [...weights, weights[0]]), /重复/);
  assert.throws(() => planTextbookQuotas(chapters.slice(0, 1), knowledge, ["level_5"], weights), /职业道德.*没有匹配/);
  assert.throws(() => planTextbookQuotas(chapters, knowledge, ["level_4"], weights), /权重缺失/);
});
test("半个百分点换算为整数，零权重来源不调用模型", () => {
  const adjusted = weights.map((weight) => ({ ...weight, weights: { level_5:
    weight.id === "function1" ? 0 : weight.id === "function2" ? 80.5 : weight.id === "basic" ? 14.5 : 5 } }));
  const plan = planTextbookQuotas(chapters, knowledge, ["level_5"], adjusted).get("level_5")!;
  assert.equal(plan.total, 200);
  assert.equal(plan.related.length, 1);
  assert.equal(plan.related[0].count, 161);
});
