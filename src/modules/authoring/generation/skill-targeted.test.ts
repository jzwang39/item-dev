import assert from "node:assert/strict";
import test from "node:test";
import { generateTargeted, type TargetedDependencies } from "./targeted-generation";
import { completeRetry, retryState } from "./retry-policy";
import { ensureTargetedBudget, grantSkillRecovery, markTargetedSaved } from "./targeted-budget";
import type { Snapshot } from "./contracts";

const sources = [{ id: "frozen-skill-a", content: "借阅资料必须登记，归还必须核对完整性。", systemQuote: true }];
const snapshot: Snapshot = {
  projectId: "p", requirement: "每点3实操题", qualityStandard: "理论污染不得传入", skillQualityStandard: "任务完整、成果可观察、步骤准确、评分可核验，禁止重复任务。",
  qualityRequirements: ["依据真实"], sourceVersionIds: ["frozen"], points: [],
  scope: { occupationId: "o", occupation: "职业", levelCode: "level_3", assessmentMode: "操作技能",
    blueprintVersions: { outline: { id: "outline", versionNo: 1 }, weights: { id: "weights", versionNo: 1 } } },
  nodes: [{ id: "n", code: "A", name: "资料登记", chapterIds: [], skillContext: { source: { evidence: sources[0].content } } }],
  skillStructure: { totalScore: 100 },
  model: { provider: "test", baseUrl: "https://example.com", model: "test" },
};
const design = { scenario: "根据模拟资料完成借阅登记及归还核对", materials: ["明确标注的模拟借阅资料"],
  requirements: ["登记资料并核对完整性"], deliverables: ["提交完整登记表和核对记录"], steps: ["逐项核对并登记资料信息"],
  observations: ["登记信息和核对结果准确"], sourceIds: ["S1"], difference: "考查实际登记和核对工作过程" };
const designReview = { evidenceSupported: true, completeTask: true, correctScope: true, distinctTask: true,
  meetsQualityStandard: true, explanation: "任务及成果均被原文明确支持", sourceIds: ["S1"],
  requirements: [{ requirement: "任务完整", passed: true, explanation: "核验任务和成果" }] };
const weightedRubric = { totalScore: 100, criteria: [
  { item: "登记资料", weight: 2, rationale: "登记是任务核心环节", standard: "逐项登记准确并提交完整记录" },
  { item: "完整核对", weight: 1, rationale: "核对保障归还资料完整", standard: "检查资料完整性并提交核对记录" },
] };
const candidate = { assessmentPointCode: "A", questionType: "practical", options: [],
  stem: "根据提供的模拟借阅资料，完成借阅信息登记和归还资料核对，提交完整登记表及核对记录。",
  answers: ["逐项核对并填写借阅登记表，检查资料完整性并提交核对记录。"],
  analysis: "依据正式原文核验登记和核对要求。", weightedRubric };
const finalReview = { checks: [{ index: 0, meetsQualityStandard: true, answerCorrect: true, evidenceSupported: true, distinctTask: true,
  score: 90, explanation: "原文支持操作步骤及任务成果，评分符合完整标准", evidenceSourceIds: ["S1"],
  requirements: [{ requirement: "完整技能标准", passed: true, explanation: "逐项核验任务成果步骤评分" }] }] };
function fixture() {
  const state = retryState(null);
  ensureTargetedBudget(state, [{ id: "slot", ordinal: 1, question_type: "practical" }], 0);
  return { snapshot, code: "A", previous: [] as Array<{ stem: string }>, sources, state };
}
function defaults(prompt: Parameters<TargetedDependencies["call"]>[0]) {
  if (prompt.instruction.includes("技能任务设计助手")) return JSON.stringify(design);
  if (prompt.instruction.includes("技能任务设计核验助手")) return JSON.stringify(designReview);
  if (prompt.instruction.includes("独立核验助手")) return JSON.stringify(finalReview);
  return JSON.stringify({ questions: [candidate] });
}
function deps(call: TargetedDependencies["call"] = async (prompt) => defaults(prompt), signal = new AbortController().signal) {
  return { call, persist: async () => {}, signal };
}

