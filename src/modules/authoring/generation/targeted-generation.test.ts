import assert from "node:assert/strict";
import test from "node:test";
import { generateTargeted, type TargetedDependencies } from "./targeted-generation";
import { completeRetry, GenerationFailure, retryState } from "./retry-policy";
import { ensureTargetedBudget, recoverTheoryDuplicate, markTargetedSaved } from "./targeted-budget";
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
function skillDesign() {
  return JSON.stringify({ scenario: "根据模拟资料完成借阅登记和归还核对", materials: ["明确标注的模拟借阅登记资料"],
    requirements: ["登记借阅信息并核对资料完整性"], deliverables: ["提交登记表及完整性核对记录"],
    steps: ["核对模拟资料并逐项填写借阅登记信息"], observations: ["登记信息和核对记录完整准确"],
    sourceIds: ["S1"], difference: "考查借阅登记与完整性核对的实际操作任务" });
}
function skillDesignReview(passed = true) {
  return JSON.stringify({ evidenceSupported: passed, completeTask: passed, correctScope: true, distinctTask: true,
    meetsQualityStandard: passed, explanation: passed ? "原文支持完整任务和可观察成果。" : "原文缺少完整操作成果要求",
    sourceIds: ["S1"], requirements: [{ requirement: "完整操作任务", passed, explanation: "核对冻结原文" }] });
}
function dependencies(call: TargetedDependencies["call"], signal = new AbortController().signal) {
  return { call, persist: async () => {}, signal };
}

test("重复候选后累计查阅不清零，重新分析显式排除重复任务并携带原候选", async () => {
  const input = { ...fixture(), previous: [{ stem: question.stem }] };
  let analyses = 0, generations = 0;
  const deps = dependencies(async (prompt) => {
    const data = JSON.parse(prompt.prompt);
    if (prompt.instruction.includes("补题分析助手")) {
      if (++analyses === 1) return plan();
      assert.equal(data.被查重拒绝的候选及任务.length, 1);
      assert.match(data.被查重拒绝的候选及任务[0].response, /借阅资料/);
      // The planner repeats the same task: parser must reject it and try a
      // different evidence-based task, never weaken the duplicate rule.
      return plan();
    }
    if (prompt.instruction.includes("独立核验助手")) return review(prompt);
    if (++generations > 1) {
      assert.equal(data.被拒绝的候选及具体原因.length, 1);
      assert.match(data.禁止重复的考查任务[0].task, /借阅/);
      assert.ok(data.候选试制);
      return JSON.stringify({ questions: [{ ...question, stem: "归还资料时应核对资料的完整性。" }] });
    }
    return JSON.stringify({ questions: [question] });
  });
  const first = await generateTargeted(input, deps);
  assert.equal(first.failures[0].code, "duplicate");
  const slot = input.state.budget!.slots["slot-0"];
  assert.equal(slot.searchedSourceIds.length, 1);
  assert.equal(slot.analysisSearchedSourceIds?.length, 0);
  assert.equal((await generateTargeted(input, deps)).questions.length, 1);
  assert.equal(analyses, 2);
  assert.equal(slot.generations, 2);
  assert.equal(slot.searchedSourceIds.length, 1);
});

function theoryDuplicateFixture() {
  const input = fixture("single");
  const slot = input.state.budget!.slots["slot-0"];
  const duplicate = { code: "duplicate" as const, message: "候选题干与已有题重复" };
  input.state.budget!.calls = 5;
  input.state.budget!.sourceCount = 1;
  slot.generations = 3;
  slot.blocked = duplicate;
  slot.rejectedCandidates = [{ response: JSON.stringify({ questions: [question] }),
    failures: [duplicate], evidenceSources: [source], at: "old" }];
  input.state.failures = [duplicate];
  return input;
}

test("三轮重复旧槽位一次追加重设计，不清零5次调用与3轮历史，第四轮仍须完整核验", async () => {
  const input = theoryDuplicateFixture();
  const budget = input.state.budget!, slot = budget.slots["slot-0"];
  assert.equal(recoverTheoryDuplicate(input.state), true);
  assert.equal(budget.calls, 5);
  assert.equal(budget.maxCalls, 24);
  assert.equal(slot.generations, 3);
  assert.equal(slot.searchedSourceIds.length, 1);
  assert.equal(recoverTheoryDuplicate(input.state), false);
  const single = { ...question, questionType: "single", stem: "归还资料时应当执行哪项核对？",
    options: [{ key: "A", content: "核对完整性" }, { key: "B", content: "丢弃资料" },
      { key: "C", content: "跳过核对" }, { key: "D", content: "删除记录" }], answers: ["A"] };
  const result = await generateTargeted(input, dependencies(async (prompt) => {
    if (prompt.instruction.includes("补题分析助手")) return plan();
    if (prompt.instruction.includes("独立核验助手")) return review(prompt);
    return JSON.stringify({ questions: [single] });
  }));
  assert.equal(result.questions.length, 1);
  assert.ok(result.questions[0].standardReview);
  assert.equal(slot.generations, 4);
  assert.equal(budget.calls, 8);
  markTargetedSaved(input.state, "slot-0");
  assert.equal(completeRetry(input.state, 16, 1, 0, []).status, "succeeded");
});

