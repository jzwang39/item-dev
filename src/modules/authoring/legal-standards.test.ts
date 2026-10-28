import assert from "node:assert/strict";
import test from "node:test";
import { allowedClauses, type LegalConfigInput } from "./legal-contracts";

const config: LegalConfigInput = {
  id: "law-10",
  prompt: "仅依据已核验的正式标准原文生成两道试题。",
  documentTitle: "边界验证专用测试标准",
  documentVersion: "GB/T 99999-2020",
  effectiveDate: "2020-01-01",
  sourceUrl: "https://www.cnis.ac.cn/test",
  confirmed: true,
  fullText: "边界验证专用测试标准\n1 范围\n本测试文本仅用于验证章节边界，不是正式标准原文。\n2 规范性引用文件\n下节内容不允许命题。",
};

test("标准支持编号加空格的第1节标题，仅包含该节原文", () => {
  const clauses = allowedClauses(config);
  assert.equal(clauses.length, 1);
  assert.equal(clauses[0].id, "第1节");
  assert.ok(clauses[0].text.includes("验证章节边界"));
  assert.ok(!clauses[0].text.includes("下节内容"));
});

test("标准泛称、缺少编号年份、边界缺失或目录歧义均拒绝", () => {
  assert.throws(() => allowedClauses({ ...config, documentVersion: "待确认" }), /标准编号/);
  assert.throws(() => allowedClauses({ ...config, fullText: config.fullText.replace("2 规范性引用文件", "其他内容") }), /边界/);
  assert.throws(() => allowedClauses({ ...config, fullText: `${config.fullText}\n${config.fullText}` }), /唯一识别/);
  const title = "慈善领域国家和行业标准";
  assert.throws(() => allowedClauses({ ...config, documentTitle: title, fullText: `${title}\n${config.fullText}` }), /泛称/);
});
