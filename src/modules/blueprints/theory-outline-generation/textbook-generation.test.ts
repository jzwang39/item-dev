import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  generateBasicChapter, generateStandardKnowledge, generateTextbookOutlines,
  validateTextbookInputs, type StandardKnowledge,
} from "./textbook-generation";
import type { GenerationChapter } from "./generation-context";
import type { ModelCaller } from "./generation-batch";

const levels = ["level_5", "level_4", "level_3"];
const chapters: GenerationChapter[] = [
  { id: "chapter1", ordinal: 1, chapterTitle: "慈善基础知识", sectionTitle: null, content: "慈善的定义、公益活动的基本原则。" },
  { id: "chapter2", ordinal: 2, chapterTitle: "慈善基础知识", sectionTitle: null, content: "职业道德的含义与行为准则。" },
];
function knowledge(levelCode: string, code = "1.1.1"): StandardKnowledge {
  return {
    id: `${levelCode}:${code}`, levelCode, functionCode: "1", functionName: "公益慈善宣讲",
    contentCode: "1.1", contentName: "理念宣传", code, name: "募捐工作基本理念",
    evidence: `${code} 募捐工作基本理念`, blueprintVersionId: "standard-version",
    fileObjectId: "standard-file", sourceVersionId: null,
  };
}
const items = levels.map((level) => knowledge(level));
function modelRecorder() {
  const prompts: Record<string, unknown>[] = [];
  const call: ModelCaller = async (_instruction, prompt) => {
    prompts.push(JSON.parse(prompt));
    return JSON.stringify({ points: [
      { name: "基本理念的含义", importance: "X", tertiaryName: "模型改写的范围" },
      { name: "基本理念的应用原则", importance: "Y", tertiaryName: "模型改写的范围" },
    ] });
  };
  return { prompts, call };
}

test("每条已存储章节各生成2点，同名章节不被合并，三等级复用同一份数据", async () => {
  const { call, prompts } = modelRecorder();
  const progress: number[] = [];
  const result = await generateTextbookOutlines("劝募员", chapters, items, levels, call, async (_level, completed) => { progress.push(completed); });
  assert.equal(prompts.length, 5);
  assert.deepEqual(levels.map((level) => result.get(level)!.length), [6, 6, 6]);
  const basics = levels.map((level) => result.get(level)!.filter((point) => point.sectionKind === "basic"));
  assert.deepEqual(basics[0], basics[1]);
  assert.deepEqual(basics[1], basics[2]);
  assert.equal(basics[0][0], basics[1][0]);
  assert.equal(new Set(basics[0].map((point) => point.sharedPointKey)).size, 4);
  assert.equal(progress.length, 9);
});

test("标准条目仅进入对应等级，模型不能改变职业功能、工作内容和三级名称", async () => {
  const { call } = modelRecorder();
  const result = await generateTextbookOutlines("劝募员", chapters, [...items, knowledge("level_4", "1.1.2")], levels, call, async () => {});
  assert.deepEqual(levels.map((level) => result.get(level)!.length), [6, 8, 6]);
  for (const level of levels) {
    const related = result.get(level)!.filter((point) => point.sectionKind === "related_knowledge");
    assert.ok(related.every((point) => point.standardSource?.levelCode === level));
    assert.ok(related.every((point) => point.primaryName === "相关知识要求 · 公益慈善宣讲" && point.secondaryName === "理念宣传"));
    assert.ok(related.every((point) => !point.tertiaryName.includes("模型改写")));
  }
});

test("基础章节传入完整内容，标准条目不携带任何教材内容或权重数量", async () => {
  const { call, prompts } = modelRecorder();
  const chapter = { ...chapters[0], content: "基础内容".repeat(2000) + "结尾重要知识" };
  await generateBasicChapter("劝募员", chapter, call);
  await generateStandardKnowledge("劝募员", items[0], call);
  assert.ok(JSON.stringify(prompts[0]).includes(chapter.content));
  assert.ok(!JSON.stringify(prompts[1]).includes(chapter.content));
  assert.equal(prompts[1].本批必须生成考评点数, 2);
  assert.ok(!JSON.stringify(prompts).includes("范围总目标数"));
});

test("数量只由章节和三级条目数决定，超过200个也不截断", async () => {
  const { call } = modelRecorder();
  const many = Array.from({ length: 101 }, (_, index) => ({ ...chapters[0], id: `chapter${index}`, ordinal: index + 1 }));
  const result = await generateTextbookOutlines("劝募员", many, items, levels, call, async () => {});
  assert.deepEqual(levels.map((level) => result.get(level)!.length), [204, 204, 204]);
});

test("缺少等级条目或父子编号不匹配时，在模型调用前拒绝", () => {
  assert.throws(() => validateTextbookInputs(chapters, items.slice(1), levels), /缺少相关知识要求/);
  assert.throws(() => validateTextbookInputs(chapters, [{ ...items[0], contentCode: "2.1" }, ...items.slice(1)], levels), /不匹配/);
  assert.throws(() => validateTextbookInputs(chapters, [...items, items[0]], levels), /路径重复/);
  assert.throws(() => validateTextbookInputs([], items, levels), /章节/);
  assert.throws(() => validateTextbookInputs([{ ...chapters[0], content: "" }], items, levels), /章节/);
});

