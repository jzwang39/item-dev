import assert from "node:assert/strict";
import test from "node:test";

import { buildBatches, validateQuota } from "./contracts";
import { mergeQuota } from "./quota";

const defaultQuota = { single: 4, multiple: 0, judgement: 2, total: 6, hint: "默认每点6题" };

test("明确指定1单选1判断，200个考评点计划与实际批次数量均为400", () => {
  const quota = mergeQuota(defaultQuota, { single: 1, multiple: 0, judgement: 1 });
  assert.equal(quota.total, 2);
  assert.equal(quota.single, 1);
  assert.equal(quota.judgement, 1);
  assert.match(quota.hint, /不额外补齐默认题量/);
  const points = Array.from({ length: 200 }, (_, index) => ({
    code: `A-${index + 1}`, name: `知识范围${index + 1}`, ...quota,
  }));
  validateQuota(points, "level_4");
  assert.equal(points.reduce((sum, point) => sum + point.total, 0), 400);
  assert.equal(buildBatches(points).reduce((sum, batch) => sum + batch.target, 0), 400);
});

test("未指定题量时沿用默认配额", () => {
  assert.deepEqual(mergeQuota(defaultQuota, { single: 0, multiple: 0, judgement: 0 }), defaultQuota);
});

test("仅指定单选题时，不自动添加判断题或多选题", () => {
  const quota = mergeQuota(defaultQuota, { single: 2, multiple: 0, judgement: 0 });
  assert.equal(quota.total, 2);
  assert.equal(quota.judgement, 0);
  assert.equal(quota.multiple, 0);
});

test("指定更高配额时仍按需求执行", () => {
  const quota = mergeQuota(defaultQuota, { single: 8, multiple: 3, judgement: 5 });
  assert.equal(quota.total, 16);
  assert.equal(quota.single, 8);
  assert.equal(quota.multiple, 3);
  assert.equal(quota.judgement, 5);
});
