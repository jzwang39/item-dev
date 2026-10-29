import assert from "node:assert/strict";
import test from "node:test";
import { activityState } from "./activity";

const queued = { queued: 10, running: 0, ready: 10, expired: 0 };
test("没有被领取的任务显示排队，不误称正在请求模型", () => {
  assert.equal(activityState(queued, false, false), "queued");
});
test("真实执行、租约过期和全局限流分开显示", () => {
  assert.equal(activityState({ ...queued, running: 2 }, false, false), "running");
  assert.equal(activityState({ ...queued, running: 2, expired: 2 }, false, false), "recovering");
  assert.equal(activityState(queued, true, false), "rate_limited");
});
test("未来时间、禁用工作器和完成状态分开显示", () => {
  assert.equal(activityState({ ...queued, ready: 0 }, false, false), "retry_wait");
  assert.equal(activityState(queued, false, true), "disabled");
  assert.equal(activityState({ queued: 0, running: 0, ready: 0, expired: 0 }, false, true), "idle");
});
