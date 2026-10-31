import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SupplementButton } from "./supplement-button";

test("补题按钮可见，未停止或题量已满足时禁用", () => {
  const disabled = renderToStaticMarkup(<SupplementButton enabled={false} busy={false} onClick={() => undefined} />);
  assert.match(disabled, />补题<\/button>/);
  assert.match(disabled, /disabled=""/);
  assert.match(disabled, /停止生成并保留成果后/);
});

test("停止后有缺额时可点击，启动期间显示加载且禁止重复操作", () => {
  const ready = renderToStaticMarkup(<SupplementButton enabled busy={false} onClick={() => undefined} />);
  assert.doesNotMatch(ready, /disabled=""/);
  assert.match(ready, /保留已有成果/);
  const loading = renderToStaticMarkup(<SupplementButton enabled busy onClick={() => undefined} />);
  assert.match(loading, /补题启动中/);
  assert.match(loading, /disabled=""/);
});
