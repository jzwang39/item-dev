import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ExpansionEvidence } from "./expansion-evidence";

test("无扩展资料时不显示引用预览", () => {
  assert.equal(renderToStaticMarkup(<ExpansionEvidence />), "");
});

test("引用原文独立可见并显示出处定位，不能被误认为通过的题目", () => {
  const html = renderToStaticMarkup(<ExpansionEvidence documents={[{
    id: "D1", title: "学术资料", url: "https://bkds.ustb.edu.cn/article",
    text: "用户在信息生成、传播、分享和接收间切换。", publication: "学报2024",
    locator: "第一节", retrievedAt: "2026-11-01", acquisition: "版本化留存原文",
  }]} />);
  assert.match(html, /已载入参考原文/);
  assert.match(html, /载入不代表试题通过/);
  assert.match(html, /用户在信息生成、传播、分享和接收间切换/);
  assert.match(html, /定位：第一节/);
  assert.match(html, /bkds.ustb.edu.cn/);
  assert.match(html, /版本化留存原文/);
});

test("原文里的HTML或脚本作为文本转义显示，不执行资料指令", () => {
  const html = renderToStaticMarkup(<ExpansionEvidence documents={[{
    id: "D1", title: "资料", url: "javascript:alert(1)", text: "<script>alert(1)</script>",
    retrievedAt: "2026-11-01",
  }]} />);
  assert.doesNotMatch(html, /<script>|href=/);
  assert.match(html, /&lt;script&gt;/);
});
