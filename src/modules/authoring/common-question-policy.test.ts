import assert from "node:assert/strict";
import test from "node:test";
import { basicIdentity, commonCoverage, commonLevels, commonQuotaPoints, formalQuestionSource, matchCommonPoints,
  validateCommonQuota, type CommonNode } from "./common-question-policy";
import { theoryQuestionPrompt } from "./generation/theory-prompt";
import type { Snapshot } from "./generation/contracts";

function node(id: string, name = "职业道德要求"): CommonNode {
  return { id, name, node_code: `${id}-A-001`,
    requirement_json: { sectionKind: "basic", sharedPointKey: "standard:version:2.1:1" },
    source_ref_json: { chapterIds: [], standardBasic: { evidence: "职业道德要求原文", code: "2.1" } } };
}
function basis() { return Object.fromEntries(commonLevels.map((level) => [level, [node(level)]])); }
test("公共对应按共用标识匹配而不是不同等级编码，映射保留各等级节点", () => {
  const points = matchCommonPoints(basis());
  assert.equal(points.length, 1);
  assert.equal(points[0].nodes.level_3.code, "level_3-A-001");
  assert.equal(basicIdentity({ ...node("n"), requirement_json: { sectionKind: "related_knowledge" } }), null);
});
test("缺少标识、来源或名称不一致、遗漏和重复考评点均拒绝共用", () => {
  assert.throws(() => basicIdentity({ ...node("n"), requirement_json: { sectionKind: "basic" } }), /缺少共用标识/);
  for (const mutate of [
    (data: ReturnType<typeof basis>) => { data.level_4 = []; },
    (data: ReturnType<typeof basis>) => { data.level_4.push(node("other")); },
    (data: ReturnType<typeof basis>) => { data.level_3[0].name = "不同知识要求"; },
    (data: ReturnType<typeof basis>) => { data.level_3[0].source_ref_json = { chapterIds: ["其他教材"] }; },
  ]) {
    const data = basis(); mutate(data);
    assert.throws(() => matchCommonPoints(data), /不一致|重复/);
  }
});
test("公共配额逐点逐型校验，不用总数掩盖缺额，各等级引用同一配额", () => {
  const points = matchCommonPoints(basis()), key = points[0].key;
  const quota = validateCommonQuota(points, [{ key, single: 4, multiple: 0, judgement: 2 }]);
  for (const level of commonLevels) assert.equal(commonQuotaPoints(points, quota, level)[0].total, 6);
  const coverage = commonCoverage(quota, Array.from({ length: 8 }, () => ({ point_key: key, question_type: "单项选择题" })));
  assert.equal(coverage.find((item) => item.type === "judgement")!.count, 0);
  assert.throws(() => validateCommonQuota(points, [...quota, ...quota]), /不能重复/);
  assert.throws(() => validateCommonQuota(points, [{ key, single: 0, multiple: 0, judgement: 0 }]));
});
test("公共题组仅配置单选、判断题，拒绝多选配额", () => {
  const points = matchCommonPoints(basis()), key = points[0].key;
  assert.equal(validateCommonQuota(points, [{ key, single: 4, judgement: 2 }])[0].multiple, 0);
  assert.throws(() => validateCommonQuota(points, [{ key, single: 4, multiple: 1, judgement: 2 }]));
});
test("正式取题排除维护版本，以公共发布版本取代旧等级基本题，技能不受影响", () => {
  assert.match(formalQuestionSource, /common_question_release_items/);
  assert.match(formalQuestionSource, /NOT EXISTS\(SELECT 1 FROM common_question_members/);
  assert.match(formalQuestionSource, /assessment_mode='theory'/);
  assert.match(formalQuestionSource, /current_release_id IS NOT NULL/);
});
test("公共提示词明确五四三级共用，不把技术关联五级当成单等级命题", () => {
  const snapshot = { scope: { commonGroupId: "group", occupation: "劝募员", levelCode: "level_5" },
    nodes: [{ code: "A", name: "职业道德" }], qualityStandard: "完整质量标准", qualityRequirements: [] } as unknown as Snapshot;
  const prompt = theoryQuestionPrompt(snapshot, "A", ["single"], [], [], 1, true);
  assert.equal(JSON.parse(prompt.prompt).等级, "五级、四级、三级共用基本要求");
  assert.match(prompt.instruction, /不按技术关联等级/);
});
