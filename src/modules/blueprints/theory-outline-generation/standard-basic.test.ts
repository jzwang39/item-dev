import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseStandardBasicItems } from "./standard-basic";
import { generateStandardOutlines } from "./textbook-generation";
import type { StandardKnowledge } from "./textbook-generation";
import { planStandardQuotas, type TextbookWeight } from "./textbook-quota";

test("基本要求按编号末级条目提取，职业守则括号分项不重复计数", () => {
  const items = parseStandardBasicItems(`
2. 基本要求
2.1 职业道德
2.1.1 职业道德基本知识
2.1.2 职业守则
（1）热爱公益，诚信守法。
（2）尊重伦理，同理共情。
2.2 基础知识
2.2.1 公益传播知识
3. 工作要求
3.1 五级/初级工
1.1.1 不应提取的相关知识`);
  assert.deepEqual(items.map((item) => item.code), ["2.1.1", "2.1.2", "2.2.1"]);
  assert.equal(items[1].parentName, "职业道德");
  assert.ok(items[1].evidence.includes("诚信守法"));
  assert.equal(items[2].parentName, "基础知识");
});

for (const title of ["基本要求", "基本知识", "基本信息", "基础知识"]) {
  test(`支持“${title}”作为公共基本信息章节名称`, () => {
    const items = parseStandardBasicItems(`2. ${[...title].join(" ")}\n2.1 职业道德\n2.1.1诚信知识\n3. 工作要求`);
    assert.equal(items.length, 1);
    assert.equal(items[0].category, title);
    assert.equal(items[0].name, "诚信知识");
  });
}

test("没有编号条目、重复编号或缺少父级时拒绝，不悄悄减少数量", () => {
  assert.throws(() => parseStandardBasicItems("2. 基本要求\n3. 工作要求"), /未识别到编号条目/);
  assert.throws(() => parseStandardBasicItems("2. 基本要求\n2.1 内容\n2.1 内容\n3. 工作要求"), /编号重复/);
  assert.throws(() => parseStandardBasicItems("2. 基本要求\n2.1.1 知识\n3. 工作要求"), /缺少父级/);
  assert.throws(() => parseStandardBasicItems("3. 工作要求\n1.1.1 能宣讲理念"), /未提取到/);
});

test("真实劝募员标准提取8项公共基础信息，完整保留跨页正文和法律名称", async () => {
  const { extractPdfText } = await import("../../documents/extraction/service");
  const text = (await extractPdfText(await readFile("docs/测试真实数据/劝募员-标准（技能水平和理论知识&一级到五级）.pdf"))).text;
  const items = parseStandardBasicItems(text);
  assert.equal(items.length, 8);
  assert.equal(items[0].name, "职业道德基本知识");
  assert.equal(items[1].name, "职业守则");
  assert.equal(items[7].name, "相关法律、法规及标准知识");
  assert.ok(items[4].evidence.includes("捐赠信息管理基本知识"));
  assert.ok(!items.some((item) => item.evidence.includes("职业编码")));
  assert.ok(!items.some((item) => item.code.startsWith("3.")));
});

test("无教材按权重生成200点，公共池只生成一次，各等级按配额复用且不传教材", async () => {
  const levels = ["level_5", "level_4", "level_3"];
  const basic = parseStandardBasicItems("2. 基本要求\n2.1 职业道德\n2.1.1 道德基本知识\n2.1.2 职业守则\n3. 工作要求")
    .map((item) => ({ ...item, blueprintVersionId: "version", fileObjectId: "file", sourceVersionId: "source" }));
  const knowledge: StandardKnowledge[] = levels.map((levelCode) => ({
    id: levelCode, levelCode, functionCode: "1", functionName: "公益宣讲", contentCode: "1.1",
    contentName: "理念宣传", code: "1.1.1", name: "公益理念", evidence: "公益理念",
    blueprintVersionId: "version", fileObjectId: "file", sourceVersionId: "source",
  }));
  knowledge.push({ ...knowledge[1], id: "extra", code: "1.1.2", name: "传播方法" });
  const weights: TextbookWeight[] = [
    { id: "basic", category: "基本要求", name: "职业道德", blueprintVersionId: "version",
      weights: { level_5: 10, level_4: 15, level_3: 20 } },
    { id: "related", category: "相关知识要求", name: "公益宣讲", blueprintVersionId: "version",
      weights: { level_5: 90, level_4: 85, level_3: 80 } },
  ];
  let calls = 0;
  const basicCodes: string[] = [];
  const result = await generateStandardOutlines("劝募员", basic, knowledge, levels, async (_instruction, prompt) => {
    calls++;
    assert.ok(!prompt.includes("章节记录"));
    assert.ok(!prompt.includes("权重"));
    const input = JSON.parse(prompt);
    if (input.依据.标准基本条目) basicCodes.push(input.依据.标准基本条目.编号);
    return JSON.stringify({ points: Array.from({ length: input.本批必须生成考评点数 }, (_, index) =>
      ({ name: `来源${calls}知识对象${index + 1}的适用条件`, importance: "X" })) });
  }, async () => {}, weights);
  assert.deepEqual(basicCodes, ["2.1.1", "2.1.2"]);
  assert.deepEqual(levels.map((level) => result.get(level)!.length), [200, 200, 200]);
  const shared = levels.map((level) => result.get(level)!.filter((point) => point.sectionKind === "basic"));
  assert.deepEqual(shared.map((points) => points.length), [20, 30, 40]);
  assert.ok(shared[0].every((point) => shared[1].some((other) => other.sharedPointKey === point.sharedPointKey && other.name === point.name)));
  for (const level of levels) {
    assert.ok(result.get(level)!.filter((point) => point.sectionKind === "basic").every((point) => point.standardBasicSource?.fileObjectId === "file" &&
      point.sourceChapterIds.length === 0 && point.secondaryName === point.standardBasicSource.parentName));
    assert.ok(result.get(level)!.filter((point) => point.sectionKind === "related_knowledge").every((point) => point.standardSource?.levelCode === level));
    assert.ok(result.get(level)!.every((point) => point.quotaSource?.blueprintVersionId === "version"));
  }
});

