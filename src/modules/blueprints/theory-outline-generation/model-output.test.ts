import assert from "node:assert/strict";
import { test } from "node:test";

import { parseModelOutput } from "./model-output";

test("英文标准响应可以解析十个考评点", () => {
  const result = parseModelOutput(JSON.stringify({
    points: Array.from({ length: 10 }, (_, index) => ({
      name: `捐赠物资分类要求${index}`, importance: "X", tertiaryName: "物资管理",
    })),
  }));
  assert.equal(result.points.length, 10);
  assert.equal(result.invalidCount, 0);
});

test("中文字段、混合字段及有效的短名称不会被遗漏", () => {
  const result = parseModelOutput(JSON.stringify({
    考评点: [
      { 考评点名称: "消防", 重要程度: " y ", 三级考评范围: "安全规范" },
      { name: "库存盘点", 重要程度: "Z" },
      { 考核点名称: "登记规范", importance: "X" },
    ],
  }));
  assert.equal(result.points.length, 3);
  assert.equal(result.points[0].importance, "Y");
});

test("一条无效记录不会丢弃其余九条", () => {
  const result = parseModelOutput(JSON.stringify({
    points: [
      ...Array.from({ length: 9 }, (_, index) => ({ name: `财务登记规范${index}`, importance: "X" })),
      { name: "捐赠登记", importance: "X|Y|Z" },
    ],
  }));
  assert.equal(result.points.length, 9);
  assert.equal(result.receivedCount, 10);
  assert.equal(result.invalidCount, 1);
});

test("支持包裹对象和考评点列表字段", () => {
  const result = parseModelOutput(JSON.stringify({
    data: { 考评点列表: [{ 名称: "物资验收流程", 重要程度: "X" }] },
  }));
  assert.equal(result.points.length, 1);
});

test("支持 Markdown 和顶层数组", () => {
  const result = parseModelOutput('```json\n[{"name":"物资交接规范","importance":"Z"}]\n```');
  assert.equal(result.points.length, 1);
});

test("未知字段不会被伪装成空数组", () => {
  assert.throws(() => parseModelOutput('{"unexpected":[]}'), /未包含考评点数组.*unexpected/);
});

test("真实空数组明确保留零条结果", () => {
  const result = parseModelOutput('{"points":[]}');
  assert.equal(result.receivedCount, 0);
  assert.equal(result.invalidCount, 0);
});

test("非法字段类型及空名称保持无效", () => {
  const result = parseModelOutput('{"points":[null,{"name":""},{"name":12},{"name":"登记规则","importance":"A"}]}');
  assert.equal(result.points.length, 0);
  assert.equal(result.invalidCount, 4);
});

test("不完整 JSON 不会被作为有效响应接受", () => {
  assert.throws(() => parseModelOutput('{"points":[{"name":"登记规则"}'), /JSON 格式不正确/);
});

test("纯英文名称不能发布到中文细目表", () => {
  const result = parseModelOutput('{"points":[{"name":"Financial Management","importance":"X"}]}');
  assert.equal(result.points.length, 0);
  assert.equal(result.invalidCount, 1);
});
