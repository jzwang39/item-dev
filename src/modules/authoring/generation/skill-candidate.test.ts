import assert from "node:assert/strict";
import test from "node:test";
import { aliasedSources, applySkillPatch, calculateSkillRubric, parseSkillCandidate, parseSkillDesign, resolveSkillSources, skillRepairFields } from "./skill-candidate";

const rubric = { totalScore: 100, criteria: [1, 1, 1].map((weight, index) => ({
  item: `项目${index + 1}`, weight, standard: "按要求完整执行并提交可核验成果", rationale: "各技能环节重要性相同",
})) };
const candidate = { assessmentPointCode: "A", questionType: "practical", options: [],
  stem: "根据提供的模拟借阅资料，完成借阅信息登记和归还资料核对，提交完整登记表及核对记录。",
  answers: ["逐项核对模拟资料并填写借阅信息登记表。", "检查资料完整性并提交核对记录。"],
  analysis: "依据正式原文核验登记及资料完整性要求。", weightedRubric: rubric };

test("评分按明确权重计算最大余数，严格合计100且保留原始理由", () => {
  const result = calculateSkillRubric(rubric);
  assert.deepEqual(result.rubric.criteria.map((item) => item.score), [33.34, 33.33, 33.33]);
  assert.equal(Math.round(result.rubric.criteria.reduce((sum, item) => sum + item.score, 0) * 100), 10000);
  assert.equal(result.calculation.original.criteria[0].rationale, "各技能环节重要性相同");
  const parsed = parseSkillCandidate(JSON.stringify({ questions: [candidate] }), "A", "职业");
  assert.ok(parsed.question.scoringCalculation);
  assert.equal(parsed.question.scoreRubric?.totalScore, 100);
});

test("不能缺理由、猜权重、改总分或生成0分评分项目", () => {
  assert.throws(() => calculateSkillRubric({ ...rubric, totalScore: 90 }));
  assert.throws(() => calculateSkillRubric({ ...rubric, criteria: [{ ...rubric.criteria[0], weight: 0 }] }));
  assert.throws(() => calculateSkillRubric({ ...rubric, criteria: [{ ...rubric.criteria[0], rationale: "" }] }));
  assert.throws(() => calculateSkillRubric({ ...rubric, criteria: [{ ...rubric.criteria[0], weight: 0.000001 }, { ...rubric.criteria[1], weight: 10000 }] }), /分值为0/);
});

test("单候选及具体内容字段校验不放宽，也不把旧分值默认当作权重", () => {
  assert.throws(() => parseSkillCandidate(JSON.stringify({ questions: [candidate, candidate] }), "A", "职业"), /仅返回1/);
  assert.throws(() => parseSkillCandidate(JSON.stringify({ questions: [{ ...candidate, stem: "登记资料" }] }), "A", "职业"), /stem/);
  assert.throws(() => parseSkillCandidate(JSON.stringify({ questions: [{ ...candidate, answers: ["登记"] }] }), "A", "职业"), /answers\[0\]/);
  assert.throws(() => parseSkillCandidate(JSON.stringify({ questions: [{ ...candidate, analysis: "好" }] }), "A", "职业"), /analysis/);
  assert.throws(() => parseSkillCandidate(JSON.stringify({ questions: [{ ...candidate, weightedRubric: undefined,
    scoreRubric: { totalScore: 100, criteria: [{ item: "登记资料", score: 90, standard: "登记内容完整准确" }] } }] }), "A", "职业"), /分值之和/);
});

test("字段补丁仅修改允许字段，保留已有答案和题干", () => {
  const response = JSON.stringify({ questions: [candidate] });
  const updated = applySkillPatch(response, JSON.stringify({ patch: { weightedRubric: rubric } }), ["weightedRubric"]);
  assert.deepEqual(JSON.parse(updated).questions[0].answers, candidate.answers);
  assert.equal(JSON.parse(updated).questions[0].stem, candidate.stem);
  assert.throws(() => applySkillPatch(response, '{"patch":{"answers":["另一个答案"]}}', ["weightedRubric"]), /指定字段/);
  assert.deepEqual(skillRepairFields(["weightedRubric：criteria.0.weight: 必须为正数"]), ["weightedRubric"]);
});

test("引用采用确定性短编号映射，未知或相似编号不猜测", () => {
  const sources = [{ id: "frozen-a-hash", content: "借阅资料必须登记" }, { id: "frozen-b-hash", content: "归还资料核对完整性" }];
  assert.deepEqual(aliasedSources(sources).map((item) => item.id), ["S1", "S2"]);
  assert.deepEqual(resolveSkillSources(["S2", "S1"], sources), ["frozen-b-hash", "frozen-a-hash"]);
  assert.throws(() => resolveSkillSources(["S01"], sources), /未知来源编号/);
  const design = { scenario: candidate.stem, materials: ["模拟借阅资料"], requirements: ["登记并核对资料完整性"],
    deliverables: ["提交完整登记表及核对记录"], steps: candidate.answers, observations: ["检查登记内容和资料完整性"],
    sourceIds: ["S1"], difference: "考查资料登记的实际操作流程" };
  assert.equal(parseSkillDesign(JSON.stringify(design), sources).sourceIds[0], sources[0].id);
});
