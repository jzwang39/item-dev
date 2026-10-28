import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { extractRawText } from "mammoth";
import JSZip from "jszip";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PaperSamplePreview } from "@/components/assembly/paper-sample-preview";
import { createPaperWord, type PaperWord } from "./paper-word";
import { paperFormat, paperItemContent, sectionInstruction, skillDisplay } from "./paper-presentation";

const theory: PaperWord = {
  title: "理论知识排版验证（非正式考试试卷）", paper_no: "FORMAT-THEORY-1", occupation_name: "劝募员",
  level_code: "level_5", assessment_mode: "theory", duration_minutes: 120,
  items: Array.from({ length: 100 }, (_, index) => ({
    item_no: index + 1, section_no: index < 80 ? 1 : 2, question_type: index < 80 ? "单项选择题" : "判断题",
    stem_snapshot: index < 80 ? "整理捐赠资料时，应采用哪种工作方式？" : "捐赠资料应分类登记并妥善保管。",
    content_snapshot_json: { options: index < 80 ? ["分类登记", "随意丢弃", "不予核对", "任意涂改"].map((text, i) => ({ key: "ABCD"[i], text })) : [] },
    answer_snapshot_json: { answers: [index < 80 ? "A" : "正确"] }, score_rubric_snapshot_json: null, score: 1,
  })),
};
const skill: PaperWord = {
  title: "操作技能排版验证（非正式考试试卷）", paper_no: "FORMAT-SKILL-1", occupation_name: "劝募员",
  level_code: "level_4", assessment_mode: "skill", duration_minutes: 90, items: [
    { item_no: 1, section_no: 1, question_type: "实操题", score: 30,
      stem_snapshot: "现提供一组模拟捐赠资料，请核对资料完整性，建立分类登记表，并提交资料整理结果。",
      content_snapshot_json: { assemblyPresentation: { evaluationPoint: "核对并整理捐赠资料", skillExam: {} } },
      answer_snapshot_json: { answers: ["核验资料完整性", "分类登记并提交结果"] },
      score_rubric_snapshot_json: { totalScore: 30, criteria: [
        { item: "资料核验", score: 10, standard: "资料项目核对完整，缺项按已审定标准扣分" },
        { item: "分类登记", score: 20, standard: "分类清晰，登记内容与模拟资料一致" },
      ] },
    },
    { item_no: 2, section_no: 2, question_type: "实操题", score: 70,
      stem_snapshot: "现提供一组模拟项目信息，请编制宣讲提纲，完成模拟宣讲并提交书面提纲。",
      content_snapshot_json: { assemblyPresentation: { evaluationPoint: "宣讲公益项目", skillExam: {
        minutes: 20, method: "模拟操作", venuePreparation: "提供模拟项目材料和独立宣讲工位", candidatePreparation: "自备书写工具",
        veto: "该题已审定否定项：不得篡改模拟材料数据。",
      } } },
      answer_snapshot_json: { answers: ["编制宣讲提纲", "完成模拟宣讲并提交提纲"] },
      score_rubric_snapshot_json: { totalScore: 70, criteria: [{ item: "宣讲实施", score: 70, standard: "宣讲内容覆盖模拟材料，成果完整" }] },
    },
  ],
};
async function inspect(paper: PaperWord, kind: "paper" | "answers") {
  const buffer = await createPaperWord(paper, kind);
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file("word/document.xml")!.async("string");
  const text = (await extractRawText({ buffer })).value;
  return { buffer, zip, xml, text };
}

