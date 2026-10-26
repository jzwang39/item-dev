import { strict as assert } from "node:assert";
import { test } from "node:test";
import { extractSkillKnowledge, parseKnowledgeEntries, splitKnowledgeText } from "./skill-knowledge-extraction";
import type { StandardScope } from "./skill-standard";

const scopes: StandardScope[] = [{
  column: { key: "level_4", levelCode: "level_4", label: "四级/中级工", direction: "通用" },
  totalMinutes: null, rows: [{ code: "A", name: "轴类工件加工", score: 100, minutes: null, selection: null, method: null }],
}];
const text = "按图样选择刀具。调整切削参数。检查加工尺寸。";
const entry = { knowledgeName: "刀具选择", evidence: "按图样选择刀具", name: "根据图样选择加工刀具", scopeKey: "level_4", rowName: "轴类工件加工", importance: "X" };
const output = (entries: unknown[], completed = true) => JSON.stringify({ completed, knowledgePoints: entries });
test("one knowledge point produces one point regardless of weight", () => {
  const entries = parseKnowledgeEntries(output([entry]), text, scopes);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].knowledgeName, "刀具选择");
});
test("reject fabricated evidence, invalid scope and truncated extraction", () => {
  assert.throws(() => parseKnowledgeEntries(output([{ ...entry, evidence: "教材不存在的文字" }]), text, scopes), /核验/);
  assert.throws(() => parseKnowledgeEntries(output([{ ...entry, scopeKey: "invalid" }]), text, scopes), /范围/);
  assert.throws(() => parseKnowledgeEntries(output([entry], false), text, scopes), /截断/);
});
test("reject multiple assessment points from the same knowledge point", () => {
  assert.throws(() => parseKnowledgeEntries(output([entry, { ...entry, name: "调整刀具安装" }]), text, scopes), /多个/);
});
test("empty inapplicable chunks and Chinese fields are supported", () => {
  assert.deepEqual(parseKnowledgeEntries(output([]), text, scopes), []);
  const entries = parseKnowledgeEntries(JSON.stringify({ 提取完成: true, 知识点: [{
    知识点名称: entry.knowledgeName, 原文依据: entry.evidence, 鉴定点名称: entry.name,
    等级方向标识: entry.scopeKey, 二级范围名称: entry.rowName, 重要程度: "X",
  }] }), text, scopes);
  assert.equal(entries.length, 1);
});
test("chunking covers full text without omissions or overlap", () => {
  const long = text.repeat(1000);
  const chunks = splitKnowledgeText(long, "chapter", "第一章");
  assert.ok(chunks.length > 1);
  assert.equal(chunks.map((chunk) => chunk.text).join(""), long);
  assert.ok(chunks.every((chunk) => chunk.text.length <= 6001));
});
test("retry invalid extraction without quota filling", async () => {
  let calls = 0;
  const entries = await extractSkillKnowledge({ chapterId: "chapter", locator: "第一章", text }, scopes, "textbook", [], async (instruction, prompt) => {
    calls++;
    assert.ok(instruction.includes("一个独立知识点"));
    assert.equal(JSON.parse(prompt).本批必须生成考评点数, undefined);
    return calls === 1 ? output([entry], false) : output([entry]);
  });
  assert.equal(calls, 2);
  assert.equal(entries.length, 1);
});
