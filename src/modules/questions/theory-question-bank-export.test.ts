import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { buildTheoryQuestionBankWorkbook } from "./theory-question-bank-export";

test("理论知识题库导出按导入模板输出列结构、题型和样式", async () => {
  const workbook = buildTheoryQuestionBankWorkbook([
    {
      pointCode: "A-A-A-001",
      questionType: "单项选择题",
      difficulty: null,
      alignment: null,
      stem: "职业道德是从业人员在职业活动中应该遵循的（ ）。",
      contentJson: { options: [
        { key: "A", content: "道德规范" },
        { key: "B", content: "行为准则" },
        { key: "C", content: "规章制度" },
        { key: "D", content: "基本要求" },
      ] },
      answerJson: { answers: ["B"] },
      analysisText: "依据职业道德定义判断。",
      scoreRubricJson: null,
    },
    {
      pointCode: "A-A-A-004",
      questionType: "判断题",
      difficulty: "hard",
      alignment: "partially_aligned",
      stem: "纪律不是一种行为规范，它只是介于法律和道德之间的一种特殊的规范。",
      contentJson: { options: [] },
      answerJson: { answers: ["错误"] },
      analysisText: "",
      scoreRubricJson: null,
    },
  ]);
  const bytes = await workbook.xlsx.writeBuffer();
  const restored = new ExcelJS.Workbook();
  await restored.xlsx.load(bytes);
  const sheet = restored.worksheets[0];
  const headerValues = Array.from({ length: 11 }, (_, index) => sheet.getRow(1).getCell(index + 1).value);

  assert.equal(sheet.name, "Sheet1");
  assert.deepEqual(headerValues, ["编号", "难易度", "一致性", "题型", "题干", "A", "B", "C", "D", "答案", "评分标准"]);
  assert.equal(sheet.getColumn(1).width, 13.57);
  assert.equal(sheet.getColumn(5).width, 46.78);
  assert.equal(sheet.getColumn(11).width, 14.66);

  assert.equal(sheet.getCell("A2").value, "A-A-A-001");
  assert.equal(sheet.getCell("B2").value, "3");
  assert.equal(sheet.getCell("C2").value, "5");
  assert.equal(sheet.getCell("D2").value, "单项选择");
  assert.equal(sheet.getCell("F2").value, "道德规范");
  assert.equal(sheet.getCell("I2").value, "基本要求");
  assert.equal(sheet.getCell("J2").value, "B");
  assert.equal(sheet.getCell("K2").value, "依据职业道德定义判断。");

  assert.equal(sheet.getCell("A3").value, "A-A-A-004");
  assert.equal(sheet.getCell("B3").value, "4");
  assert.equal(sheet.getCell("C3").value, "3");
  assert.equal(sheet.getCell("D3").value, "判断题");
  assert.equal(sheet.getCell("F3").value, "");
  assert.equal(sheet.getCell("I3").value, "");
  assert.equal(sheet.getCell("J3").value, "错误");

  assert.equal(sheet.getCell("A2").numFmt, "@");
  assert.equal(sheet.getCell("E2").alignment?.horizontal, "left");
  assert.equal(sheet.getCell("K2").alignment?.horizontal, "left");
  assert.equal(sheet.getCell("A2").border?.top?.style, "thin");
  assert.equal(sheet.getCell("A1").font?.bold, true);
  assert.equal(sheet.getCell("A1").font?.name, "宋体");
});

test("理论知识题库导出优先写评分标准，没有评分标准时回退解析", async () => {
  const workbook = buildTheoryQuestionBankWorkbook([{
    pointCode: "B-D-A-006",
    questionType: "多项选择题",
    difficulty: "easy",
    alignment: "aligned",
    stem: "以下属于正确指导中级美容师方法的是（ ）。",
    contentJson: { options: [
      { key: "A", content: "正确示范" },
      { key: "B", content: "互相检查" },
      { key: "C", content: "请顾客谈感受" },
      { key: "D", content: "利用多媒体手段辅助培训及指导" },
    ] },
    answerJson: { answers: ["A", "B", "C", "D"] },
    analysisText: "不应走到解析回退。",
    scoreRubricJson: { criteria: [
      { item: "答案", score: 4, standard: "全对得4分" },
      { item: "漏选", score: 0, standard: "漏选不得分" },
    ] },
  }]);
  const restored = new ExcelJS.Workbook();
  await restored.xlsx.load(await workbook.xlsx.writeBuffer());
  const sheet = restored.worksheets[0];

  assert.equal(sheet.getCell("B2").value, "2");
  assert.equal(sheet.getCell("C2").value, "5");
  assert.equal(sheet.getCell("D2").value, "多项选择");
  assert.equal(sheet.getCell("J2").value, "ABCD");
  assert.match(String(sheet.getCell("K2").value ?? ""), /答案 4分 全对得4分/);
  assert.doesNotMatch(String(sheet.getCell("K2").value ?? ""), /不应走到解析回退/);
});
