import assert from "node:assert/strict";
import test from "node:test";
import { createUlid } from "@/shared/database/ulid";
import { assemblyPaperNumber } from "./paper-number";

test("同一计划多次执行的试卷编号不重复", () => {
  const firstRun = createUlid();
  const secondRun = createUlid();
  const numbers = [firstRun, secondRun].flatMap((run) =>
    Array.from({ length: 10 }, (_, index) => assemblyPaperNumber(run, index + 1)),
  );
  assert.equal(new Set(numbers).size, 20);
  assert.ok(numbers.every((number) => number.length <= 64));
});

test("使用完整批次标识，不因后六位相同发生冲突", () => {
  const firstRun = "0".repeat(20) + "123456";
  const secondRun = "1".repeat(20) + "123456";
  assert.notEqual(assemblyPaperNumber(firstRun, 1), assemblyPaperNumber(secondRun, 1));
});

test("同批次不同套数具有不同编号且可追溯执行批次", () => {
  const run = createUlid();
  assert.equal(assemblyPaperNumber(run, 1), `P-${run}-1`);
  assert.notEqual(assemblyPaperNumber(run, 1), assemblyPaperNumber(run, 2));
});

test("拒绝无效批次和套数序号", () => {
  assert.throws(() => assemblyPaperNumber("invalid", 1));
  for (const index of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => assemblyPaperNumber(createUlid(), index));
  }
});
