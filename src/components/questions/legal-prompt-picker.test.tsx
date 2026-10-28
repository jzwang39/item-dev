import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LegalConfig } from "@/modules/authoring/legal-contracts";
import { LegalPromptPicker } from "./legal-prompt-picker";

const topics: LegalConfig[] = [
  {
    id: "law-1", prompt: "管理员保存的民法典专用提示词，仅按已核验原文命题。",
    documentTitle: "中华人民共和国民法典", documentVersion: "版本甲",
    effectiveDate: "2021-01-01", sourceUrl: "https://www.npc.gov.cn/test",
    fullText: "测试原文，不用于正式命题。", confirmed: true, revision: 3, contentHash: "test",
  },
  {
    id: "law-2", prompt: "管理员保存的劳动法专用提示词，只使用允许范围。",
    documentTitle: "中华人民共和国劳动法", documentVersion: "", effectiveDate: "",
    sourceUrl: "", fullText: "", confirmed: false, revision: 2, contentHash: "test",
  },
];

function render(selectedIds: string[], previewId = "law-1", disabled = false) {
  return renderToStaticMarkup(<LegalPromptPicker topics={topics} selectedIds={selectedIds}
    previewId={previewId} disabled={disabled} onSelect={() => undefined} onManage={() => undefined} />);
}

test("直接显示已保存提示词、版本及正式原文，默认不勾选主题", () => {
  const html = render([]);
  assert.ok(html.includes(topics[0].prompt));
  assert.ok(html.includes("v3"));
  assert.ok(html.includes("版本甲"));
  assert.ok(html.includes("已选 0 个"));
  assert.equal((html.match(/aria-pressed="false"/g) ?? []).length, 2);
});

test("切换主题显示该主题的保存内容，而非默认参考提示词", () => {
  const html = render(["law-2"], "law-2");
  assert.ok(html.includes(topics[1].prompt));
  assert.ok(!html.includes(topics[0].prompt));
  assert.ok(html.includes("正式原文尚未核验"));
  assert.ok(html.includes("前往配置并核验"));
});

test("未核验主题仍可查看选择，多选时显示全部选择状态", () => {
  const html = render(["law-1", "law-2"]);
  assert.ok(html.includes("已选 2 个"));
  assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 2);
  assert.ok(!html.includes("disabled="));
});

test("加载提交期间禁止切换提示词或进入管理", () => {
  const html = render(["law-1"], "law-1", true);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 3);
});

test("已填完整配置但未确认时明确提示勾选确认，而非未配置", () => {
  const html = renderToStaticMarkup(<LegalPromptPicker topics={[{ ...topics[0], confirmed: false }]}
    selectedIds={["law-1"]} previewId="law-1" disabled={false} onSelect={() => undefined} onManage={() => undefined} />);
  assert.ok(html.includes("已配置，待确认核验"));
  assert.ok(html.includes("所选原文已配置，但尚未确认核验"));
  assert.ok(html.includes("勾选"));
});
