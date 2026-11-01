import assert from "node:assert/strict";
import test from "node:test";
import { generateTargeted, type TargetedDependencies } from "./targeted-generation";
import { completeRetry, GenerationFailure, retryState } from "./retry-policy";
import { ensureTargetedBudget, markTargetedSaved } from "./targeted-budget";
import type { GeneratedQuestion, Snapshot } from "./contracts";

const snapshot: Snapshot = {
  projectId: "p", requirement: "每点4单选2判断", qualityStandard: "答案正确，依据可核验，不得重复考查任务。",
  qualityRequirements: ["准确"], sourceVersionIds: ["frozen"], points: [],
  scope: { occupationId: "o", occupation: "职业", levelCode: "level_4", assessmentMode: "理论知识",
    blueprintVersions: { outline: { id: "outline", versionNo: 1 }, weights: { id: "weights", versionNo: 1 } } },
  nodes: [{ id: "node", code: "A", name: "归档", chapterIds: ["frozen-chapter"] }],
  model: { provider: "test", baseUrl: "https://example.com", model: "test" },
};
const source = { id: "frozen-reference", content: "借阅资料须登记，归还须核对完整性。", systemQuote: true };
const question: GeneratedQuestion = { assessmentPointCode: "A", questionType: "judgement",
  stem: "借阅资料需要完成登记手续。", options: [], answers: ["正确"], analysis: "原文明确要求借阅登记。" };
function fixture(type: "single" | "judgement" = "judgement", count = 1) {
  const state = { ...retryState(null), targeted: true, targetedAttempts: 6 };
  ensureTargetedBudget(state, Array.from({ length: count }, (_, index) => ({ id: `slot-${index}`, ordinal: index + 1, question_type: type })), 12);
  return { snapshot, code: "A", previous: [], sources: [source], state };
}
function plan(sourceId = source.id) {
  return JSON.stringify({ remaining: [{ angle: "借阅登记", sourceId, task: "辨析资料借阅是否需要登记", reusesKnowledge: false, reason: "原文明确支持任务" }] });
}
function review(input: Parameters<TargetedDependencies["call"]>[0], passed = true) {
  const data = JSON.parse(input.prompt);
  return JSON.stringify({ checks: data.候选.map((candidate: { index: number }) => ({
    index: candidate.index, meetsQualityStandard: passed, answerCorrect: passed, evidenceSupported: true, distinctTask: true,
    score: 90, explanation: passed ? "原文要求借阅登记，答案和任务符合全部标准。" : "答案不能成立，不能计入成果。",
    evidenceSourceIds: [source.id], requirements: [{ requirement: "答案正确", passed, explanation: "核对原文" }],
  })) });
}
function dependencies(call: TargetedDependencies["call"], signal = new AbortController().signal) {
  return { call, persist: async () => {}, signal };
}

test("前两页无任务继续查原文，第三页找到任务后生成并核验，不因零保存提前停止", async () => {
  const input = fixture();
  input.sources = Array.from({ length: 18 }, (_, index) => ({ ...source, id: index === 12 ? source.id : `source-${index}` }));
  let analysisCount = 0;
  const deps = dependencies(async (prompt) => {
    if (prompt.instruction.includes("补题分析助手")) {
      analysisCount++;
      return analysisCount < 3 ? '{"remaining":[],"reason":"本页无可用任务"}' : plan();
    }
    if (prompt.instruction.includes("独立核验助手")) return review(prompt);
    return JSON.stringify({ questions: [question] });
  });
  const first = await generateTargeted(input, deps);
  assert.equal(first.failures.at(-1)?.code, "search_pending");
  assert.equal(input.state.budget!.slots["slot-0"].searchedSourceIds.length, 12);
  assert.equal(input.state.budget!.slots["slot-0"].generations, 0);
  assert.equal(completeRetry(input.state, 13, 0, 1, first.failures).status, "queued");
  const second = await generateTargeted(input, deps);
  assert.equal(second.questions.length, 1);
  assert.equal(second.questions[0].targetSlotId, "slot-0");
  assert.equal(second.state.selectedAngle?.quote, source.content);
  assert.equal(analysisCount, 3);
});

test("答案键错误携带原候选修复并重新核验，不重新消耗候选生成额度", async () => {
  const input = fixture("single");
  const single = { ...question, questionType: "single", options: [
    { key: "A", content: "无需登记" }, { key: "B", content: "登记借阅" }, { key: "C", content: "直接丢弃" }, { key: "D", content: "禁止归还" },
  ], answers: ["Z"] };
  const result = await generateTargeted(input, dependencies(async (prompt) => {
    if (prompt.instruction.includes("补题分析助手")) return plan();
    if (prompt.instruction.includes("修订助手")) {
      const data = JSON.parse(prompt.prompt);
      assert.match(data.原始候选响应, /"Z"/);
      assert.match(data.具体错误.join(""), /答案/);
      assert.equal(data.试题质量标准, snapshot.qualityStandard);
      return JSON.stringify({ questions: [{ ...single, answers: ["B"] }] });
    }
    if (prompt.instruction.includes("独立核验助手")) return review(prompt);
    return JSON.stringify({ questions: [single] });
  }));
  assert.deepEqual(result.questions[0].answers, ["B"]);
  assert.equal(result.questions[0].candidateRepairs?.length, 1);
  assert.equal(input.state.budget!.slots["slot-0"].generations, 1);
  assert.equal(input.state.budget!.slots["slot-0"].repairs, 1);
  assert.equal(input.state.budget!.calls, 4);
});