test("理论样例动态题号、配分、注意事项、得分表、密封栏和编码总页数", async () => {
  const result = await inspect(theory, "paper");
  for (const text of ["职业技能等级认定", "劝募员五级/初级工理论知识试卷", "注   意   事   项", "评分人",
    "第1题～第80题", "满分80分", "第81题～第100题", "满分20分"]) assert.ok(result.text.includes(text), text);
  assert.ok(!result.text.includes("2006年"));
  assert.ok(!result.text.includes("家政服务员"));
  assert.ok(!result.text.includes("参考答案"));
  const header = await result.zip.file("word/header1.xml")!.async("string");
  assert.match(header, /wp:anchor/);
  assert.match(header, /behindDoc="1"/);
  assert.match(header, /准考证号/);
  assert.ok(Object.keys(result.zip.files).some((name) => name.startsWith("word/media/") && name.endsWith(".png")));
  const footer = await result.zip.file("word/footer1.xml")!.async("string");
  assert.match(footer, /试卷编码/);
  assert.match(footer, /NUMPAGES/);
});
test("技能考生卷按准备要求和考核试题输出，不泄漏参考步骤或评分表", async () => {
  const result = await inspect(skill, "paper");
  for (const text of ["评价点：核对并整理捐赠资料", "试题1.核对并整理捐赠资料", "1.准备要求", "考场准备",
    "考生准备", "2.考核试题", "具体考核要求", "否定项说明", "未保存单题考核时间", "20分钟", "自备书写工具"]) assert.ok(result.text.includes(text), text);
  for (const text of ["3.配分与评分标准", "分类登记并提交结果", "资料项目核对完整", "《慈善法》", "25min"]) assert.ok(!result.text.includes(text), text);
  assert.match(result.xml, /pageBreakBefore/);
  assert.match(result.xml, /w:top="1440"/);
  assert.match(result.xml, /w:left="1800"/);
  assert.match(await result.zip.file("word/styles.xml")!.async("string"), /仿宋/);
});
test("技能评分文件完整七列表格、重复表头、合计、否定项及参考步骤", async () => {
  const result = await inspect(skill, "answers");
  for (const text of ["3.配分与评分标准", "序号", "考核内容", "考核要点", "配分", "评分标准（细化可操作扣分标准）",
    "扣分", "得分", "合计", "参考答案", "分类登记并提交结果"]) assert.ok(result.text.includes(text), text);
  assert.match(result.xml, /tblHeader/);
  assert.equal((result.xml.match(/<w:tblGrid>/g) ?? []).length, 2);
  assert.match(result.xml, /gridSpan w:val="5"/);
});
test("冻结样式与元数据优先于可修改计划；未知或串用模板拒绝", async () => {
  const result = await inspect({ ...theory, items: [skill.items[0]], presentation: {
    format: paperFormat("skill"), occupationName: "冻结职业", levelCode: "level_4", assessmentMode: "skill", durationMinutes: 90,
  } }, "paper");
  assert.ok(result.text.includes("冻结职业四级/中级工操作技能试卷"));
  assert.ok(!result.text.includes("注   意   事   项"));
  await assert.rejects(createPaperWord({ ...skill, presentation: {
    format: paperFormat("theory"), occupationName: "劝募员", levelCode: "level_4", assessmentMode: "skill", durationMinutes: 90,
  } }, "paper"), /样式与考核方式不匹配/);
});
test("历史题目只从冻结版本关联补评价点，不把题目配分当成考核时间", () => {
  const content = paperItemContent({ content_snapshot_json: {}, assessment_point_names: '["资料整理","资料整理"]' });
  const display = skillDisplay({ item_no: 1, stem_snapshot: "完整任务", content_snapshot_json: content });
  assert.equal(display.title, "资料整理");
  assert.match(display.time, /待核对/);
  assert.match(display.veto, /不擅自设定零分/);
  assert.match(sectionInstruction([{ item_no: 1, score: 16.66, question_type: "实操题" }, { item_no: 2, score: 16.67, question_type: "实操题" }], 1), /各题分值见题目.*33.33分/);
});
test("历史技能评分与配分不一致时阻止评分表输出，不伪造合计或改写历史", async () => {
  const mismatch = { ...skill, items: [{ ...skill.items[0], score: 25 }] };
  await assert.rejects(createPaperWord(mismatch, "answers"), /评分标准总分与试卷配分不一致/);
  await createPaperWord(mismatch, "paper");
});
test("网页样例预览默认考生卷无答案，评分视图与Word结构一致", () => {
  const paper = renderToStaticMarkup(React.createElement(PaperSamplePreview, { paper: skill, kind: "paper" }));
  assert.match(paper, /1.准备要求/);
  assert.match(paper, /2.考核试题/);
  assert.doesNotMatch(paper, /3.配分与评分标准|分类登记并提交结果/);
  const answers = renderToStaticMarkup(React.createElement(PaperSamplePreview, { paper: skill, kind: "answers" }));
  assert.match(answers, /考核要点/);
  assert.match(answers, /分类登记并提交结果/);
});
test("可选原件一致性检查及临时DOCX输出", { skip: process.env.RUN_PAPER_REFERENCE_CHECK !== "1" }, async () => {
  for (const mode of ["theory", "skill"]) {
    const format = paperFormat(mode);
    const source = await readFile(join(process.cwd(), "docs/测试真实数据", format.sampleName));
    assert.equal(createHash("sha256").update(source).digest("hex"), format.sampleSha256);
  }
  if (process.env.PAPER_FORMAT_OUTPUT_DIR) {
    for (const [name, data, kind] of [
      ["theory-paper.docx", theory, "paper"], ["theory-answers.docx", theory, "answers"],
      ["skill-paper.docx", skill, "paper"], ["skill-answers.docx", skill, "answers"],
    ] as const) await writeFile(join(process.env.PAPER_FORMAT_OUTPUT_DIR, name), await createPaperWord(data, kind));
  }
});
