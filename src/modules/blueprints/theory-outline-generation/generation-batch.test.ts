import assert from "node:assert/strict";
import { test } from "node:test";

import { generateAssessmentBatch } from "./generation-batch";
import { buildChapterExcerptPool, selectBatchExcerpts, selectRelevantChapters, type GenerationChapter } from "./generation-context";

function chapter(id: string, title: string, content: string): GenerationChapter {
  return { id, ordinal: Number(id) || 1, chapterTitle: title, sectionTitle: null, content };
}

test("排除同名目录片段并通过主题词匹配捐赠管理正文", () => {
  const chapters = [
    chapter("1", "捐赠信息管理\t207", "捐赠信息目录".repeat(10)),
    chapter("2", "慈善法相关知识", "捐赠管理概述".repeat(20)),
    chapter("3", "捐赠信息管理", "捐赠信息的登记和核对要求".repeat(500)),
    chapter("4", "职业道德", "职业道德规范".repeat(500)),
  ];
  const selected = selectRelevantChapters(chapters, "捐赠管理");
  assert.deepEqual(selected.map((item) => item.id), ["3"]);
});

test("匹配章节后半部分而不是仅搜索前1500字", () => {
  const chapters = [chapter("1", "法律规范", "前言".repeat(1000) + "捐赠管理规范")];
  assert.equal(selectRelevantChapters(chapters, "捐赠管理")[0].id, "1");
});

test("基础知识不因一句介绍而被限制在新媒体单节", () => {
  const chapters = [
    chapter("1", "慈善伦理\t50", "目录条目"),
    chapter("2", "慈善伦理", "慈善伦理的含义和行为准则".repeat(500)),
    chapter("3", "职业道德基本知识", "职业道德规范".repeat(500)),
    chapter("4", "新媒体应用基础", "本节介绍新媒体的基础知识".repeat(500)),
    chapter("5", "相关法律规范", "法律规范和适用条件".repeat(500)),
  ];
  const selected = selectRelevantChapters(chapters, "基础知识");
  assert.deepEqual(selected.map((item) => item.id), ["2", "4", "5"]);
  const pool = buildChapterExcerptPool(chapters, "基础知识");
  const covered = new Set(
    Array.from({ length: 4 }, (_, index) => selectBatchExcerpts(pool, index, 4, 1))
      .flat().map((excerpt) => excerpt.chapterId),
  );
  assert.ok(covered.has("2"));
  assert.ok(covered.has("4"));
  assert.ok(covered.has("5"));
});

test("教材切片无遗漏，后续批次及重试切换正文片段", () => {
  const content = "捐赠信息登记要求\n".repeat(1200);
  const pool = buildChapterExcerptPool([chapter("1", "捐赠信息管理", content)], "捐赠管理");
  assert.equal(pool.map((excerpt) => excerpt.content).join(""), content);
  const first = selectBatchExcerpts(pool, 0, 3, 1);
  const next = selectBatchExcerpts(pool, 1, 3, 1);
  const retry = selectBatchExcerpts(pool, 0, 3, 2);
  assert.notDeepEqual(first.map((item) => item.start), next.map((item) => item.start));
  assert.notDeepEqual(first.map((item) => item.start), retry.map((item) => item.start));
});

const options = {
  occupationName: "劝募员", levelCode: "level_4", mode: "textbook" as const,
  category: "相关知识要求", topic: "捐赠管理", weight: 25,
  chapters: [chapter("1", "捐赠信息管理", "捐赠信息登记要求\n".repeat(1200))],
  batchIndex: 1, batchCount: 5, targetCount: 3,
  reservedPointKeys: new Set(["捐赠信息\u0000捐赠登记核对要求"]),
};

test("保留新条目，只补缺额，重试切换片段并包含排除列表", async () => {
  const prompts: Array<Record<string, any>> = [];
  const points = await generateAssessmentBatch(options, async (_instruction, prompt) => {
    const payload = JSON.parse(prompt);
    prompts.push(payload);
    return JSON.stringify({
      points: prompts.length === 1
        ? [
          { name: "捐赠登记核对要求", tertiaryName: "捐赠信息", importance: "X" },
          { name: "捐赠凭证归档规范", tertiaryName: "捐赠信息", importance: "Y" },
        ]
        : [
          { name: "捐赠信息保密要求", tertiaryName: "捐赠信息", importance: "X" },
          { name: "捐赠记录更新流程", tertiaryName: "捐赠信息", importance: "Z" },
        ],
    });
  });
  assert.equal(points.length, 3);
  assert.equal(prompts[1].本批必须生成考评点数, 2);
  assert.ok(prompts[1].已生成考评点.some((point: any) => point.名称 === "捐赠凭证归档规范"));
  assert.notEqual(prompts[0].教材章节[0].段落起始位置, prompts[1].教材章节[0].段落起始位置);
  assert.ok(points.every((point) => point.sourceChapterIds.includes("1")));
});

test("持续重复仍失败，不通过改名或占位名称凑数", async () => {
  let calls = 0;
  await assert.rejects(generateAssessmentBatch(options, async () => {
    calls += 1;
    return JSON.stringify({ points: [
      { name: "捐赠登记核对要求", tertiaryName: "捐赠信息", importance: "X" },
      { name: "考评点名称1", tertiaryName: "捐赠信息", importance: "X" },
    ] });
  }), /已补齐 0\/3/);
  assert.equal(calls, 6);
});

test("无教材模式不发送仅依据教材的指令", async () => {
  await generateAssessmentBatch({
    ...options, mode: "model", chapters: [], targetCount: 1, reservedPointKeys: new Set(),
  }, async (instruction) => {
    assert.ok(!instruction.includes("仅能依据本次给定教材"));
    return '{"points":[{"name":"捐赠凭证保管规范","importance":"X"}]}';
  });
});