test("技能按设计、设计核验、单候选、完整核验顺序执行，标准隔离且配分留痕", async () => {
  const input = fixture();
  const steps: string[] = [];
  const result = await generateTargeted(input, deps(async (prompt) => {
    assert.doesNotMatch(prompt.prompt, /理论污染不得传入/);
    assert.equal(JSON.parse(prompt.prompt).操作技能试题质量标准, snapshot.skillQualityStandard);
    steps.push(prompt.instruction);
    return defaults(prompt);
  }));
  assert.equal(result.questions.length, 1);
  assert.match(steps[0], /技能任务设计助手/);
  assert.match(steps[1], /技能任务设计核验助手/);
  assert.match(steps[2], /仅生成1道候选/);
  assert.match(steps[3], /独立核验助手/);
  assert.equal(result.questions[0].targetSlotId, "slot");
  assert.deepEqual(result.questions[0].scoreRubric?.criteria.map((item) => item.score), [66.67, 33.33]);
  assert.equal(result.questions[0].scoringCalculation?.original.criteria[0].weight, 2);
  assert.deepEqual(result.questions[0].standardReview?.evidenceSourceIds, [sources[0].id]);
  assert.equal(input.state.budget!.calls, 4);
  assert.equal(input.state.budget!.slots.slot.searchedSourceIds.length, 1);
  markTargetedSaved(input.state, "slot");
  assert.equal(completeRetry(input.state, 1, 1, 0, []).status, "succeeded");
});

test("任务设计核验拒绝时不生成候选，记录具体标准原因", async () => {
  const input = fixture();
  let calls = 0;
  const result = await generateTargeted(input, deps(async (prompt) => {
    calls++;
    if (prompt.instruction.includes("技能任务设计核验助手")) return JSON.stringify({ ...designReview, distinctTask: false,
      explanation: "与已有试题操作任务相同，只替换资料名称" });
    return defaults(prompt);
  }));
  assert.equal(result.questions.length, 0);
  assert.equal(calls, 2);
  assert.match(result.failures[0].message, /操作任务相同/);
  assert.equal(input.state.budget!.slots.slot.generations, 0);
  assert.ok(input.state.budget!.slots.slot.rejectedCandidates?.[0].skillDesignReviewResponse);
});

test("参考步骤太短仅修复answers，已正确题干与评分权重保留", async () => {
  const input = fixture();
  const result = await generateTargeted(input, deps(async (prompt) => {
    if (prompt.instruction.includes("技能字段修订助手")) {
      const data = JSON.parse(prompt.prompt);
      assert.deepEqual(data.允许修复字段, ["answers"]);
      assert.match(data.具体字段错误.join(""), /answers\[0\]/);
      return JSON.stringify({ patch: { answers: candidate.answers } });
    }
    if (prompt.instruction.includes("仅生成1道候选")) return JSON.stringify({ questions: [{ ...candidate, answers: ["登记"] }] });
    return defaults(prompt);
  }));
  assert.equal(result.questions.length, 1);
  assert.equal(result.questions[0].stem, candidate.stem);
  assert.equal(result.questions[0].scoringCalculation?.original.criteria[0].weight, 2);
  assert.deepEqual(result.questions[0].candidateRepairs?.[0].fields, ["answers"]);
  assert.equal(input.state.budget!.slots.slot.generations, 1);
  assert.equal(input.state.budget!.slots.slot.repairs, 1);
});

test("旧评分加总失败不自动猜权重，要求模型论证后计算并完整核验", async () => {
  const input = fixture();
  const result = await generateTargeted(input, deps(async (prompt) => {
    if (prompt.instruction.includes("技能字段修订助手")) {
      assert.deepEqual(JSON.parse(prompt.prompt).允许修复字段, ["weightedRubric"]);
      return JSON.stringify({ patch: { weightedRubric } });
    }
    if (prompt.instruction.includes("仅生成1道候选")) return JSON.stringify({ questions: [{ ...candidate, weightedRubric: undefined,
      scoreRubric: { totalScore: 100, criteria: [{ item: "登记资料", score: 90, standard: "资料登记准确完整" }] } }] });
    return defaults(prompt);
  }));
  assert.equal(result.questions.length, 1);
  assert.ok(result.questions[0].candidateRepairs);
  assert.ok(result.questions[0].standardReview);
  assert.equal(result.questions[0].scoreRubric?.criteria.reduce((sum, item) => sum + item.score, 0), 100);
});

