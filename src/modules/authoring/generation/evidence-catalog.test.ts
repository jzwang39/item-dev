import assert from "node:assert/strict";
import test from "node:test";
import { buildEvidenceCatalog, nextEvidencePage } from "./evidence-catalog";
import { GenerationFailure, parseAnglePlan } from "./retry-policy";

test("完整检查冻结关联章节，排序不移除低相关章节，引用编号稳定且原文逐字保留", () => {
  const chapters = [
    { id: "one", chapter_title: "职业道德", section_title: null, content_text: "职业道德原文".repeat(500) },
    { id: "two", chapter_title: "归档规范", section_title: null, content_text: "资料借阅须登记，归还须核对完整性。" },
  ];
  const first = buildEvidenceCatalog({}, chapters, "归档规范");
  assert.ok(first.some((source) => source.id.startsWith("textbook:one:")));
  assert.ok(first.some((source) => source.id.startsWith("textbook:two:")));
  const reversed = buildEvidenceCatalog({}, [...chapters].reverse(), "归档规范");
  assert.deepEqual(new Set(first.map((source) => source.id)), new Set(reversed.map((source) => source.id)));
  for (const source of first) {
    const chapter = chapters.find((chapter) => source.id.startsWith(`textbook:${chapter.id}:`))!;
    assert.equal(source.content, chapter.content_text.slice(source.start, source.start! + 1500));
  }
  const firstPage = nextEvidencePage(first, []);
  const secondPage = nextEvidencePage(first, firstPage.map((source) => source.id));
  assert.ok(secondPage.every((source) => !firstPage.includes(source)));
});

test("稳定编号由系统取回原文，不让模型的改写quote成为引用依据，未知编号仍拒绝", () => {
  const sources = buildEvidenceCatalog({ evidence: "借阅资料须登记，归还须核对完整性。" }, [], "归档");
  const content = { remaining: [{ angle: "借阅登记", sourceId: sources[0].id, quote: "模型改写并不是原文" }] };
  assert.equal(parseAnglePlan(JSON.stringify(content), 0, sources, [], "judgement").selected.quote, sources[0].content);
  assert.throws(() => parseAnglePlan(JSON.stringify({ remaining: [{ ...content.remaining[0], sourceId: "不存在" }] }), 0, sources, [], "judgement"),
    (error: unknown) => error instanceof GenerationFailure && error.code === "evidence_invalid");
  assert.throws(() => parseAnglePlan('{"remaining":[]}', 0, sources, [], "judgement"),
    (error: unknown) => error instanceof GenerationFailure && error.code === "no_task_in_excerpt");
});

test("层级名称、权重和质量标准本身不能充当事实原文", () => {
  assert.deepEqual(buildEvidenceCatalog({ name: "归档", weight: 30, qualityStandard: "试题须有唯一解" }, [], "归档"), []);
});
