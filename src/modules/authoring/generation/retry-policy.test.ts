import assert from "node:assert/strict";
import test from "node:test";
import {
  anglePlanningPrompt, angleSources, completeRetry, failureOf, GenerationFailure, keepSelectedAngle,
  parseAnglePlan, prepareManualRetry, recordQualityRelaxation, retryBlocked, retryDelay, retryQuestionFeedback, retryState, validationFailure,
} from "./retry-policy";

test("失败原因区分重复、题型、选项、答案、评分、JSON及网络错误", () => {
  for (const [message, code] of [
    ["题干重复", "duplicate"], ["questionType: Invalid enum value", "invalid_type"],
    ["选项数量或选项唯一性不符", "invalid_options"], ["答案键不存在", "invalid_answer"],
    ["scoreRubric.criteria: invalid", "invalid_rubric"],
  ]) assert.equal(validationFailure(message).code, code);
  assert.equal(failureOf(new GenerationFailure("invalid_json", "JSON损坏")).code, "invalid_json");
  const timeout = new Error("timed out"); timeout.name = "TimeoutError";
  assert.equal(failureOf(timeout).code, "network_timeout");
  assert.equal(failureOf(new TypeError("fetch failed")).code, "network_error");
});

test("连续两次零产出熔断，有新增题重置连续计数但不重置累计精准次数", () => {
  const failures = [{ code: "duplicate" as const, message: "重复" }];
  const first = completeRetry(retryState(null), 1, 0, 2, failures);
  assert.equal(first.status, "queued");
  assert.equal(first.state.targeted, true);
  const second = completeRetry(first.state, 2, 0, 2, failures);
  assert.equal(second.status, "failed");
  assert.match(second.state.stopReason!, /连续两次/);
  const saved = completeRetry({ ...first.state, targetedAttempts: 3 }, 4, 1, 1, []);
  assert.equal(saved.status, "queued");
  assert.equal(saved.state.zeroOutputs, 0);
  assert.equal(saved.state.targetedAttempts, 3);
});

test("手动重试不清累计次数，旧六次失败有精准重试机会，达到上限后拒绝", () => {
  const legacy = prepareManualRetry(retryState(null), 6, "返回重复或无效试题");
  assert.equal(legacy.targeted, true);
  assert.equal(legacy.failures[0].code, "duplicate");
  const state = prepareManualRetry({ ...legacy, zeroOutputs: 2, targetedAttempts: 2 }, 8, null);
  assert.equal(state.targetedAttempts, 2);
  assert.equal(state.zeroOutputs, 0);
  assert.throws(() => prepareManualRetry(state, 12, null), /累计12/);
  assert.throws(() => prepareManualRetry({ ...state, targetedAttempts: 6 }, 10, null), /累计6/);
  assert.equal(completeRetry({ ...state, targetedAttempts: 6 }, 10, 1, 1, []).status, "failed");
  assert.equal(completeRetry({ ...state, targetedAttempts: 6 }, 12, 1, 0, []).status, "succeeded");
});

test("依据不足、配置或数据写入错误不原样重试，临时网络错误退避有上限", () => {
  for (const code of ["insufficient_basis", "connection_changed", "save_error", "model_error"] as const) {
    const result = completeRetry(retryState(null), 1, 0, 1, [{ code, message: "需处理" }]);
    assert.equal(result.status, "failed");
    assert.ok(retryBlocked(result.state, 1));
  }
  const failures = [{ code: "network_error" as const, message: "503" }];
  assert.equal(retryDelay(1, failures), 15);
  assert.equal(retryDelay(2, failures), 30);
  assert.equal(retryDelay(12, failures), 300);
  assert.equal(completeRetry(retryState(null), 1, 0, 1, failures).state.targeted, false);
  const configFailure = { ...retryState(null), failures: [{ code: "connection_changed" as const, message: "连接变更" }] };
  const resumed = prepareManualRetry(configFailure, 2, null);
  assert.equal(retryBlocked(resumed, 2), undefined, "Manual retry may recheck a repaired configuration.");
  assert.equal(completeRetry(resumed, 3, 0, 1, configFailure.failures).status, "failed", "Still-broken configuration cannot loop.");
});

const sources = [{ id: "textbook-1", content: "捐赠凭证应按业务类型分类保存。归档时核对捐赠金额、用途与签章。" }];
const plan = {
  covered: [{ index: 0, angle: "凭证分类规则" }],
  remaining: [{ angle: "归档核对要素", sourceId: "textbook-1", quote: "归档时核对捐赠金额、用途与签章" }],
};
test("知识角度分析必须覆盖已有题并引用可核验原文，不能只用层级名称凑依据", () => {
  assert.equal(parseAnglePlan(JSON.stringify(plan), 1, sources, []).selected.angle, "归档核对要素");
  assert.throws(() => parseAnglePlan(JSON.stringify({ ...plan, covered: [] }), 1, sources, []), /未完整覆盖/);
  assert.throws(() => parseAnglePlan(JSON.stringify({ ...plan, remaining: [{ ...plan.remaining[0], quote: "虚构法规要求保存三十年" }] }), 1, sources, []), /引用无法/);
  assert.throws(() => parseAnglePlan(JSON.stringify({ ...plan, remaining: [] }), 1, sources, []), /未找到/);
  assert.throws(() => parseAnglePlan("broken", 1, sources, []), /格式无效/);
  assert.deepEqual(angleSources({ point: { name: "归档", id: "fake", weight: 30 } }, []), []);
  assert.equal(angleSources({ source: { standardRequirement: { evidence: "正式标准要求核对资料" } } }, sources)[1].content, "正式标准要求核对资料");
});

