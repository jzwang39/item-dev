import assert from "node:assert/strict";
import test from "node:test";
import { selectCommonTask } from "./common-task-selection";

const groups = [
  { id: "recent", generation_status: "cancelled" },
  { id: "active", generation_status: "running" },
  { id: "queued", generation_status: "queued" },
];
test("直接进入页面优先打开进行中的任务，不要求手动选题组", () => {
  assert.equal(selectCommonTask(groups, null), "active");
  assert.equal(selectCommonTask([{ id: "queued", generation_status: "queued" }], null), "queued");
});
test("明确链接或手动选择保留，刷新不抢走当前查看的任务", () => {
  assert.equal(selectCommonTask(groups, "recent"), "recent");
  assert.equal(selectCommonTask(groups, "missing"), "active");
});
test("无运行任务选择最近题组，空列表不产生无效选择", () => {
  assert.equal(selectCommonTask([groups[0]], null), "recent");
  assert.equal(selectCommonTask([], null), "");
});
