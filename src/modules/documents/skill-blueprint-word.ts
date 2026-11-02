import {
  AlignmentType,
  BorderStyle,
  Document,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  WidthType,
} from "docx";

type StructureRow = {
  code: string;
  name: string;
  selection: string | null;
  score: number | null;
  minutes: number | null;
  method: string | null;
};

type OutlineRow = {
  code: string;
  name: string;
  importance: string | null;
  requirement: unknown;
  questionCount: number;
};

const border = { style: BorderStyle.SINGLE, size: 4, color: "000000" };

function record(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function text(value: unknown, fallback = "待核对") {
  return value === null || value === undefined || value === "" ? fallback : String(value);
}

function cell(value: string, bold = false, shade?: string) {
  return new TableCell({
    shading: shade ? { fill: shade } : undefined,
    borders: { top: border, bottom: border, left: border, right: border },
    children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: value, bold, font: "宋体", size: 21 })],
    })],
  });
}

function table(headers: string[], rows: string[][], widths: number[]) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    rows: [
      new TableRow({ tableHeader: true, children: headers.map((item) => cell(item, true, "D9E1F2")) }),
      ...rows.map((row) => new TableRow({ children: row.map((item) => cell(item)) })),
    ],
    columnWidths: widths,
  });
}

function document(title: string, subtitle: string, children: Array<Paragraph | Table>) {
  return new Document({
    title,
    styles: { default: { document: {
      run: { font: { eastAsia: "宋体", ascii: "Times New Roman" }, size: 21 },
      paragraph: { spacing: { after: 140, line: 300 } },
    } } },
    sections: [{
      properties: { page: { margin: { top: 1100, bottom: 1100, left: 1000, right: 1000 } } },
      children: [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 220 },
          children: [new TextRun({ text: title, bold: true, font: "黑体", size: 32 })],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 260 },
          children: [new TextRun({ text: subtitle, font: "宋体", size: 21 })],
        }),
        ...children,
      ],
    }],
  });
}

export async function createSkillStructureWord(input: {
  occupationName: string;
  levelLabel: string;
  pathway: string | null;
  totalMinutes: number | null;
  rows: StructureRow[];
}) {
  const rows = input.rows.map((row) => [
    row.code,
    row.name,
    row.selection === "required" ? "必考" : row.selection === "optional" ? "选考" : text(row.selection),
    row.score === null ? "待核对" : String(row.score),
    row.minutes === null ? "待核对" : String(row.minutes),
    text(row.method),
  ]);
  rows.push(["合计", input.pathway || "待核对", "—", "100", input.totalMinutes === null ? "待核对" : String(input.totalMinutes), "—"]);
  return Packer.toBuffer(document(
    "操作技能考核内容结构表",
    `职业：${input.occupationName}    等级：${input.levelLabel}`,
    [table(["考评要求", "考评范围", "选考方式", "鉴定比重(%)", "考试时间(min)", "考核方式"], rows, [1300, 3000, 1400, 1500, 1600, 2200])],
  ));
}

export async function createSkillOutlineWord(input: {
  occupationName: string;
  levelLabel: string;
  rows: OutlineRow[];
}) {
  const rows = input.rows.map((item) => {
    const requirement = record(item.requirement);
    return [
      text(requirement.primaryNo ?? requirement.level1Code),
      text(requirement.primaryName ?? requirement.level1Name),
      text(requirement.primaryWeight ?? requirement.level1Weight),
      text(requirement.secondaryNo ?? requirement.level2Code),
      text(requirement.secondaryName ?? requirement.level2Name),
      text(requirement.secondaryWeight ?? requirement.level2Weight),
      requirement.selection === "required" ? "必考" : requirement.selection === "optional" ? "选考" : text(requirement.selection),
      item.code.match(/(?:^|-)(\d+)$/)?.[1] ?? item.code,
      item.name,
      text(requirement.importanceCode ?? item.importance),
      item.questionCount ? String(item.questionCount) : "待核对",
    ];
  });
  return Packer.toBuffer(document(
    "操作技能鉴定要素细目表",
    `职业：${input.occupationName}    等级：${input.levelLabel}    鉴定方式：技能操作`,
    [table(
      ["一级", "名称", "鉴定比重", "二级", "名称", "鉴定比重", "选考方式", "序号", "评价点", "重要程度", "题量"],
      rows,
      [650, 1300, 900, 650, 1500, 900, 1100, 650, 3000, 900, 700],
    )],
  ));
}
