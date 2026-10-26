import assert from "node:assert/strict";
import test from "node:test";
import { buildBatches, parseQuestions, stemHash, validateQuota, type QuotaPoint } from "./contracts";

function points(count: number): QuotaPoint[] {
  return Array.from({ length: count }, (_, index) => ({ code: `A-A-A-${index + 1}`, name: `知识范围${index + 1}`, single: 4, multiple: 0, judgement: 2, total: 6 }));
}
function question(extra: Record<string, unknown> = {}) {
  return {
    assessmentPointCode: "A", questionType: "single", stem: "捐赠凭证应采用哪种规范进行归档？",
    options: ["A", "B", "C", "D"].map((key) => ({ key, content: `归档规范${key}` })),
    answers: ["A"], analysis: "应按凭证管理规范归档。",
    ...extra,
  };
}
test("1200题拆为12批96题和1批48题，逐题槽位不重不漏", () => {
  const batches = buildBatches(points(200));
  assert.equal(batches.length, 13);
  assert.deepEqual(batches.map((batch) => batch.target), [...Array(12).fill(96), 48]);
  const ordinals = batches.flatMap((batch) => batch.units.flatMap((unit) => unit.ordinals));
  assert.equal(ordinals.length, 1200);
  assert.equal(new Set(ordinals).size, 1200);
  assert.deepEqual(ordinals, Array.from({ length: 1200 }, (_, index) => index + 1));
  assert.equal(batches.flatMap((batch) => batch.units).length, 200);
  assert.ok(batches.every((batch) => batch.units.every((unit) => unit.ordinals.length === 6)));
  assert.deepEqual(batches[0].units[0].slotTypes, ["single", "single", "single", "single", "judgement", "judgement"]);
});
test("通常保持考评点完整，不跨业务批次", () => {
  const batches = buildBatches(points(18));
  const codes = batches.map((batch) => new Set(batch.units.map((unit) => unit.code)));
  assert.ok([...codes[0]].every((code) => !codes[1].has(code)));
});
test("单点超过100题仍严格满足业务批次及模型请求上限", () => {
  const batches = buildBatches([{ ...points(1)[0], single: 100, multiple: 100, judgement: 100, total: 300 }]);
  assert.equal(batches.length, 3);
  assert.ok(batches.every((batch) => batch.target <= 100 && batch.units.every((unit) => unit.ordinals.length <= 12)));
});
test("数量由实际题型配额推算，不信任传入total", () => {
  assert.equal(buildBatches([{ ...points(1)[0], total: 1200 }])[0].target, 6);
});
test("拒绝重复代码、不足配额和不支持的等级", () => {
  assert.throws(() => validateQuota([points(1)[0], points(1)[0]], "level_4"));
  assert.throws(() => validateQuota([{ ...points(1)[0], single: 3 }], "level_4"));
  assert.throws(() => validateQuota(points(1), "level_1"));
  assert.throws(() => validateQuota([], "level_4"));
});
test("部分无效响应保留有效条目", () => {
  const output = parseQuestions(JSON.stringify({ questions: [question(), question({ stem: "短" })] }), "A", "single");
  assert.equal(output.valid.length, 1);
  assert.equal(output.received, 2);
  assert.equal(output.invalid, 1);
});
test("拒绝错误考评点、题型、重复选项和不合法答案", () => {
  const output = parseQuestions(JSON.stringify({ questions: [
    question({ assessmentPointCode: "B" }), question({ questionType: "multiple" }),
    question({ answers: ["A", "B"] }), question({ answers: ["X"] }),
    question({ options: Array(4).fill({ key: "A", content: "重复选项" }) }),
  ] }), "A", "single");
  assert.equal(output.valid.length, 0);
});
test("多选至少两个答案，判断不得带选项", () => {
  assert.equal(parseQuestions(JSON.stringify({ questions: [question({ questionType: "multiple", answers: ["A", "B"] })] }), "A", "multiple").valid.length, 1);
  assert.equal(parseQuestions(JSON.stringify({ questions: [question({ questionType: "judgement", options: [], answers: ["正确"] })] }), "A", "judgement").valid.length, 1);
  assert.equal(parseQuestions(JSON.stringify({ questions: [question({ questionType: "judgement", answers: ["正确"] })] }), "A", "judgement").valid.length, 0);
});
test("同请求可解析多题型，每条按其真实题型校验", () => {
  const output = parseQuestions(JSON.stringify({ questions: [
    question(),
    question({ questionType: "judgement", stem: "捐赠凭证必须妥善归档保存。", options: [], answers: ["正确"] }),
    question({ questionType: "judgement", stem: "这是带选项的无效判断试题。", answers: ["正确"] }),
  ] }), "A", "mixed");
  assert.deepEqual(output.valid.map((item) => item.questionType), ["single", "judgement"]);
});
test("兼容等价答案解析字段但不推断缺失答案", () => {
  const original = question();
  const { answers, analysis, ...rest } = original;
  const output = parseQuestions(JSON.stringify({ questions: [
    { ...rest, answer: answers[0], explanation: analysis },
    { ...rest, stem: "这道题目没有提供任何答案。" },
  ] }), "A", "mixed");
  assert.equal(output.valid.length, 1);
  assert.deepEqual(output.valid[0].answers, ["A"]);
  assert.ok(output.invalidReasons.some((reason) => reason.includes("answers")));
});
test("同一响应重复题干仅接受一条，规范化空格和全角符号", () => {
  const output = parseQuestions(JSON.stringify({ questions: [question(), question()] }), "A", "single");
  assert.equal(output.valid.length, 1);
  assert.equal(stemHash("凭证 A １"), stemHash("凭证A1"));
});
test("兼容JSON围栏及数组，明确拒绝没有试题数组的结果", () => {
  assert.equal(parseQuestions(`\`\`\`json\n${JSON.stringify([question()])}\n\`\`\``, "A", "single").valid.length, 1);
  assert.throws(() => parseQuestions('{"data":{}}', "A", "single"));
});