test("失败尝试不当作已覆盖，完整质量核验不通过始终不保存，其他槽位有独立额度", async () => {
  const input = fixture("judgement", 2);
  input.state.attemptedAngles = [{ angle: "借阅登记", sourceId: source.id, quote: source.content, task: "辨析资料借阅是否需要登记", questionType: "judgement" }];
  const deps = dependencies(async (prompt) => prompt.instruction.includes("补题分析助手") ? plan()
    : prompt.instruction.includes("独立核验助手") ? review(prompt, false) : JSON.stringify({ questions: [question] }));
  for (let index = 0; index < 3; index++) {
    const output = await generateTargeted(input, deps);
    assert.equal(output.questions.length, 0);
    assert.equal(output.failures[0].code, "quality_rejected");
    completeRetry(input.state, 13 + index, 0, 2, output.failures);
  }
  assert.equal(input.state.budget!.slots["slot-0"].generations, 3);
  assert.ok(input.state.budget!.slots["slot-0"].blocked);
  assert.equal(input.state.budget!.slots["slot-0"].rejectedCandidates?.length, 3);
  assert.match(input.state.budget!.slots["slot-0"].rejectedCandidates![0].response, /借阅资料/);
  assert.equal(input.state.budget!.slots["slot-0"].rejectedCandidates![0].failures[0].code, "quality_rejected");
  assert.equal(input.state.budget!.slots["slot-1"].generations, 0);
});

test("缺五题可逐槽填齐，旧累计6次不会天然截断五个槽位的修复机会", async () => {
  const input = fixture("judgement", 5);
  const tasks = ["借阅登记", "登记核对", "归还清点", "完整性核验", "分类保存"];
  const stems = ["借阅资料需要完成登记手续。", "借阅登记需要核对资料信息。", "归还资料需要清点资料数量。",
    "归还资料需要核对内容完整性。", "归档资料需要按类别进行保存。"];
  input.sources = [{ ...source, content: stems.join("") }];
  let sequence = 0;
  const deps = dependencies(async (prompt) => {
    if (prompt.instruction.includes("补题分析助手")) return JSON.stringify({ remaining: [{
      angle: tasks[sequence], task: `依据原文判断${tasks[sequence]}要求`, sourceId: source.id,
    }] });
    if (prompt.instruction.includes("独立核验助手")) return review(prompt);
    return JSON.stringify({ questions: [{ ...question, stem: stems[sequence++] }] });
  });
  for (let index = 0; index < 5; index++) {
    const output = await generateTargeted(input, deps);
    assert.equal(output.questions[0].targetSlotId, `slot-${index}`);
    markTargetedSaved(input.state, `slot-${index}`);
    const result = completeRetry(input.state, 13 + index, 1, 4 - index, []);
    assert.equal(result.status, index === 4 ? "succeeded" : "queued");
  }
  assert.equal(input.state.budget!.calls, 15);
  assert.equal(input.state.targetedAttempts, 6);
  assert.equal(input.state.budget!.origin.attempts, 12);
});

test("引用编号错误单独修复，同一页重新分析后取回系统原文", async () => {
  const input = fixture();
  let analyses = 0;
  const output = await generateTargeted(input, dependencies(async (prompt) => {
    if (prompt.instruction.includes("补题分析助手")) return ++analyses === 1 ? plan("未知编号") : plan();
    if (prompt.instruction.includes("独立核验助手")) return review(prompt);
    return JSON.stringify({ questions: [question] });
  }));
  assert.equal(output.questions.length, 1);
  assert.equal(input.state.budget!.slots["slot-0"].analysisFailures, 1);
  assert.equal(input.state.budget!.slots["slot-0"].generations, 1);
});

test("核验格式失败保留候选，下一轮只重新核验，绝不默认通过", async () => {
  const input = fixture();
  let reviews = 0;
  const deps = dependencies(async (prompt) => prompt.instruction.includes("补题分析助手") ? plan()
    : prompt.instruction.includes("独立核验助手") ? ++reviews === 1 ? "broken" : review(prompt)
      : JSON.stringify({ questions: [question] }));
  assert.equal((await generateTargeted(input, deps)).questions.length, 0);
  assert.equal((await generateTargeted(input, deps)).questions.length, 1);
  assert.equal(input.state.budget!.slots["slot-0"].generations, 1);
  assert.equal(input.state.budget!.calls, 4);
});

