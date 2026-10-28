import {
  AlignmentType, BorderStyle, Document, Footer, Header, HorizontalPositionRelativeFrom, ImageRun, Packer, PageNumber, Paragraph,
  Table, TableCell, TableLayoutType, TableRow, TextRun, TextWrappingType, VerticalAlign, VerticalPositionRelativeFrom, WidthType,
} from "docx";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { chineseNumber, paperFormat, paperLevels, parseRecord, sectionInstruction, skillDisplay, type PaperPresentation } from "./paper-presentation";

export type PaperWordItem = {
  item_no: number; section_no: number; question_type: string; stem_snapshot: string;
  content_snapshot_json: unknown; answer_snapshot_json: unknown; score_rubric_snapshot_json: unknown; score: number | string;
};
export type PaperWord = {
  title: string; paper_no: string; occupation_name: string; level_code: string;
  assessment_mode: string; duration_minutes: number; items: PaperWordItem[];
  presentation?: PaperPresentation;
};

function decode(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}
function record(value: unknown): Record<string, unknown> {
  const parsed = decode(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}
function lines(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap(lines);
  if (typeof value === "object") return Object.entries(value).flatMap(([key, item]) => lines(item).map((text) => `${key}：${text}`));
  return [String(value)];
}
export function answerText(value: unknown) {
  const parsed = decode(value), data = record(value);
  return lines(data.answers ?? data.answer ?? parsed).join("、");
}
export function scoringText(item: PaperWordItem): string[] {
  const data = record(item.score_rubric_snapshot_json);
  if (Array.isArray(data.criteria) && typeof data.totalScore === "number") {
    return [
      `总分：${data.totalScore}分`,
      ...data.criteria.map((value) => {
        const criterion = record(value);
        return `${criterion.item ?? ""}：${criterion.score ?? ""}分；${criterion.standard ?? ""}`;
      }),
      ...(typeof data.scalingNote === "string" ? [data.scalingNote] : []),
    ];
  }
  const rubric = lines(decode(item.score_rubric_snapshot_json)).filter(Boolean);
  if (rubric.length) return rubric;
  if (/选|判断/.test(item.question_type)) return [`答案完全正确得 ${item.score} 分，错答、漏答不得分。`];
  return ["本题未保存评分标准，请补充并审核评分标准后使用。"];
}
export async function createPaperWord(paper: PaperWord, kind: "paper" | "answers") {
  if (!paper.items.length) throw new Error("试卷没有题目，不能下载空白试卷。");
  const frozen = paper.presentation;
  if (frozen) paper = { ...paper, occupation_name: frozen.occupationName, level_code: frozen.levelCode,
    assessment_mode: frozen.assessmentMode, duration_minutes: frozen.durationMinutes };
  const format = frozen?.format ?? paperFormat(paper.assessment_mode);
  if (format.id !== paperFormat(paper.assessment_mode).id) throw new Error("冻结试卷样式与考核方式不匹配，不能使用另一种模板下载。");
  if (paper.assessment_mode === "skill" && kind === "answers") for (const item of paper.items) {
    const rubric = parseRecord(item.score_rubric_snapshot_json);
    if (Array.isArray(rubric.criteria)) {
      const sum = rubric.criteria.reduce((total, value) => total + Number(parseRecord(value).score), 0);
      if (!Number.isFinite(sum) || !Number.isFinite(Number(rubric.totalScore)) ||
        Math.abs(sum - Number(item.score)) > 0.001 || Math.abs(Number(rubric.totalScore) - Number(item.score)) > 0.001) {
        throw new Error(`第${item.item_no}题评分项、评分标准总分与试卷配分不一致，请核对后下载；不自动改写历史评分。`);
      }
    }
  }
  const children = paper.assessment_mode === "skill" ? skillPaper(paper, kind) : theoryPaper(paper, kind);
  const margins = format.page;
  const seal = paper.assessment_mode === "theory" && kind === "paper" ? new Header({ children: [
    new Paragraph({ children: [new ImageRun({
      type: "png", data: await readFile(join(process.cwd(), "public/document-assets/theory-seal-v1.png")),
      transformation: { width: 80, height: (margins.height - margins.top - margins.bottom) / 15 },
      floating: {
        behindDocument: true, allowOverlap: true,
        horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, offset: 450 * 635 },
        verticalPosition: { relative: VerticalPositionRelativeFrom.PAGE, offset: margins.top * 635 },
        wrap: { type: TextWrappingType.NONE },
      },
      altText: { name: "密封栏", title: "试卷密封栏", description: "地区、姓名、单位名称、准考证号；考生答题不准超过此线" },
    })] }),
  ] }) : undefined;
  return Packer.toBuffer(new Document({
    title: paper.title, description: `组卷样式：${format.id}；样例SHA256：${format.sampleSha256}`,
    styles: { default: { document: {
      run: { font: { ascii: "Times New Roman", hAnsi: "Times New Roman", eastAsia: format.bodyFont }, size: format.bodySize, color: "000000" },
      paragraph: { spacing: { line: 312, after: paper.assessment_mode === "skill" ? 40 : 60 } },
    } } },
    sections: [{
      properties: { page: { size: { width: margins.width, height: margins.height },
        margin: { top: margins.top, bottom: margins.bottom, left: margins.left, right: margins.right, header: 500, footer: 650 } } },
      headers: seal ? { default: seal } : undefined,
      footers: { default: paperFooter(paper.paper_no) },
      children,
    }],
  }));
}

