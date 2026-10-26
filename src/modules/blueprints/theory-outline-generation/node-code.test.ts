import assert from "node:assert/strict";
import { test } from "node:test";

import { codeFor } from "./node-code";

test("编码在Z之后使用AA，不产生标点或小写字母", () => {
  const values = new Map<string, string>();
  const codes = Array.from({ length: 703 }, (_, index) => codeFor(values, `范围${index}`));
  assert.equal(codes[0], "A");
  assert.equal(codes[25], "Z");
  assert.equal(codes[26], "AA");
  assert.equal(codes[51], "AZ");
  assert.equal(codes[52], "BA");
  assert.equal(codes[701], "ZZ");
  assert.equal(codes[702], "AAA");
  assert.ok(codes.every((code) => /^[A-Z]+$/.test(code)));
  assert.equal(new Set(codes.map((code) => code.toLowerCase())).size, codes.length);
});

test("重复访问相同范围不改变编码或分类数量", () => {
  const values = new Map<string, string>();
  assert.equal(codeFor(values, "基本要求"), "A");
  assert.equal(codeFor(values, "相关知识要求"), "B");
  assert.equal(codeFor(values, "基本要求"), "A");
  assert.equal(values.size, 2);
});