test("完整核验不通过仍拒绝，程序配分不能抵消任务质量问题", async () => {
  const input = fixture();
  const result = await generateTargeted(input, deps(async (prompt) => {
    if (prompt.instruction.includes("独立核验助手")) return JSON.stringify({ checks: [{ ...finalReview.checks[0], answerCorrect: false,
      explanation: "参考步骤没有覆盖原文要求的核对环节" }] });
    return defaults(prompt);
  }));
  assert.equal(result.questions.length, 0);
  assert.equal(result.failures[0].code, "quality_rejected");
  assert.ok(input.state.budget!.slots.slot.rejectedCandidates?.[0].scoringCalculation);
});

test("核验结构错误给出缺失字段，下一次保留同一候选并重新完整核验", async () => {
  const input = fixture();
  let reviews = 0;
  const dependencies = deps(async (prompt) => {
    if (prompt.instruction.includes("独立核验助手")) {
      if (++reviews === 1) return JSON.stringify({ checks: [{ index: 0 }] });
      const data = JSON.parse(prompt.prompt);
      assert.match(data.上次核验具体错误, /checks\.0\.answerCorrect/);
      return JSON.stringify(finalReview);
    }
    return defaults(prompt);
  });
  const first = await generateTargeted(input, dependencies);
  assert.equal(first.questions.length, 0);
  assert.equal(first.failures[0].code, "review_invalid");
  assert.equal((await generateTargeted(input, dependencies)).questions.length, 1);
  assert.equal(input.state.budget!.slots.slot.generations, 1);
  assert.equal(input.state.budget!.calls, 5);
});

test("格式核验两次失败后保留候选归档，剩余额度可设计下一候选", async () => {
  const input = fixture();
  let reviews = 0;
  const dependencies = deps(async (prompt) => {
    if (prompt.instruction.includes("独立核验助手") && ++reviews <= 2) return "broken";
    return defaults(prompt);
  });
  await generateTargeted(input, dependencies);
  const second = await generateTargeted(input, dependencies);
  assert.equal(completeRetry(input.state, 2, 0, 1, second.failures).status, "queued");
  const slot = input.state.budget!.slots.slot;
  assert.equal(slot.rejectedCandidates?.[0].reviewResponses?.length, 2);
  assert.match(slot.rejectedCandidates![0].response, /weightedRubric/);
  assert.equal((await generateTargeted(input, dependencies)).questions.length, 1);
  assert.equal(slot.generations, 2);
});

test("旧3轮耗尽槽位获新专项额度后历史计数继续累加，不被旧熔断误关", async () => {
  const input = fixture();
  const budget = input.state.budget!, slot = budget.slots.slot;
  budget.sourceCount = 1;
  budget.calls = 22;
  slot.generations = 3; slot.repairs = 2;
  slot.blocked = { code: "invalid_content", message: "旧评分错误" };
  assert.equal(grantSkillRecovery(input.state, 9), true);
  let generation = 0;
  const dependencies = deps(async (prompt) => {
    if (prompt.instruction.includes("独立核验助手") && generation === 1) return JSON.stringify({ checks: [{ ...finalReview.checks[0], distinctTask: false }] });
    if (prompt.instruction.includes("仅生成1道候选")) generation++;
    return defaults(prompt);
  });
  const first = await generateTargeted(input, dependencies);
  assert.equal(first.questions.length, 0);
  assert.equal(slot.generations, 4);
  assert.equal(completeRetry(input.state, 10, 0, 1, first.failures).status, "queued");
  assert.equal((await generateTargeted(input, dependencies)).questions.length, 1);
  assert.equal(slot.generations, 5);
  assert.equal(slot.repairs, 2);
  assert.equal(budget.skillRecovery?.previousCalls, 22);
  assert.equal(grantSkillRecovery(input.state, 11), false);
});