type Block = Paragraph | Table;
const paragraph = (text: string, bold = false, extra: { center?: boolean; size?: number; pageBreakBefore?: boolean; keepNext?: boolean } = {}) =>
  new Paragraph({
    alignment: extra.center ? AlignmentType.CENTER : AlignmentType.LEFT,
    pageBreakBefore: extra.pageBreakBefore, keepNext: extra.keepNext,
    children: text.split("\n").map((line, index) => new TextRun({ text: line, bold, size: extra.size, break: index ? 1 : undefined })),
  });
const cell = (text: string, options: { bold?: boolean; span?: number; center?: boolean; size?: number } = {}) =>
  new TableCell({ columnSpan: options.span, verticalAlign: VerticalAlign.CENTER,
    children: [paragraph(text, options.bold, { center: options.center ?? true, size: options.size })] });
const table = (rows: TableRow[], widths: number[]) => new Table({
  rows, columnWidths: widths, layout: TableLayoutType.FIXED,
  width: { size: widths.reduce((sum, value) => sum + value, 0), type: WidthType.DXA },
  margins: { top: 50, bottom: 50, left: 90, right: 90 },
  borders: Object.fromEntries(["top", "bottom", "left", "right", "insideHorizontal", "insideVertical"].map((key) => [key, { style: BorderStyle.SINGLE, size: 4, color: "000000" }])),
});
function paperFooter(code: string) {
  return new Footer({ children: [new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [
      new TextRun({ text: `试卷编码：${code}    第 `, size: 18 }),
      new TextRun({ children: [PageNumber.CURRENT], size: 18 }), new TextRun({ text: " 页  共 ", size: 18 }),
      new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 18 }), new TextRun({ text: " 页", size: 18 }),
    ],
  })] });
}
function summary(paper: PaperWord, kind: "paper" | "answers"): Block[] {
  const score = paper.items.reduce((sum, item) => sum + Math.round(Number(item.score) * 100), 0) / 100;
  return [
    paragraph("职业技能等级认定", false, { center: true, size: 30 }),
    paragraph(`${paper.occupation_name}${paperLevels[paper.level_code] ?? paper.level_code}${paper.assessment_mode === "skill" ? "操作技能" : "理论知识"}${kind === "answers" ? "答案及评分标准" : "试卷"}`, true, { center: true, size: 36 }),
    paragraph(`${paper.title}${kind === "answers" ? " · 答案及评分标准" : ""}`, false, { center: true, size: 21 }),
    paragraph(`考试时间：${paper.duration_minutes} 分钟　共 ${paper.items.length} 题 / ${score} 分`),
  ];
}
function theoryPaper(paper: PaperWord, kind: "paper" | "answers"): Block[] {
  const sections = [...new Set(paper.items.map((item) => item.section_no))].map((section) => paper.items.filter((item) => item.section_no === section));
  const children: Block[] = summary(paper, kind);
  if (kind === "paper") {
    children.push(paragraph("注   意   事   项", true, { center: true, size: 28 }),
      paragraph("1、本试卷由已入库试题组卷，依据资料及版本以组卷留痕记录为准。"),
      paragraph("2、请在试卷标封处填写地区、姓名、准考证号和所在单位名称。"),
      paragraph("3、请仔细阅读答题要求，在规定位置填写答案。"), paragraph(""));
    const width = Math.floor(8400 / (sections.length + 2));
    children.push(table([
      new TableRow({ children: [cell(""), ...sections.map((_, index) => cell(chineseNumber(index + 1))), cell("总  分")] }),
      new TableRow({ children: [cell("得  分"), ...sections.map(() => cell("")), cell("")] }),
    ], Array(sections.length + 2).fill(width)), paragraph(""));
  }
  sections.forEach((items, index) => {
    if (kind === "paper") children.push(table([new TableRow({ children: [cell("得  分"), cell(""), cell("评分人"), cell("")] })], [850, 1300, 1000, 1300]), paragraph(""));
    children.push(paragraph(sectionInstruction(items, index + 1), true, { keepNext: true }));
    for (const item of items) {
      if (kind === "paper") {
        const stem = /判断/.test(item.question_type) ? `${item.item_no}．（　　）${item.stem_snapshot}` : `${item.item_no}．${item.stem_snapshot}`;
        children.push(paragraph(`${stem}（${Number(item.score)}分）`));
        const options = parseRecord(item.content_snapshot_json).options;
        if (/选/.test(item.question_type) && Array.isArray(options)) {
          const text = options.map((option) => {
            const data = parseRecord(option);
            return `${data.key ?? ""}、${data.text ?? data.content ?? ""}`;
          });
          if (text.every((value) => value.length <= 16)) children.push(paragraph(`  ${text.join("    ")}`));
          else children.push(...text.map((value) => paragraph(`  ${value}`)));
        } else if (!/判断/.test(item.question_type)) children.push(paragraph("答：\n\n\n"));
      } else {
        children.push(paragraph(`第 ${item.item_no} 题 · ${item.question_type} · ${Number(item.score)} 分`, true),
          paragraph(`参考答案：${answerText(item.answer_snapshot_json) || "未保存参考答案"}`), paragraph("评分标准："),
          ...scoringText(item).map((text) => paragraph(text)));
      }
    }
  });
  return children;
}
function skillPaper(paper: PaperWord, kind: "paper" | "answers"): Block[] {
  const children: Block[] = summary(paper, kind);
  if (kind === "paper") children.push(paragraph("姓名：________________　准考证号：________________"));
  for (const [index, item] of paper.items.entries()) {
    const display = skillDisplay(item);
    children.push(
      paragraph(`评价点：${display.evaluationPoint}`, true, { size: 28, pageBreakBefore: index > 0, keepNext: true }),
      paragraph(`试题${item.item_no}.${display.title}`, true, { size: 28, keepNext: true }),
      paragraph("1.准备要求", false, { keepNext: true }),
    );
    for (const [label, preparation] of [["（1）考场准备：", display.venuePreparation], ["（2）考生准备：", display.candidatePreparation]]) {
      children.push(paragraph(label, false, { keepNext: true }), paragraph(`①试题名称：${display.title}`),
        paragraph(`②本题分值：${Number(item.score)}分`), paragraph(`③考核时间：${display.time}`),
        paragraph(`④考核形式：${display.method}`), paragraph(`⑤${label.includes("考场") ? "设备设施准备" : "工具及其他准备"}：${preparation}`));
    }
    children.push(paragraph("2.考核试题", false, { keepNext: true }),
      paragraph(`（1）本题分值：${Number(item.score)}分`), paragraph(`（2）考核时间：${display.time}`),
      paragraph(`（3）考核形式：${display.method}`), paragraph(`（4）具体考核要求：${display.requirements}`),
      paragraph(`（5）否定项说明：${display.veto}`));
    if (kind === "paper") { children.push(paragraph("答题与成果提交：\n\n\n")); continue; }
    children.push(paragraph("3.配分与评分标准", false, { keepNext: true }));
    const rubric = parseRecord(item.score_rubric_snapshot_json);
    const criteria = Array.isArray(rubric.criteria) ? rubric.criteria.map(parseRecord) : [];
    const rows = [
      new TableRow({ tableHeader: true, children: ["序号", "考核内容", "考核要点", "配分", "评分标准（细化可操作扣分标准）", "扣分", "得分"].map((text) => cell(text, { size: 18 })) }),
      ...criteria.map((criterion, ordinal) => new TableRow({ children: [
        cell(String(ordinal + 1), { size: 18 }), cell(String(criterion.item ?? ""), { center: false, size: 18 }),
        cell(typeof criterion.points === "string" ? criterion.points : "待核对（未单独保存考核要点）", { center: false, size: 18 }),
        cell(String(criterion.score ?? ""), { size: 18 }), cell(String(criterion.standard ?? ""), { center: false, size: 18 }), cell(""), cell(""),
      ] })),
      ...(!criteria.length ? [new TableRow({ children: [cell("评分标准", { span: 2 }), cell(scoringText(item).join("\n"), { span: 5, center: false })] })] : []),
      new TableRow({ children: [cell("合计", { span: 3 }), cell(String(Number(item.score))), cell(""), cell(""), cell("")] }),
      new TableRow({ children: [cell("否定项", { span: 2 }), cell(display.veto, { span: 5, center: false, size: 18 })] }),
    ];
    children.push(table(rows, [600, 1400, 1550, 650, 2450, 800, 850]));
    if (typeof rubric.scalingNote === "string") children.push(paragraph(rubric.scalingNote, false, { size: 18 }));
    children.push(paragraph("参考操作步骤 / 参考答案", true), paragraph(`参考答案：${answerText(item.answer_snapshot_json) || "未保存参考答案"}`));
  }
  return children;
}
