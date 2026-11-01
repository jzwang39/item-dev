import assert from "node:assert/strict";
import test from "node:test";
import { ensureTargetedBudget, recoverPrematureBlocks, markTargetedSaved, nextTargetedSlot, targetedBudgetBlocked } from "./targeted-budget";
import { completeRetry, prepareManualRetry, retryBlocked, retryState } from "./retry-policy";

const missing = Array.from({ length: 5 }, (_, index) => ({ id: `slot-${index}`, ordinal: index + 1, question_type: "judgement" as const }));

test("旧12次/6次记录完整保留，新策略按五个实际缺额独立计数，不被旧共享上限锁死", () => {
  const state = { ...retryState(null), targeted: true, targetedAttempts: 6, failures: [{ code: "insufficient_basis" as const, message: "旧片段没有任务" }] };
  const budget = ensureTargetedBudget(state, missing, 12);
  assert.equal(budget.origin.attempts, 12);
  assert.equal(budget.origin.targetedAttempts, 6);
  assert.equal(budget.origin.failures[0].message, "旧片段没有任务");
  assert.equal(prepareManualRetry(state, 12, null).targetedAttempts, 6);
  assert.equal(retryBlocked(state, 12, true), undefined);
  budget.slots["slot-0"].generations = 3;
  budget.slots["slot-0"].blocked = { code: "quality_rejected", message: "需人工命题" };
  assert.equal(nextTargetedSlot(state)?.[0], "slot-1");
  assert.equal(budget.slots["slot-1"].generations, 0);
});

test("原文翻页零保存不触发旧两次熔断，网络与内容计数分开", () => {
  let state = retryState(null);
  ensureTargetedBudget(state, missing, 2);
  state.budget!.activeSlotId = "slot-0";
  for (let index = 0; index < 4; index++) {
    const result = completeRetry(state, 12 + index, 0, 5, [{ code: "search_pending", message: "继续查阅关联原文" }]);
    assert.equal(result.status, "queued");
    state = result.state;
  }
  assert.equal(state.budget!.slots["slot-0"].generations, 0);
  assert.equal(state.budget!.slots["slot-0"].repairs, 0);
});

test("保存指定槽位后推进下一题，总预算和全部人工缺额不能反复手动清零", () => {
  const state = retryState(null);
  const budget = ensureTargetedBudget(state, missing.slice(0, 2), 0);
  budget.activeSlotId = "slot-0";
  markTargetedSaved(state, "slot-0");
  assert.equal(nextTargetedSlot(state)?.[0], "slot-1");
  budget.slots["slot-1"].blocked = { code: "insufficient_basis", message: "原文已全部查阅" };
  assert.match(targetedBudgetBlocked(state)!, /人工命题/);
  assert.throws(() => prepareManualRetry(state, 15, null), /人工命题/);
  const another = retryState(null);
  ensureTargetedBudget(another, missing, 15).calls = another.budget!.maxCalls;
  assert.throws(() => prepareManualRetry(another, 20, null), /模型调用预算/);
});

test("停止或租约回收不重置预算，重复初始化也不重置已用额度", () => {
  const state = retryState(null);
  const budget = ensureTargetedBudget(state, missing, 12);
  budget.calls = 8;
  budget.slots["slot-0"].generations = 2;
  ensureTargetedBudget(state, missing, 13);
  assert.equal(budget.calls, 8);
  assert.equal(budget.slots["slot-0"].generations, 2);
  budget.activeSlotId = "slot-0";
  const recovered = completeRetry(state, 14, 0, 5, [{ code: "lease_expired", message: "租约回收" }]);
  assert.equal(recovered.state.budget!.slots["slot-0"].transportFailures, 1);
  assert.equal(recovered.state.budget!.slots["slot-0"].generations, 2);
});

test("模型调用前读取配置等失败也有独立上限，不会因调用数为0无限重试", () => {
  let state = retryState(null);
  ensureTargetedBudget(state, missing.slice(0, 1), 12);
  for (let index = 0; index < 3; index++) {
    const result = completeRetry(state, 13 + index, 0, 1, [{ code: "network_error", message: "配置读取失败" }], true);
    assert.equal(result.status, index === 2 ? "failed" : "queued");
    state = result.state;
  }
  assert.equal(state.budget!.calls, 0);
  assert.equal(state.budget!.slots["slot-0"].generations, 0);
  assert.equal(state.budget!.slots["slot-0"].transportFailures, 3);
  assert.ok(retryBlocked(state, 1000, true));
});

test("旧分析早关和核验格式早关一次性恢复，所有计数和原候选保留", () => {
  const state = retryState(null);
  const budget = ensureTargetedBudget(state, missing.slice(0, 2), 12);
  delete budget.workflowVersion;
  budget.sourceCount = 2;
  budget.calls = 5;
  const trial = budget.slots["slot-0"];
  trial.searchedSourceIds = ["a", "b"];
  trial.blocked = { code: "insufficient_basis", message: "已查阅全部2段，未找到任务" };
  const review = budget.slots["slot-1"];
  review.generations = 1;
  review.reviewFailures = 2;
  review.repairs = 1;
  review.pendingResponse = '{"questions":[]}';
  review.blocked = { code: "review_invalid", message: "核验重复索引" };
  assert.equal(recoverPrematureBlocks(state), true);
  assert.equal(trial.trialDesign, true);
  assert.equal(review.reviewMode, "single");
  assert.equal(budget.calls, 5);
  assert.equal(budget.origin.attempts, 12);
  assert.equal(review.generations, 1);
  assert.equal(review.repairs, 1);
  assert.equal(review.reviewFailures, 2);
  assert.equal(review.pendingResponse, '{"questions":[]}');
  assert.equal(trial.recoveredBlock?.code, "insufficient_basis");
  assert.equal(budget.history.length, 2);
  assert.equal(retryBlocked(state, 14, true), undefined);
  review.blocked = { code: "review_invalid", message: "新流程仍失败" };
  assert.equal(recoverPrematureBlocks(state), false);
  assert.ok(review.blocked);
});

test("无来源、内容轮次耗尽、总预算耗尽和其他硬失败不恢复", () => {
  const state = retryState(null);
  const budget = ensureTargetedBudget(state, missing, 0);
  delete budget.workflowVersion;
  budget.sourceCount = 0;
  budget.slots["slot-0"].blocked = { code: "insufficient_basis", message: "无原文" };
  budget.slots["slot-1"].blocked = { code: "quality_rejected", message: "未满足标准" };
  assert.equal(recoverPrematureBlocks(state), false);
  budget.sourceCount = 2;
  budget.slots["slot-0"].searchedSourceIds = ["a", "b"];
  budget.slots["slot-0"].generations = 3;
  assert.equal(recoverPrematureBlocks(state), false);
  budget.slots["slot-0"].generations = 0;
  budget.calls = budget.maxCalls;
  assert.equal(recoverPrematureBlocks(state), false);
});