test("一次重设计仍重复则关闭，不允许再次恢复或清零预算", async () => {
  const input = theoryDuplicateFixture();
  input.state.budget!.slots["slot-0"].type = "judgement";
  recoverTheoryDuplicate(input.state);
  const result = await generateTargeted({ ...input, previous: [{ stem: question.stem }] }, dependencies(async (prompt) =>
    prompt.instruction.includes("补题分析助手") ? plan() : JSON.stringify({ questions: [question] })));
  assert.equal(result.questions.length, 0);
  assert.equal(completeRetry(input.state, 16, 0, 1, result.failures).status, "failed");
  assert.equal(input.state.budget!.slots["slot-0"].generations, 4);
  assert.equal(recoverTheoryDuplicate(input.state), false);
});

test("无留存证据、调用耗尽、技能或真正质量失败均不恢复理论重复任务", () => {
  const exhausted = theoryDuplicateFixture();
  exhausted.state.budget!.calls = 24;
  assert.equal(recoverTheoryDuplicate(exhausted.state), false);
  const skill = theoryDuplicateFixture();
  skill.state.budget!.slots["slot-0"].type = "practical";
  assert.equal(recoverTheoryDuplicate(skill.state), false);
  const noRecord = theoryDuplicateFixture();
  noRecord.state.budget!.slots["slot-0"].rejectedCandidates = [];
  assert.equal(recoverTheoryDuplicate(noRecord.state), false);
  const quality = theoryDuplicateFixture();
  quality.state.budget!.slots["slot-0"].blocked = { code: "quality_rejected", message: "内容有错" };
  assert.equal(recoverTheoryDuplicate(quality.state), false);
});

test("理论候选完整核验后保存层发现任务内重复，保留原候选再设计", async () => {
  const input = fixture();
  const result = await generateTargeted(input, dependencies(async (prompt) => {
    if (prompt.instruction.includes("补题分析助手")) return plan();
    if (prompt.instruction.includes("独立核验助手")) return review(prompt);
    return JSON.stringify({ questions: [question] });
  }));
  assert.equal(result.questions.length, 1);
  const slot = input.state.budget!.slots["slot-0"];
  assert.ok(slot.pendingResponse);
  const retry = completeRetry(input.state, 13, 0, 1, [{ code: "duplicate", message: "任务内其他点已保存同题" }]);
  assert.equal(retry.status, "queued");
  assert.match(slot.rejectedCandidates![0].response, /借阅资料/);
  assert.equal(slot.angle, undefined);
  assert.equal(slot.pendingResponse, undefined);
  assert.equal(slot.searchedSourceIds.length, 1);
});

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
    if (prompt.instruction.includes("技能任务设计助手")) return skillDesign();
    if (prompt.instruction.includes("技能任务设计核验助手")) return skillDesignReview();
    if (prompt.instruction.includes("独立核验助手")) return review(prompt).replaceAll(source.id, "S1");
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

test("两段原文一次分析无任务仍试制候选，完整标准通过才能填槽", async () => {
  const input = fixture();
  input.sources = [source, { ...source, id: "second-reference" }];
  const output = await generateTargeted(input, dependencies(async (prompt) => {
    const data = JSON.parse(prompt.prompt);
    assert.equal(data.试题质量标准, snapshot.qualityStandard);
    if (prompt.instruction.includes("补题分析助手")) return '{"remaining":[],"reason":"未找到新知识"}';
    if (prompt.instruction.includes("独立核验助手")) return review(prompt);
    assert.equal(data.候选试制.原文支持和任务差异须另行核验, true);
    assert.equal(data.原文依据.length, 2);
    assert.match(prompt.instruction, /不得臆造条件/);
    return JSON.stringify({ questions: [question] });
  }));
  assert.equal(output.questions.length, 1);
  assert.equal(output.questions[0].targetSlotId, "slot-0");
  const slot = input.state.budget!.slots["slot-0"];
  assert.equal(slot.generations, 1);
  assert.equal(slot.blocked, undefined);
  assert.equal(slot.searchedSourceIds.length, 2);
  assert.equal(slot.angle, undefined);
  assert.equal(input.state.budget!.calls, 3);
  assert.equal(input.state.qualityRelaxations, undefined);
  assert.equal(slot.evidenceSources!.length, 2);
});