test("无教材任一等级失败拒绝整个结果，不能跳过条目凑数", async () => {
  const basic = [{ code: "2.1", name: "基础知识", category: "基本要求", parentName: "基本要求", evidence: "知识", blueprintVersionId: "v", fileObjectId: "f", sourceVersionId: null }];
  const item: StandardKnowledge = { id: "1", levelCode: "level_5", functionCode: "1", functionName: "宣讲", contentCode: "1.1", contentName: "宣传", code: "1.1.1", name: "理念", evidence: "理念", blueprintVersionId: "v", fileObjectId: "f", sourceVersionId: null };
  let failedCalls = 0, completedFirstLevel = false;
  await assert.rejects(generateStandardOutlines("劝募员", basic, [item, { ...item, id: "2", levelCode: "level_4" }], ["level_5", "level_4"], async (_instruction, prompt) => {
    const input = JSON.parse(prompt);
    if (input.依据.等级 === "level_4") {
      failedCalls++;
      return '{"points":[]}';
    }
    const existing = input.已生成考评点.length;
    const label = input.依据.等级 ?? "公共";
    return JSON.stringify({ points: Array.from({ length: input.本批必须生成考评点数 }, (_, index) =>
      ({ name: `${label}知识对象${existing + index + 1}`, importance: "X" })) });
  },
  async (level, _completed, points) => { if (level === "level_5" && points.length === 200) completedFirstLevel = true; }, [
    { id: "basic", category: "基本要求", name: "基础知识", blueprintVersionId: "v", weights: { level_5: 5, level_4: 5 } },
    { id: "related", category: "相关知识要求", name: "宣讲", blueprintVersionId: "v", weights: { level_5: 95, level_4: 95 } },
  ]), /连续6次/);
  assert.equal(failedCalls, 6);
  assert.equal(completedFirstLevel, true);
});

test("无教材缺少权重在调用模型前拒绝", async () => {
  const basic = [{ code: "2.1", name: "基础知识", category: "基本要求", parentName: "基本要求", evidence: "知识", blueprintVersionId: "v", fileObjectId: "f", sourceVersionId: null }];
  const item: StandardKnowledge = { id: "1", levelCode: "level_5", functionCode: "1", functionName: "宣讲", contentCode: "1.1", contentName: "宣传", code: "1.1.1", name: "理念", evidence: "理念", blueprintVersionId: "v", fileObjectId: "f", sourceVersionId: null };
  let calls = 0;
  await assert.rejects(generateStandardOutlines("劝募员", basic, [item], ["level_5"], async () => { calls++; return "{}"; },
    async () => {}, []), /缺少当前理论知识权重表/);
  assert.equal(calls, 0);
});

test("零配额基本范围不调用模型，最大余数法按原文内容量分配", () => {
  const basic = [
    { code: "2.1", name: "职业守则", category: "基本要求", parentName: "职业道德", evidence: "守则", blueprintVersionId: "v", fileObjectId: "f", sourceVersionId: null },
    { code: "2.2.1", name: "知识甲", category: "基本要求", parentName: "基础知识", evidence: "甲", blueprintVersionId: "v", fileObjectId: "f", sourceVersionId: null },
    { code: "2.2.2", name: "知识乙", category: "基本要求", parentName: "基础知识", evidence: "乙乙乙", blueprintVersionId: "v", fileObjectId: "f", sourceVersionId: null },
  ];
  const plan = planStandardQuotas(basic, [], ["level_5"], [
    { id: "ethics", category: "基本要求", name: "职业道德", blueprintVersionId: "v", weights: { level_5: 0 } },
    { id: "basic", category: "基本要求", name: "基础知识", blueprintVersionId: "v", weights: { level_5: 100 } },
  ]).get("level_5")!;
  assert.deepEqual(plan.basic.map((quota) => [quota.sourceId, quota.count]), [["2.2.1", 50], ["2.2.2", 150]]);
});

test("公共标准配额保留完整祖先路径，缺失和重复权重不能开始生成", () => {
  const basic = parseStandardBasicItems("2. 基本要求\n2.1 基础知识\n2.1.1 管理知识\n2.1.1.1 资料分类\n3. 工作要求")
    .map((item) => ({ ...item, blueprintVersionId: "v", fileObjectId: "f", sourceVersionId: null }));
  assert.deepEqual(basic[0].ancestorNames, ["基本要求", "基础知识", "管理知识"]);
  const weight = { id: "basic", category: "基本要求", name: "基础知识", blueprintVersionId: "v", weights: { level_5: 100 } };
  assert.equal(planStandardQuotas(basic, [], ["level_5"], [weight]).get("level_5")!.basic[0].count, 200);
  assert.throws(() => planStandardQuotas(basic, [], ["level_5"], []), /缺少/);
  assert.throws(() => planStandardQuotas(basic, [], ["level_5"], [weight, weight]), /重复/);
  assert.throws(() => planStandardQuotas(basic, [], ["level_5"], [{ ...weight, name: "职业道德" }]), /标准公共基本条目/);
});
