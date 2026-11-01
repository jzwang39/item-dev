import assert from "node:assert/strict";
import test from "node:test";
import { candidateReviewPrompt, parseCandidateReview } from "./candidate-review";
import type { GeneratedQuestion, Snapshot } from "./contracts";

const candidate: GeneratedQuestion = { assessmentPointCode: "A", questionType: "judgement", stem: "借阅资料需要完成登记手续。", options: [], answers: ["正确"], analysis: "原文要求借阅登记。" };
const sources = [{ id: "source", content: "借阅资料须登记。" }];
const check = { index: 0, meetsQualityStandard: true, answerCorrect: true, evidenceSupported: true, distinctTask: true,
  score: 90, explanation: "原文明确要求登记，与已有任务不同。", evidenceSourceIds: ["source"],
  requirements: [{ requirement: "判断须有明确正误", passed: true, explanation: "原文可支持" }] };

test("任一完整标准要求、答案、依据或任务差异不通过，分数再高也不计入成果", () => {
  for (const change of [
    { meetsQualityStandard: false }, { answerCorrect: false }, { evidenceSupported: false }, { distinctTask: false },
    { requirements: [{ requirement: "每题须独立知识", passed: false, explanation: "知识重复" }] },
  ]) {
    const result = parseCandidateReview(JSON.stringify({ checks: [{ ...check, score: 100, ...change }] }), [candidate], sources);
    assert.equal(result.questions.length, 0);
    assert.equal(result.failures[0].code, "quality_rejected");
  }
  assert.throws(() => parseCandidateReview(JSON.stringify({ checks: [{ ...check, evidenceSourceIds: ["虚构来源"] }] }), [candidate], sources), /未知原文编号/);
});

test("只在全部检查通过后排序择优，遗漏或重复索引不能默认通过", () => {
  const result = parseCandidateReview(JSON.stringify({ checks: [{ ...check, score: 80 }, { ...check, index: 1, score: 95 }] }),
    [candidate, { ...candidate, stem: "归还资料需要核对完整性。" }], sources);
  assert.equal(result.questions[0].standardReview?.score, 95);
  assert.throws(() => parseCandidateReview(JSON.stringify({ checks: [check] }), [candidate, candidate], sources), /遗漏/);
  assert.throws(() => parseCandidateReview(JSON.stringify({ checks: [check, check] }), [candidate, candidate], sources), /遗漏/);
  assert.throws(() => parseCandidateReview("broken", [candidate], sources), /格式无效/);
});

test("候选核验也严格隔离数据库标准，不覆盖独立性和多样性要求", () => {
  const base: Snapshot = {
    projectId: "p", requirement: "补题", points: [], qualityRequirements: ["唯一解"], qualityStandard: "理论数据库完整标准",
    skillQualityStandard: "技能数据库完整标准", sourceVersionIds: [], nodes: [],
    scope: { occupationId: "o", occupation: "职业", levelCode: "level_4", assessmentMode: "理论知识", blueprintVersions: { outline: { id: "v", versionNo: 1 }, weights: { id: "w", versionNo: 1 } } },
    model: { provider: "test", baseUrl: "https://example.com", model: "test" },
  };
  for (const mode of ["理论知识", "操作技能"] as const) {
    const prompt = candidateReviewPrompt({ ...base, scope: { ...base.scope, assessmentMode: mode } }, "A", [candidate], [], sources);
    const data = JSON.parse(prompt.prompt);
    assert.equal(data[mode === "理论知识" ? "试题质量标准" : "操作技能试题质量标准"], mode === "理论知识" ? base.qualityStandard : base.skillQualityStandard);
    assert.equal(Object.hasOwn(data, mode === "理论知识" ? "操作技能试题质量标准" : "试题质量标准"), false);
    assert.match(prompt.instruction, /不得覆盖知识独立性、多样性要求/);
  }
});