test("候选试制三轮使用不同路径，质量拒绝不保存也不无限尝试", async () => {
  const input = fixture();
  const paths: string[] = [];
  let analyses = 0;
  const deps = dependencies(async (prompt) => {
    if (prompt.instruction.includes("补题分析助手")) {
      analyses++;
      return '{"remaining":[],"reason":"未找到新任务"}';
    }
    if (prompt.instruction.includes("独立核验助手")) return review(prompt, false);
    paths.push(JSON.parse(prompt.prompt).候选试制.设计路径);
    return JSON.stringify({ questions: [question] });
  });
  for (let index = 0; index < 3; index++) {
    const output = await generateTargeted(input, deps);
    assert.equal(output.questions.length, 0);
    const result = completeRetry(input.state, 13 + index, 0, 1, output.failures);
    assert.equal(result.status, index === 2 ? "failed" : "queued");
  }
  assert.equal(analyses, 1);
  assert.equal(new Set(paths).size, 3);
  const slot = input.state.budget!.slots["slot-0"];
  assert.equal(slot.generations, 3);
  assert.equal(slot.rejectedCandidates?.length, 3);
  assert.equal(slot.rejectedCandidates![0].reviewResponses![0].mode, "batch");
  assert.match(slot.rejectedCandidates![0].reviewResponses![0].response, /答案不能成立/);
});

test("确实无原文时不试制，保持人工处理边界", async () => {
  const input = fixture();
  input.sources = [];
  const result = await generateTargeted(input, dependencies(async () => { throw new Error("不应调用模型"); }));
  assert.equal(result.questions.length, 0);
  assert.equal(result.failures[0].code, "insufficient_basis");
  assert.equal(input.state.budget!.calls, 0);
});

test("批量索引错误改为逐候选核验，单题仍用索引0且不重新生成", async () => {
  const input = fixture();
  const candidates = [question, { ...question, stem: "归还资料需要核对完整性。" }, { ...question, stem: "借阅时必须登记资料信息。" }];
  let generations = 0;
  let singles = 0;
  const deps = dependencies(async (prompt) => {
    if (prompt.instruction.includes("补题分析助手")) return plan();
    if (prompt.instruction.includes("独立核验助手")) {
      const data = JSON.parse(prompt.prompt);
      if (data.候选.length > 1) return review({ ...prompt, prompt: JSON.stringify({ ...data, 候选: data.候选.slice(0, 1) }) });
      singles++;
      assert.equal(data.候选[0].index, 0);
      return review(prompt, singles === 2);
    }
    generations++;
    return JSON.stringify({ questions: candidates });
  });
  const first = await generateTargeted(input, deps);
  assert.equal(first.failures[0].code, "review_invalid");
  const slot = input.state.budget!.slots["slot-0"];
  assert.equal(slot.reviewMode, "single");
  assert.ok(slot.pendingResponse);
  const second = await generateTargeted(input, deps);
  assert.equal(second.questions.length, 1);
  assert.equal(second.questions[0].stem, candidates[1].stem);
  assert.equal(generations, 1);
  assert.equal(singles, 3);
  assert.equal(slot.reviewResponses?.length, 4);
});

test("逐题核验仍格式异常时累计两次关闭并保留候选，绝不默认通过", async () => {
  const input = fixture();
  let generations = 0;
  const deps = dependencies(async (prompt) => {
    if (prompt.instruction.includes("补题分析助手")) return plan();
    if (prompt.instruction.includes("独立核验助手")) return '{"checks":[]}';
    generations++;
    return JSON.stringify({ questions: [question] });
  });
  for (let index = 0; index < 3; index++) {
    const output = await generateTargeted(input, deps);
    assert.equal(output.questions.length, 0);
  }
  const slot = input.state.budget!.slots["slot-0"];
  assert.equal(slot.reviewFailures, 1);
  assert.equal(slot.singleReviewFailures![0], 2);
  assert.equal(slot.blocked?.code, "review_invalid");
  assert.ok(slot.pendingResponse);
  assert.equal(generations, 1);
  assert.equal(slot.reviewResponses?.length, 3);
});

test("逐题核验时停止，迟到响应不缓存、不继续核验或保存", async () => {
  const input = fixture();
  const controller = new AbortController();
  let reviews = 0;
  const deps = dependencies(async (prompt) => {
    if (prompt.instruction.includes("补题分析助手")) return plan();
    if (prompt.instruction.includes("独立核验助手")) {
      if (++reviews === 1) return "broken";
      controller.abort(new Error("停止生成"));
      return review(prompt);
    }
    return JSON.stringify({ questions: [question] });
  }, controller.signal);
  await generateTargeted(input, deps);
  const output = await generateTargeted(input, deps);
  assert.equal(output.questions.length, 0);
  assert.equal(input.state.budget!.slots["slot-0"].singleReviews, undefined);
  assert.equal(input.state.budget!.slots["slot-0"].reviewResponses?.length, 1);
});

