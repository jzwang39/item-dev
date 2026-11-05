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

test("核验结果兼容 requirements 别名和缺省回填，避免因格式小偏差直接废弃候选", () => {
  const alias = parseCandidateReview(JSON.stringify({ checks: [{
    ...check,
    requirements: undefined,
    requirementChecks: [{ name: "判断须有明确正误", ok: true, reason: "原文可支持" }],
  }] }), [candidate], sources);
  assert.equal(alias.questions.length, 1);
  assert.equal(alias.questions[0].standardReview?.requirements[0].requirement, "判断须有明确正误");

  const fallback = parseCandidateReview(JSON.stringify({ checks: [{
    ...check,
    requirements: undefined,
  }] }), [candidate], sources);
  assert.equal(fallback.questions.length, 1);
  assert.equal(fallback.questions[0].standardReview?.requirements[0].requirement, "完整质量标准核验");
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

test("单选全角括号和题干直给正确项核心词时，本地规则也会拦截", () => {
  const single: GeneratedQuestion = {
    assessmentPointCode: "A",
    questionType: "single",
    stem: "开展互联网公开募捐时，使用的合规线上渠道属于（　　）。",
    options: [
      { key: "A", content: "信息服务" },
      { key: "B", content: "公开募捐平台" },
      { key: "C", content: "志愿服务" },
      { key: "D", content: "内部管理" },
    ],
    answers: ["B"],
    analysis: "标准原文列出能运用互联网公开募捐平台募捐。",
  };
  const result = parseCandidateReview(JSON.stringify({ checks: [{
    index: 0,
    meetsQualityStandard: true,
    answerCorrect: true,
    evidenceSupported: true,
    distinctTask: true,
    score: 95,
    explanation: "依据方向正确。",
    evidenceSourceIds: ["source"],
    requirements: [{ requirement: "完整质量标准核验", passed: true, explanation: "模型判通过" }],
  }] }), [single], sources);
  assert.equal(result.questions.length, 0);
  assert.match(result.failures[0].message, /半角\(　　\)/);
  assert.match(result.failures[0].message, /核心词/);
});

test("理论生成提示词明确禁止概念词面回填并要求单选半角括号", () => {
  const snapshot: Snapshot = {
    projectId: "p", requirement: "补题", points: [], qualityRequirements: ["唯一解"], qualityStandard: "理论数据库完整标准",
    sourceVersionIds: [], skillQualityStandard: undefined,
    nodes: [{ id: "n", code: "A", name: "公开募捐", chapterIds: ["c"], theoryContext: { evidence: "标准原文" } }],
    scope: { occupationId: "o", occupation: "职业", levelCode: "level_4", assessmentMode: "理论知识", blueprintVersions: { outline: { id: "v", versionNo: 1 }, weights: { id: "w", versionNo: 1 } } },
    model: { provider: "test", baseUrl: "https://example.com", model: "test" },
  };
  const { theoryQuestionPrompt } = require("./theory-prompt") as typeof import("./theory-prompt");
  const prompt = theoryQuestionPrompt(snapshot, "A", ["single"], [], [{ id: "textbook:1", content: "标准原文" }], 1, true);
  assert.match(prompt.instruction, /半角\(　　\)/);
  assert.match(prompt.instruction, /不得再把该概念名称本身设为空/);
});

test("基本原则类考评点不得把捐赠人主体范围定义题当成合格候选", () => {
  const single: GeneratedQuestion = {
    assessmentPointCode: "A",
    questionType: "single",
    stem: "可以成为捐赠人的主体范围是(　　)。",
    options: [
      { key: "A", content: "自然人、法人或者其他组织" },
      { key: "B", content: "仅限自然人和法人" },
      { key: "C", content: "仅限法人和非法人组织" },
      { key: "D", content: "捐赠人、受益人和志愿者" },
    ],
    answers: ["A"],
    analysis: "标准原文界定捐赠人是以慈善为目的，自愿无偿捐赠财产的自然人、法人或者其他组织。",
  };
  const result = parseCandidateReview(JSON.stringify({ checks: [{
    index: 0,
    meetsQualityStandard: true,
    answerCorrect: true,
    evidenceSupported: true,
    distinctTask: true,
    score: 92,
    explanation: "原文有直接定义依据。",
    evidenceSourceIds: ["source"],
    requirements: [{ requirement: "完整质量标准核验", passed: true, explanation: "模型判通过" }],
  }] }), [single], sources, { pointName: "募捐工作的基本原则", kind: "theory" });
  assert.equal(result.questions.length, 0);
  assert.match(result.failures[0].message, /基本原则/);
  assert.match(result.failures[0].message, /主体范围或术语定义/);
});

test("基本原则类理论提示词明确禁止定义题和主体范围题", () => {
  const snapshot: Snapshot = {
    projectId: "p", requirement: "补题", points: [], qualityRequirements: ["唯一解"], qualityStandard: "理论数据库完整标准",
    sourceVersionIds: [], skillQualityStandard: undefined,
    nodes: [{ id: "n", code: "A", name: "募捐工作的基本原则", chapterIds: ["c"], theoryContext: { evidence: "标准原文" } }],
    scope: { occupationId: "o", occupation: "职业", levelCode: "level_4", assessmentMode: "理论知识", blueprintVersions: { outline: { id: "v", versionNo: 1 }, weights: { id: "w", versionNo: 1 } } },
    model: { provider: "test", baseUrl: "https://example.com", model: "test" },
  };
  const { theoryQuestionPrompt } = require("./theory-prompt") as typeof import("./theory-prompt");
  const prompt = theoryQuestionPrompt(snapshot, "A", ["single"], [], [{ id: "textbook:1", content: "标准原文" }], 1, true);
  assert.match(prompt.instruction, /基本原则/);
  assert.match(prompt.instruction, /不得仅考术语定义、主体范围/);
});