test("占位和重复记录被过滤，只补缺少的一点，保留首次合格结果", async () => {
  const requested: number[] = [];
  const points = await generateBasicChapter("劝募员", chapters[0], async (_instruction, prompt) => {
    requested.push(JSON.parse(prompt).本批必须生成考评点数);
    return JSON.stringify({ points: requested.length === 1
      ? [{ name: "考评点1" }, { name: "慈善基本原则" }, { name: "慈善基本原则" }]
      : [{ name: "慈善活动的公益属性" }] });
  });
  assert.deepEqual(requested, [2, 1]);
  assert.equal(points.length, 2);
  assert.equal(points[0].name, "慈善基本原则");
});

test("任一等级生成失败时整个结果拒绝，不返回部分等级结果", async () => {
  const { call } = modelRecorder();
  let failedRequests = 0;
  await assert.rejects(generateTextbookOutlines("劝募员", chapters, items, levels, async (instruction, prompt, temperature) => {
    if (JSON.parse(prompt).依据.等级 === "level_4") {
      failedRequests += 1;
      return '{"points":[]}';
    }
    return call(instruction, prompt, temperature);
  }, async () => {}), /连续6次/);
  assert.equal(failedRequests, 6);
});

test("概括性标准条目允许范围内细化，但教材仍只提取正文知识", async () => {
  const instructions: string[] = [];
  const { call } = modelRecorder();
  const caller: ModelCaller = async (instruction, prompt, temperature) => {
    instructions.push(instruction);
    return call(instruction, prompt, temperature);
  };
  await generateBasicChapter("劝募员", chapters[0], caller);
  await generateStandardKnowledge("劝募员", items[0], caller);
  assert.ok(instructions[0].includes("不得编造正文中没有的内容"));
  assert.ok(!instructions[0].includes("通用专业知识"));
  assert.ok(instructions[1].includes("三级条目是考核范围"));
  assert.ok(instructions[1].includes("不得越出条目范围"));
  assert.ok(instructions[1].includes("不得编造具体法律条款"));
});

test("模型只照抄条目且连续重复时，向补齐请求反馈重复数量和排除项", async () => {
  const item = { ...knowledge("level_5", "1.1.3"), name: "募捐工作宣传资料准备要点" };
  let attempts = 0;
  const points = await generateStandardKnowledge("劝募员", item, async (_instruction, prompt) => {
    const payload = JSON.parse(prompt);
    attempts += 1;
    if (attempts === 3) {
      assert.equal(payload.本批必须生成考评点数, 1);
      assert.equal(payload.本来源总目标数, 2);
      assert.ok(payload.重试说明.includes("重复1条"));
      assert.ok(payload.重试说明.includes("禁止再次输出或仅改名"));
      assert.equal(payload.已生成考评点[0].name, item.name);
      return JSON.stringify({ points: [{ name: "募捐宣传资料的信息核验要点", importance: "X" }] });
    }
    return JSON.stringify({ points: [{ name: item.name, importance: "X" }] });
  });
  assert.equal(points.length, 2);
  assert.equal(attempts, 3);
});

test("失败信息明确包含具体等级、父级、条目和拒绝原因", async () => {
  await assert.rejects(generateStandardKnowledge("劝募员", items[0], async () =>
    '{"points":[{"name":"募捐工作基本理念","importance":"X"}]}'),
  /level_5／公益慈善宣讲／理念宣传／1\.1\.1.*1\/2.*重复1条/);
  await assert.rejects(generateBasicChapter("劝募员", chapters[0], async () => '{"points":[]}'),
    /教材章节1“慈善基础知识”.*返回0条/);
});

test("真实劝募员标准按各等级相关知识条目生成，并保留截图父级关系", async () => {
  const { extractPdfText } = await import("../../documents/extraction/service");
  const { parseDirectionalTheoryWeights, parseStandardRequirements } = await import("../theory-weights/standard");
  const text = (await extractPdfText(await readFile("docs/测试真实数据/劝募员-标准（技能水平和理论知识&一级到五级）.pdf"))).text;
  const weights = parseDirectionalTheoryWeights(text, { name: "劝募员", code: "3-01-01-05", directions: [] });
  const scopes = parseStandardRequirements(text, weights);
  const parsed = scopes.flatMap((scope) => scope.functions.flatMap((fn) => fn.contents.flatMap((content) =>
    content.requirements.filter((item) => item.kind === "related_knowledge").map((item) => ({
      ...knowledge(scope.levelCode, item.code), functionCode: fn.code, functionName: fn.name,
      contentCode: content.code, contentName: content.name, name: item.name, evidence: item.evidence,
    })))));
  const { call } = modelRecorder();
  const result = await generateTextbookOutlines("劝募员", chapters, parsed, levels, call, async () => {});
  for (const level of levels) assert.equal(result.get(level)!.length, chapters.length * 2 + parsed.filter((item) => item.levelCode === level).length * 2);
  const item = result.get("level_5")!.find((point) => point.standardSource?.code === "1.1.1");
  assert.equal(item?.standardSource?.functionName, "公益慈善宣讲");
  assert.equal(item?.standardSource?.contentName, "理念宣传");
  assert.equal(item?.standardSource?.name, "募捐工作基本理念");
  const typo = result.get("level_4")!.find((point) => point.standardSource?.name === "募捐工作资料分类方法");
  assert.equal(typo?.standardSource?.contentCode, "3.2");
  assert.equal(typo?.standardSource?.code, "3.1.3");
  assert.ok(typo?.sourceWarning?.includes("待核对"));
});
