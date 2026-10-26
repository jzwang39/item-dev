import { AlignmentType, Document, Footer, Packer, PageNumber, Paragraph, TextRun } from "docx";

export type PaperWordItem = {
  item_no: number; section_no: number; question_type: string; stem_snapshot: string;
  content_snapshot_json: unknown; answer_snapshot_json: unknown; score_rubric_snapshot_json: unknown; score: number | string;
};
export type PaperWord = {
  title: string; paper_no: string; occupation_name: string; level_code: string;
  assessment_mode: string; duration_minutes: number; items: PaperWordItem[];
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
  const rubric = lines(decode(item.score_rubric_snapshot_json)).filter(Boolean);
  if (rubric.length) return rubric;
  if (/选|判断/.test(item.question_type)) return [`答案完全正确得 ${item.score} 分，错答、漏答不得分。`];
  return ["本题未保存评分标准，请补充并审核评分标准后使用。"];
}
export async function createPaperWord(paper: PaperWord, kind: "paper" | "answers") {
  if (!paper.items.length) throw new Error("试卷没有题目，不能下载空白试卷。");
  const levels: Record<string, string> = { level_5: "五级/初级工", level_4: "四级/中级工", level_3: "三级/高级工", level_2: "二级/技师", level_1: "一级/高级技师" };
  const paragraph = (text: string, bold = false) => new Paragraph({
    children: [new TextRun({ text, bold })], spacing: { after: 140, line: 360 },
  });
  const children: Paragraph[] = [
    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `${paper.title}${kind === "answers" ? " · 答案及评分标准" : ""}`, bold: true, size: 32 })], spacing: { after: 280 } }),
    paragraph(`${paper.occupation_name} · ${levels[paper.level_code] ?? paper.level_code} · ${paper.assessment_mode === "theory" ? "理论知识" : "操作技能"}`),
    paragraph(`试卷编号：${paper.paper_no}　考试时间：${paper.duration_minutes} 分钟　共 ${paper.items.length} 题 / ${paper.items.reduce((sum, item) => sum + Number(item.score), 0)} 分`),
  ];
  if (kind === "paper") children.push(paragraph("姓名：________________　准考证号：________________"));
  let section: number | undefined;
  for (const item of paper.items) {
    if (item.section_no !== section) {
      section = item.section_no;
      children.push(paragraph(`第 ${section} 部分 · ${item.question_type}`, true));
    }
    if (kind === "paper") {
      children.push(paragraph(`${item.item_no}. ${item.stem_snapshot}（${item.score} 分）`));
      const options = record(item.content_snapshot_json).options;
      if (Array.isArray(options)) for (const option of options) {
        const data = record(option);
        children.push(paragraph(`${data.key ?? ""}. ${data.text ?? data.content ?? ""}`));
      }
      if (!/选/.test(item.question_type)) children.push(paragraph(/判断/.test(item.question_type) ? "判断：（　　）" : "答：\n\n\n"));
    } else {
      children.push(paragraph(`第 ${item.item_no} 题 · ${item.question_type} · ${item.score} 分`, true));
      children.push(paragraph(`参考答案：${answerText(item.answer_snapshot_json) || "未保存参考答案"}`));
      children.push(paragraph("评分标准："));
      children.push(...scoringText(item).map((text) => paragraph(text)));
    }
  }
  return Packer.toBuffer(new Document({
    styles: { default: { document: { run: { font: "黑体", size: 24, color: "000000" } } } },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun("第 "), new TextRun({ children: [PageNumber.CURRENT] }), new TextRun(" 页")] })] }) },
      children,
    }],
  }));
}