test("网络失败不占内容或修复额度，调用总预算仍计数且有停止上限", async () => {
  const input = fixture();
  for (let index = 0; index < 3; index++) {
    await generateTargeted(input, dependencies(async () => { throw new GenerationFailure("network_error", "503"); }));
  }
  const slot = input.state.budget!.slots["slot-0"];
  assert.equal(slot.generations, 0);
  assert.equal(slot.repairs, 0);
  assert.equal(slot.transportFailures, 3);
  assert.ok(slot.blocked);
  assert.equal(input.state.budget!.calls, 3);
});

test("生成时停止拦截迟到响应，不调用后续修复或核验", async () => {
  const input = fixture();
  const controller = new AbortController();
  let calls = 0;
  const output = await generateTargeted(input, dependencies(async () => {
    if (++calls === 1) return plan();
    controller.abort(new Error("用户停止生成"));
    return JSON.stringify({ questions: [question] });
  }, controller.signal));
  assert.equal(output.questions.length, 0);
  assert.equal(calls, 2);
});

test("预算耗尽但原文未查完，不误报全部依据不足", async () => {
  const input = fixture();
  input.sources = Array.from({ length: 18 }, (_, index) => ({ ...source, id: `source-${index}` }));
  input.state.budget!.maxCalls = 2;
  const output = await generateTargeted(input, dependencies(async () => '{"remaining":[]}'));
  assert.equal(output.failures[0].code, "search_pending");
  assert.equal(input.state.budget!.slots["slot-0"].searchedSourceIds.length, 12);
  assert.match(completeRetry(input.state, 13, 0, 1, output.failures).state.stopReason!, /调用预算/);
  assert.equal(input.state.budget!.slots["slot-0"].blocked, undefined);
});

test("技能候选生成和独立核验只接收完整技能标准，不混入旧理论标准", async () => {
  const input = fixture();
  input.state.budget!.slots["slot-0"].type = "practical";
  input.snapshot = {
    ...snapshot, scope: { ...snapshot.scope, assessmentMode: "操作技能" },
    qualityStandard: "理论污染不得传入", skillQualityStandard: "按完整技能标准核对任务、成果、步骤及评分。",
    skillStructure: { totalScore: 100 },
    nodes: [{ ...snapshot.nodes[0], skillContext: { source: { evidence: source.content } } }],
  };
  const practical = { ...question, questionType: "practical",
    stem: "根据提供的模拟归档资料，完成借阅信息登记、归还完整性核对，并提交登记表及核对记录。",
    answers: ["登记借阅信息，逐项核对资料完整性并提交记录。"],
    scoreRubric: { totalScore: 100, criteria: [{ item: "登记和核对", score: 100, standard: "信息完整、核对记录准确。" }] } };
  const output = await generateTargeted(input, dependencies(async (prompt) => {
    assert.doesNotMatch(prompt.prompt, /理论污染不得传入/);
    const data = JSON.parse(prompt.prompt);
    assert.equal(data.操作技能试题质量标准, input.snapshot.skillQualityStandard);
    if (prompt.instruction.includes("补题分析助手")) return plan();
    if (prompt.instruction.includes("独立核验助手")) return review(prompt);
    return JSON.stringify({ questions: [practical] });
  }));
  assert.equal(output.questions.length, 1);
  assert.equal(output.questions[0].questionType, "practical");
  assert.equal(output.state.qualityRelaxations, undefined);
});

test("空候选不当作格式错误反复修复，保留原始失败响应供人工处理", async () => {
  const input = fixture();
  const output = await generateTargeted(input, dependencies(async (prompt) => {
    if (prompt.instruction.includes("补题分析助手")) return plan();
    return '{"questions":[]}';
  }));
  assert.equal(output.questions.length, 0);
  assert.equal(input.state.budget!.calls, 2);
  assert.equal(input.state.budget!.slots["slot-0"].repairs, 0);
  assert.equal(input.state.budget!.slots["slot-0"].rejectedCandidates![0].response, '{"questions":[]}');
});

test("核验引用编号错误重新核验同一候选，不浪费一轮内容生成", async () => {
  const input = fixture();
  let checks = 0;
  const deps = dependencies(async (prompt) => {
    if (prompt.instruction.includes("补题分析助手")) return plan();
    if (prompt.instruction.includes("独立核验助手")) {
      const result = JSON.parse(review(prompt));
      if (++checks === 1) result.checks[0].evidenceSourceIds = ["未知编号"];
      return JSON.stringify(result);
    }
    return JSON.stringify({ questions: [question] });
  });
  assert.equal((await generateTargeted(input, deps)).questions.length, 0);
  assert.equal((await generateTargeted(input, deps)).questions.length, 1);
  assert.equal(input.state.budget!.slots["slot-0"].generations, 1);
  assert.equal(input.state.budget!.calls, 4);
});
