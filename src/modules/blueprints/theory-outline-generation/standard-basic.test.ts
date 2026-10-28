import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseStandardBasicItems } from "./standard-basic";
import { generateStandardOutlines } from "./textbook-generation";
import type { StandardKnowledge } from "./textbook-generation";

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

test("无教材公共基本条目只生成一次，按等级绑定知识要求，不传教材或权重", async () => {
  const levels = ["level_5", "level_4", "level_3"];
  const basic = parseStandardBasicItems("2. 基本要求\n2.1 职业道德\n2.1.1 道德基本知识\n2.1.2 职业守则\n3. 工作要求")
    .map((item) => ({ ...item, blueprintVersionId: "version", fileObjectId: "file", sourceVersionId: "source" }));
  const knowledge: StandardKnowledge[] = levels.map((levelCode) => ({
    id: levelCode, levelCode, functionCode: "1", functionName: "公益宣讲", contentCode: "1.1",
    contentName: "理念宣传", code: "1.1.1", name: "公益理念", evidence: "公益理念",
    blueprintVersionId: "version", fileObjectId: "file", sourceVersionId: "source",
  }));
  knowledge.push({ ...knowledge[1], id: "extra", code: "1.1.2", name: "传播方法" });
  let calls = 0;
  const result = await generateStandardOutlines("劝募员", basic, knowledge, levels, async (_instruction, prompt) => {
    calls++;
    assert.ok(!prompt.includes("章节记录"));
    assert.ok(!prompt.includes("权重"));
    assert.equal(JSON.parse(prompt).本来源总目标数, 2);
    return '{"points":[{"name":"知识的基本含义","importance":"X"},{"name":"知识的适用条件","importance":"Y"}]}';
  }, async () => {});
  assert.equal(calls, 6);
  assert.deepEqual(levels.map((level) => result.get(level)!.length), [6, 8, 6]);
  for (const level of levels) {
    assert.deepEqual(result.get(level)!.slice(0, 4), result.get("level_5")!.slice(0, 4));
    assert.ok(result.get(level)!.slice(0, 4).every((point) => point.standardBasicSource?.fileObjectId === "file" && point.sourceChapterIds.length === 0));
    assert.ok(result.get(level)!.slice(4).every((point) => point.standardSource?.levelCode === level));
  }
});

test("无教材任一等级失败拒绝整个结果，不能跳过条目凑数", async () => {
  const basic = [{ code: "2.1", name: "基础知识", category: "基本要求", parentName: "基本要求", evidence: "知识", blueprintVersionId: "v", fileObjectId: "f", sourceVersionId: null }];
  const item: StandardKnowledge = { id: "1", levelCode: "level_5", functionCode: "1", functionName: "宣讲", contentCode: "1.1", contentName: "宣传", code: "1.1.1", name: "理念", evidence: "理念", blueprintVersionId: "v", fileObjectId: "f", sourceVersionId: null };
  await assert.rejects(generateStandardOutlines("劝募员", basic, [item], ["level_5"], async (_instruction, prompt) =>
    JSON.parse(prompt).依据.相关知识要求 ? '{"points":[]}' : '{"points":[{"name":"知识定义"},{"name":"知识应用"}]}',
  async () => {}), /连续6次/);
});
