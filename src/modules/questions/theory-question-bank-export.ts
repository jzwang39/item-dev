import ExcelJS from "exceljs";

type QuestionOption = { key?: string; content?: string; text?: string };
type TheoryQuestionExportRow = {
  questionNo: string;
  questionType: string;
  difficulty: "easy" | "medium" | "hard" | null;
  alignment: "aligned" | "partially_aligned" | "not_aligned" | null;
  stem: string;
  contentJson: unknown;
  answerJson: unknown;
  analysisText: string | null;
  scoreRubricJson: unknown;
};

function parseJson(value: unknown) {
  if (typeof value !== "string") return value ?? {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function parseObject(value: unknown) {
  const parsed = parseJson(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function parseOptions(value: unknown) {
  const content = parseObject(value);
  const options = Array.isArray(content.options) ? content.options : [];
  const byKey = new Map<string, string>();
  for (const option of options) {
    const data = option && typeof option === "object" ? option as QuestionOption : {};
    const key = String(data.key ?? "").trim().toUpperCase();
    const text = String(data.content ?? data.text ?? "").trim();
    if (key && text && !byKey.has(key)) byKey.set(key, text);
  }
  return byKey;
}

function parseAnswers(value: unknown) {
  const data = parseObject(value);
  const answers = Array.isArray(data.answers) ? data.answers : [];
  return answers.map((item) => String(item).trim()).filter(Boolean);
}

function normalizeType(value: string) {
  if (/单.*选/.test(value)) return "单项选择";
  if (/多.*选/.test(value)) return "多项选择";
  if (/判断/.test(value)) return "判断题";
  return value.trim();
}

function difficultyScore(value: TheoryQuestionExportRow["difficulty"]) {
  if (value === "easy") return "2";
  if (value === "hard") return "4";
  return "3";
}

function alignmentScore(value: TheoryQuestionExportRow["alignment"]) {
  if (value === "not_aligned") return "1";
  if (value === "partially_aligned") return "3";
  return "5";
}

function scoringStandardText(row: TheoryQuestionExportRow) {
  const rubric = parseObject(row.scoreRubricJson);
  if (Array.isArray(rubric.criteria) && rubric.criteria.length) {
    return rubric.criteria
      .map((item) => {
        const criterion = item && typeof item === "object" ? item as Record<string, unknown> : {};
        const label = String(criterion.item ?? "").trim();
        const score = criterion.score == null ? "" : `${criterion.score}分`;
        const standard = String(criterion.standard ?? "").trim();
        return [label, score, standard].filter(Boolean).join(" ");
      })
      .filter(Boolean)
      .join("\n");
  }
  return String(row.analysisText ?? "").trim();
}

const headerBorder = {
  top: { style: "thin" as const },
  bottom: { style: "thin" as const },
  left: { style: "thin" as const },
  right: { style: "thin" as const },
};

function styleCell(cell: ExcelJS.Cell, header = false, left = false) {
  cell.font = { name: "宋体", size: header ? 12 : 11, bold: header };
  cell.alignment = { horizontal: left ? "left" : "center", vertical: "middle", wrapText: true };
  cell.border = headerBorder;
  cell.numFmt = "@";
}

export function buildTheoryQuestionBankWorkbook(rows: TheoryQuestionExportRow[]) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "技能人才评价国家题库智能命题平台";
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.columns = [
    { header: "编号", key: "code", width: 13.57 },
    { header: "难易度", key: "difficulty", width: 10.78 },
    { header: "一致性", key: "alignment", width: 10.78 },
    { header: "题型", key: "type", width: 13.74 },
    { header: "题干", key: "stem", width: 46.78 },
    { header: "A", key: "A", width: 15.63 },
    { header: "B", key: "B", width: 15.63 },
    { header: "C", key: "C", width: 15.63 },
    { header: "D", key: "D", width: 16.85 },
    { header: "答案", key: "answer", width: 10.45 },
    { header: "评分标准", key: "rubric", width: 14.66 },
  ];

  const header = sheet.getRow(1);
  header.height = 20;
  header.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
    styleCell(cell, true, columnNumber === 5);
  });

  rows.forEach((row) => {
    const options = parseOptions(row.contentJson);
    const line = sheet.addRow({
      code: row.questionNo,
      difficulty: difficultyScore(row.difficulty),
      alignment: alignmentScore(row.alignment),
      type: normalizeType(row.questionType),
      stem: row.stem.trim(),
      A: options.get("A") ?? "",
      B: options.get("B") ?? "",
      C: options.get("C") ?? "",
      D: options.get("D") ?? "",
      answer: parseAnswers(row.answerJson).join(""),
      rubric: scoringStandardText(row),
    });
    line.height = 18;
    line.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
      styleCell(cell, false, columnNumber === 5 || columnNumber === 11);
    });
  });

  return workbook;
}