test("已有或已尝试角度不重复使用，格式错误保留有效角度但内容重复换角度", () => {
  assert.throws(() => parseAnglePlan(JSON.stringify(plan), 1, sources, plan.remaining), /候选角度重复/);
  assert.throws(() => parseAnglePlan(JSON.stringify({ ...plan, remaining: [{ ...plan.remaining[0], angle: "凭证分类规则" }] }), 1, sources, []), /候选角度重复/);
  const state = { ...retryState(null), selectedAngle: plan.remaining[0], failures: [{ code: "invalid_answer" as const, message: "答案键错误" }] };
  assert.equal(keepSelectedAngle(state), true);
  assert.equal(keepSelectedAngle({ ...state, failures: [{ code: "duplicate", message: "重复" }] }), false);
  assert.equal(completeRetry(state, 2, 1, 1, []).state.selectedAngle, undefined);
});

test("补题分析传入题干、选项、答案、解析和错误反馈，而非只排除相同题干", () => {
  const prompt = anglePlanningPrompt("A", "凭证归档", "judgement", [{
    stem: "题干", content: { options: [] }, answer: { answers: ["正确"] }, analysis: "依据分类规则",
  }], sources, { ...retryState(null), failures: [{ code: "invalid_answer", message: "判断答案格式错误" }] }, { 等级: "level_4" });
  const data = JSON.parse(prompt.prompt);
  assert.equal(data.指定缺额题型, "judgement");
  assert.equal(data.已有试题[0].index, 0);
  assert.equal(data.已有试题[0].analysis, "依据分类规则");
  assert.equal(data.上次失败[0].code, "invalid_answer");
  assert.match(prompt.instruction, /不得跨考评点/);
});

const variant = {
  angle: "凭证分类规则", sourceId: "textbook-1", quote: "捐赠凭证应按业务类型分类保存",
  task: "根据给定业务类型辨析错误归档方法，与已有概念识别题不同",
  reusesKnowledge: true, reason: "核心知识已覆盖，通过错误诊断补足判断题缺额",
};

test("理论同知识不同任务可补缺额，引用和放宽原因缺失仍拦截", () => {
  const content = JSON.stringify({ covered: plan.covered, remaining: [variant] });
  const result = parseAnglePlan(content, 1, sources, [], "judgement");
  assert.equal(result.selected.reusesKnowledge, true);
  assert.equal(result.selected.questionType, "judgement");
  assert.equal(result.selected.task, variant.task);
  assert.throws(() => parseAnglePlan(content, 1, sources, []), /候选角度重复/);
  for (const extra of [{ task: undefined }, { reason: undefined }, { quote: "虚构法规原文不得用于命题" }]) {
    assert.throws(() => parseAnglePlan(JSON.stringify({ remaining: [{ ...variant, ...extra }] }), 1, sources, [], "judgement"));
  }
  assert.throws(() => parseAnglePlan('{"remaining":[]}', 1, sources, [], "judgement"), /可用考查任务/);
});

test("理论覆盖清单仅辅助，不让漏列索引阻塞有效补题，技能仍严格校验", () => {
  const result = parseAnglePlan(JSON.stringify({ remaining: [variant] }), 4, sources, [], "judgement");
  assert.equal(result.selected.task, variant.task);
  assert.throws(() => parseAnglePlan(JSON.stringify({ remaining: [variant] }), 4, sources, []), /未完整覆盖/);
});

test("理论优先新知识，跨题型可复用知识但同题型不能重复尝试相同任务", () => {
  const result = parseAnglePlan(JSON.stringify({ ...plan, remaining: [variant, plan.remaining[0]] }), 1, sources, [], "single");
  assert.equal(result.selected.angle, "归档核对要素");
  const content = JSON.stringify({ ...plan, remaining: [variant] });
  const attempted = [{ ...variant, questionType: "single" as const }];
  assert.throws(() => parseAnglePlan(content, 1, sources, attempted, "single"), /候选角度重复/);
  assert.equal(parseAnglePlan(content, 1, sources, attempted, "judgement").selected.reusesKnowledge, true);
});

test("理论和技能补题分析严格隔离标准，技能不启用理论放宽", () => {
  for (const kind of ["theory", "skill"] as const) {
    const prompt = anglePlanningPrompt("A", "凭证归档", kind === "skill" ? "practical" : "single",
      [], sources, retryState(null), {}, { kind, content: `${kind}专用数据库标准`, requirements: ["准确"] });
    const data = JSON.parse(prompt.prompt);
    const key = kind === "skill" ? "操作技能试题质量标准" : "试题质量标准";
    assert.equal(data[key], `${kind}专用数据库标准`);
    assert.equal(Object.hasOwn(data, kind === "skill" ? "试题质量标准" : "操作技能试题质量标准"), false);
    assert.match(prompt.instruction, kind === "skill" ? /不得套用理论同知识变式放宽/ : /同一知识、不同考查任务/);
    assert.match(data.质量执行策略.不可放宽底线, /答案正确/);
  }
});

test("同知识变式留痕包含原因、任务和题型，成功清除当前角度但保留历史", () => {
  const state = retryState(null);
  state.selectedAngle = variant;
  recordQualityRelaxation(state, variant, "judgement");
  assert.equal(state.qualityRelaxations?.length, 1);
  assert.equal(state.qualityRelaxations?.[0].task, variant.task);
  assert.equal(state.qualityRelaxations?.[0].questionType, "judgement");
  assert.match(retryQuestionFeedback(state, variant, "judgement").要求, /仅放宽知识角度独立性/);
  const completed = completeRetry(state, 2, 1, 0, []);
  assert.equal(completed.state.selectedAngle, undefined);
  assert.equal(completed.state.qualityRelaxations?.length, 1);
  recordQualityRelaxation(state, variant, "practical");
  assert.equal(state.qualityRelaxations?.length, 1);
});