test("停止后的迟到技能候选不核验也不保存", async () => {
  const input = fixture();
  const controller = new AbortController();
  let calls = 0;
  const result = await generateTargeted(input, deps(async (prompt) => {
    calls++;
    if (prompt.instruction.includes("仅生成1道候选")) controller.abort(new Error("用户停止"));
    return defaults(prompt);
  }, controller.signal));
  assert.equal(result.questions.length, 0);
  assert.equal(calls, 3);
  assert.equal(input.state.budget!.slots.slot.generations, 0);
});

test("未知短编号不猜引用，下一轮轮换原文，真实查阅范围累计保留", async () => {
  const input = { ...fixture(), sources: Array.from({ length: 8 }, (_, index) => ({ ...sources[0], id: `frozen-${index}` })) };
  let designs = 0;
  const dependencies = deps(async (prompt) => {
    if (prompt.instruction.includes("技能任务设计助手") && ++designs === 1) return JSON.stringify({ ...design, sourceIds: ["S9"] });
    return defaults(prompt);
  });
  assert.equal((await generateTargeted(input, dependencies)).failures[0].code, "evidence_invalid");
  const result = await generateTargeted(input, dependencies);
  assert.equal(result.questions.length, 1);
  assert.deepEqual(result.questions[0].standardReview?.evidenceSourceIds, ["frozen-6"]);
  assert.equal(input.state.budget!.slots.slot.searchedSourceIds.length, 8);
  assert.equal(input.state.budget!.slots.slot.skill?.designAttempts, 2);
});

test("每个技能候选最多修复两次，三轮仍失败关闭且保留全部记录", async () => {
  const input = fixture();
  const dependencies = deps(async (prompt) => {
    if (prompt.instruction.includes("技能字段修订助手")) return '{"patch":{"answers":["登记"]}}';
    if (prompt.instruction.includes("仅生成1道候选")) return JSON.stringify({ questions: [{ ...candidate, answers: ["登记"] }] });
    return defaults(prompt);
  });
  for (let index = 0; index < 3; index++) {
    const output = await generateTargeted(input, dependencies);
    assert.equal(output.questions.length, 0);
    assert.equal(completeRetry(input.state, index + 1, 0, 1, output.failures).status, index === 2 ? "failed" : "queued");
  }
  const slot = input.state.budget!.slots.slot;
  assert.equal(slot.generations, 3);
  assert.equal(slot.repairs, 6);
  assert.equal(slot.rejectedCandidates?.length, 3);
  assert.ok(slot.rejectedCandidates?.every((item) => item.repairs?.length === 2));
});

test("完整核验通过但保存层重复冲突时重新设计，不反复核验同一候选", async () => {
  const input = fixture();
  const output = await generateTargeted(input, deps());
  assert.equal(output.questions.length, 1);
  const retry = completeRetry(input.state, 1, 0, 1, [{ code: "duplicate", message: "本任务其他点已保存同题" }]);
  assert.equal(retry.status, "queued");
  const slot = input.state.budget!.slots.slot;
  assert.equal(slot.pendingResponse, undefined);
  assert.equal(slot.skill?.design, undefined);
  assert.match(slot.rejectedCandidates![0].response, /weightedRubric/);
  await generateTargeted(input, deps());
  assert.equal(slot.skill?.designAttempts, 2);
  assert.equal(slot.generations, 2);
});

test("技能缺少专项标准或原文时不调用模型，不借用理论标准", async () => {
  const input = { ...fixture(), snapshot: { ...snapshot, skillQualityStandard: "" } };
  const result = await generateTargeted(input, deps(async () => { throw new Error("不能调用"); }));
  assert.equal(result.questions.length, 0);
  assert.match(result.failures[0].message, /缺少完整操作技能/);
  assert.equal(input.state.budget!.calls, 0);
});
