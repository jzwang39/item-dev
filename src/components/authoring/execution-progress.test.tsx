import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ExecutionProgress } from "./execution-progress";

test("生成中或停止保留成果显示实际数量和完成比例，不把部分失败当作完成", () => {
  const html = renderToStaticMarkup(<ExecutionProgress generated={777} target={1062} started />);
  assert.match(html, /已生成 777 \/ 1062 道/);
  assert.match(html, /73%/);
  assert.match(html, /aria-valuenow="777"/);
  assert.match(html, /aria-valuemax="1062"/);
});

test("未执行计划显示未开始，空计划不产生0除错误", () => {
  const html = renderToStaticMarkup(<ExecutionProgress generated={0} target={1200} started={false} />);
  assert.match(html, /未开始 0 \/ 1200 道/);
  assert.match(html, /0%/);
  const empty = renderToStaticMarkup(<ExecutionProgress generated={0} target={0} started={false} />);
  assert.match(empty, /未制定题量/);
  assert.doesNotMatch(empty, /NaN|Infinity|progressbar/);
});

test("补题完成显示100%，超额成果不会让进度条超出范围", () => {
  const done = renderToStaticMarkup(<ExecutionProgress generated={1062} target={1062} started />);
  assert.match(done, /100%/);
  const extra = renderToStaticMarkup(<ExecutionProgress generated={1200} target={1062} started />);
  assert.match(extra, /已生成 1200 \/ 1062 道/);
  assert.match(extra, /width:100%/);
  assert.match(extra, /aria-valuenow="1062"/);
});

test("异常数值安全显示，不输出无效进度", () => {
  const html = renderToStaticMarkup(<ExecutionProgress generated={NaN} target={100} started />);
  assert.match(html, /已生成 0 \/ 100 道/);
  assert.doesNotMatch(html, /NaN|Infinity/);
});

test("公共任务复用进度条，明确含已有成果且显示真实百分比", () => {
  const html = renderToStaticMarkup(<ExecutionProgress generated={123} target={492} started completedLabel="已有 / 已生成" />);
  assert.match(html, /已有 \/ 已生成 123 \/ 492 道/);
  assert.match(html, /25%/);
  assert.match(html, /role="progressbar"/);
});
