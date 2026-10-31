import assert from "node:assert/strict";
import test from "node:test";
import type { Snapshot } from "./contracts";
import { generationQualityPolicy } from "./quality-policy";
import { theoryQuestionPrompt } from "./theory-prompt";
import { skillQuestionPrompt } from "./skill-prompt";

const snapshot = {
  requirement: "每点4单选2判断",
  scope: { occupation: "测试职业", levelCode: "level_4" },
  nodes: [{ code: "A", name: "资料归档", theoryContext: { evidence: "分类归档规则" }, skillContext: { evidence: "整理提交资料" } }],
  skillStructure: { totalScore: 100 },
  qualityRequirements: ["依据准确"], qualityStandard: "理论标准全文：选项应合理",
  skillQualityStandard: "技能标准全文：成果可观察",
} as unknown as Snapshot;

test("理论按当前考点和题型缺额出题，首轮与补题均保留完整对应标准", () => {
  for (const targeted of [false, true]) {
    const requested = targeted ? ["judgement" as const] : ["single" as const, "single" as const, "judgement" as const];
    const prompt = theoryQuestionPrompt(snapshot, "A", requested, [{ stem: "已有试题" }], [], 2, targeted);
    const data = JSON.parse(prompt.prompt);
    assert.equal(data.考评点.code, "A");
    assert.equal(data.本次必须生成数, requested.length);
    assert.equal(data.本次题型配额.single, targeted ? 0 : 2);
    assert.equal(data.本次题型配额.judgement, 1);
    assert.equal(data.试题质量标准, snapshot.qualityStandard);
    assert.equal(Object.hasOwn(data, "操作技能试题质量标准"), false);
    assert.doesNotMatch(prompt.prompt, /技能标准全文/);
    assert.match(data.质量执行策略.不可放宽底线, /单选唯一解/);
    assert.match(data.质量执行策略.多样性策略, targeted ? /同一知识、不同考查任务/ : /首轮/);
    assert.deepEqual(data.已有试题, [{ stem: "已有试题" }]);
  }
});

test("技能仍按专项标准保证任务、成果、步骤及评分，不自动启用理论变式", () => {
  const prompt = skillQuestionPrompt(snapshot, "A", 1, ["已生成技能任务"]);
  const data = JSON.parse(prompt.prompt);
  assert.equal(data.操作技能试题质量标准, snapshot.skillQualityStandard);
  assert.equal(Object.hasOwn(data, "试题质量标准"), false);
  assert.doesNotMatch(prompt.prompt, /理论标准全文/);
  assert.match(data.质量执行策略.多样性策略, /不得套用理论题/);
  assert.match(data.质量执行策略.多样性策略, /评分项目及分值/);
  assert.match(generationQualityPolicy("theory", true).不可放宽底线, /不得编造/);
});