test("技能试制仍只使用专项标准和操作任务，不套用理论条件辨析", async () => {
  const input = fixture();
  input.state.budget!.slots["slot-0"].type = "practical";
  input.snapshot = { ...snapshot, scope: { ...snapshot.scope, assessmentMode: "操作技能" },
    qualityStandard: "理论污染不得传入", skillQualityStandard: "仅按原文操作要求设计完整任务。",
    skillStructure: { totalScore: 100 },
    nodes: [{ ...snapshot.nodes[0], skillContext: { source: { evidence: source.content } } }] };
  const output = await generateTargeted(input, dependencies(async (prompt) => {
    assert.doesNotMatch(prompt.prompt, /理论污染不得传入/);
    const data = JSON.parse(prompt.prompt);
    assert.equal(data.操作技能试题质量标准, input.snapshot.skillQualityStandard);
    if (prompt.instruction.includes("技能任务设计助手")) return skillDesign();
    assert.match(prompt.instruction, /技能任务设计核验助手/);
    assert.doesNotMatch(prompt.instruction, /条件辨析/);
    return skillDesignReview(false);
  }));
  assert.equal(output.questions.length, 0);
  assert.match(output.failures[0].message, /缺少完整操作成果要求/);
  assert.equal(input.state.budget!.reviewContext?.kind, "skill");
  assert.equal(input.state.qualityRelaxations, undefined);
});

test("逐题核验上下文改变后不复用旧标准下的结论", async () => {
  const input = fixture();
  const candidates = [question, { ...question, stem: "归还资料需要核对完整性。" }];
  let calls = 0;
  const deps = dependencies(async (prompt) => {
    if (prompt.instruction.includes("补题分析助手")) return plan();
    if (!prompt.instruction.includes("独立核验助手")) return JSON.stringify({ questions: candidates });
    const data = JSON.parse(prompt.prompt);
    if (data.候选.length > 1) return "broken";
    calls++;
    if (data.试题质量标准 === snapshot.qualityStandard) return calls === 1 ? review(prompt, false) : "broken";
    return review(prompt, data.候选[0].stem === question.stem);
  });
  await generateTargeted(input, deps);
  assert.equal((await generateTargeted(input, deps)).questions.length, 0);
  assert.equal(input.state.budget!.slots["slot-0"].singleReviews?.length, 1);
  input.snapshot = { ...snapshot, qualityStandard: `${snapshot.qualityStandard} 核对条件完整。` };
  const result = await generateTargeted(input, deps);
  assert.equal(result.questions.length, 1);
  assert.equal(result.questions[0].stem, question.stem);
  assert.equal(calls, 4);
  assert.equal(input.state.budget!.slots["slot-0"].generations, 1);
});

test("后续候选网络失败不丢弃已经完整核验通过的候选", async () => {
  const input = fixture();
  const candidates = [question, { ...question, stem: "归还资料需要核对完整性。" }];
  let singles = 0;
  const deps = dependencies(async (prompt) => {
    if (prompt.instruction.includes("补题分析助手")) return plan();
    if (!prompt.instruction.includes("独立核验助手")) return JSON.stringify({ questions: candidates });
    if (JSON.parse(prompt.prompt).候选.length > 1) return "broken";
    if (++singles === 1) return review(prompt);
    throw new GenerationFailure("network_error", "503");
  });
  await generateTargeted(input, deps);
  const result = await generateTargeted(input, deps);
  assert.equal(result.questions.length, 1);
  assert.equal(result.questions[0].stem, question.stem);
  assert.ok(result.questions[0].standardReview);
  assert.equal(input.state.budget!.slots["slot-0"].generations, 1);
});

for (const reason of ["stop", "lease"] as const) {
  test(`后续候选${reason === "stop" ? "停止" : "租约失效"}时此前通过的候选也不能继续保存`, async () => {
    const input = fixture();
    const controller = new AbortController();
    let singles = 0;
    const deps = dependencies(async (prompt) => {
      if (prompt.instruction.includes("补题分析助手")) return plan();
      if (!prompt.instruction.includes("独立核验助手")) return JSON.stringify({ questions: [question, { ...question, stem: "归还资料需要核对完整性。" }] });
      if (JSON.parse(prompt.prompt).候选.length > 1) return "broken";
      if (++singles === 1) return review(prompt);
      if (reason === "stop") controller.abort(new Error("用户停止"));
      else throw new GenerationFailure("lease_expired", "租约失效");
      return review(prompt);
    }, controller.signal);
    await generateTargeted(input, deps);
    assert.equal((await generateTargeted(input, deps)).questions.length, 0);
  });
}
