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
  VerticalAlignTable,
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

function structureName(value: string) {
  return value.replace(/\s*[A-Z]$/, "").trim();
}

function cell(value: string, options: {
  bold?: boolean;
  shade?: string;
  columnSpan?: number;
  rowSpan?: number;
  fontSize?: number;
} = {}) {
  return new TableCell({
    verticalAlign: VerticalAlignTable.CENTER,
    shading: options.shade ? { fill: options.shade } : undefined,
    columnSpan: options.columnSpan,
    rowSpan: options.rowSpan,
    borders: { top: border, bottom: border, left: border, right: border },
    children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: value, bold: options.bold, font: "宋体", size: options.fontSize ?? 21 })],
    })],
  });
}

function document(title: string, subtitle: string, children: Array<Paragraph | Table>, landscape = false) {
  return new Document({
    title,
    styles: { default: { document: {
      run: { font: { eastAsia: "宋体", ascii: "Times New Roman" }, size: 21 },
      paragraph: { spacing: { after: 140, line: 300 } },
    } } },
    sections: [{
      properties: { page: {
        size: landscape ? { width: 16840, height: 11906, orientation: "landscape" } : undefined,
        margin: { top: 760, bottom: 760, left: 720, right: 720 },
      } },
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
  headerGroups: Array<{ name: string; children: string[] }>;
}) {
  const value = (row: StructureRow, key: "selection" | "score" | "minutes" | "method") => {
    const raw = row[key];
    if (key === "selection") return raw === "required" ? "必考" : raw === "optional" ? "选考" : text(raw);
    return raw === null ? "待核对" : String(raw);
  };
  const groups = input.headerGroups.length
    ? input.headerGroups
    : input.rows.map((row) => ({ name: row.name, children: [row.name] }));
  const childCount = groups.reduce((sum, group) => sum + group.children.length, 0);
  const childWidths = groups.flatMap((group) =>
    group.children.map(() => Math.max(1100, Math.floor(12500 / Math.max(1, childCount)))),
  );
  const structureByName = new Map(input.rows.map((row) => [structureName(row.name), row]));
  const total = input.totalMinutes === null ? "待核对" : `${input.totalMinutes}min`;
  const valueCells = (key: "selection" | "score" | "minutes" | "method") => groups.map((group) => {
    const row = structureByName.get(structureName(group.name));
    return cell(row ? value(row, key) : "待核对", {
      columnSpan: group.children.length,
      fontSize: key === "method" ? 19 : undefined,
    });
  });
  const matrix = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    rows: [
      new TableRow({ tableHeader: true, children: [
        cell(`考评范围\n考评要求\n${input.levelLabel.split("/")[0]}`, { bold: true, shade: "D9E1F2", columnSpan: 2, rowSpan: 2 }),
        ...groups.map((group) => cell(group.name, { bold: true, shade: "D9E1F2", columnSpan: group.children.length })),
        cell("合计", { bold: true, shade: "D9E1F2", rowSpan: 2 }),
      ] }),
      new TableRow({ tableHeader: true, children: [
        ...groups.flatMap((group) => group.children.map((child) => cell(child, { bold: true, shade: "D9E1F2", fontSize: 19 }))),
      ] }),
      new TableRow({ children: [
        cell(input.levelLabel.split("/")[0], { bold: true, rowSpan: 4 }),
        cell("选考方式", { bold: true }),
        ...valueCells("selection"),
        cell("—"),
      ] }),
      new TableRow({ children: [
        cell("考核权重（%）", { bold: true }),
        ...valueCells("score"),
        cell("100"),
      ] }),
      new TableRow({ children: [
        cell("考核时间（min）", { bold: true }),
        ...valueCells("minutes"),
        cell(total),
      ] }),
      new TableRow({ children: [
        cell("考核形式", { bold: true }),
        ...valueCells("method"),
        cell("—"),
      ] }),
    ],
    columnWidths: [700, 1100, ...childWidths, 1100],
  });
  return Packer.toBuffer(document(
    `${input.occupationName}操作技能考评内容结构表（${input.levelLabel}）`,
    `技能考核路径：${input.pathway || "待核对"}`,
    [matrix], true,
  ));
}

export async function createSkillOutlineWord(input: {
  occupationName: string;
  levelLabel: string;
  rows: OutlineRow[];
}) {
  const items = input.rows.map((item) => {
    const requirement = record(item.requirement);
    return {
      primary: text(requirement.primaryName ?? requirement.level1Name),
      primaryWeight: text(requirement.primaryWeight ?? requirement.level1Weight),
      secondary: text(requirement.secondaryName ?? requirement.level2Name),
      secondaryWeight: text(requirement.secondaryWeight ?? requirement.level2Weight),
      selection: requirement.selection === "required" ? "必考" : requirement.selection === "optional" ? "选考" : text(requirement.selection),
      code: item.code.match(/(?:^|-)(\d+)$/)?.[1] ?? item.code,
      name: item.name,
      importance: text(requirement.importanceCode ?? item.importance),
      questionCount: item.questionCount ? String(item.questionCount) : "待核对",
    };
  });
  const span = (index: number, key: "primary" | "secondary") => {
    const value = items[index][key];
    let count = 1;
    for (let cursor = index + 1; cursor < items.length; cursor += 1) {
      if (items[cursor][key] !== value || (key === "secondary" && items[cursor].primary !== items[index].primary)) break;
      count += 1;
    }
    return count;
  };
  const rows = items.map((item, index) => {
    const startPrimary = index === 0 || items[index - 1].primary !== item.primary;
    const startSecondary = startPrimary || items[index - 1].secondary !== item.secondary;
    const cells: TableCell[] = [];
    if (startPrimary) {
      cells.push(cell(item.primary, { rowSpan: span(index, "primary") }));
      cells.push(cell(item.primaryWeight, { rowSpan: span(index, "primary") }));
    }
    if (startSecondary) {
      cells.push(cell(item.secondary, { rowSpan: span(index, "secondary") }));
      cells.push(cell(item.secondaryWeight, { rowSpan: span(index, "secondary") }));
    }
    if (startPrimary) cells.push(cell(item.selection, { rowSpan: span(index, "primary") }));
    cells.push(cell(item.code), cell(item.name, { fontSize: 19 }), cell(item.importance), cell(item.questionCount));
    return new TableRow({ children: cells });
  });
  const outline = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    rows: [
      new TableRow({ tableHeader: true, children: [
        cell("鉴定范围", { bold: true, shade: "D9E1F2", columnSpan: 5 }),
        cell("序号", { bold: true, shade: "D9E1F2", rowSpan: 2 }),
        cell("评 价 点", { bold: true, shade: "D9E1F2", rowSpan: 2 }),
        cell("重要程度", { bold: true, shade: "D9E1F2", rowSpan: 2 }),
        cell("题量", { bold: true, shade: "D9E1F2", rowSpan: 2 }),
      ] }),
      new TableRow({ tableHeader: true, children: [
        cell("一级名称", { bold: true, shade: "D9E1F2" }),
        cell("鉴定比重", { bold: true, shade: "D9E1F2" }),
        cell("二级名称", { bold: true, shade: "D9E1F2" }),
        cell("鉴定比重", { bold: true, shade: "D9E1F2" }),
        cell("选考方式", { bold: true, shade: "D9E1F2" }),
      ] }),
      ...rows,
    ],
    columnWidths: [1700, 900, 1700, 900, 1100, 750, 3400, 1000, 800],
  });
  return Packer.toBuffer(document(
    "操作技能鉴定要素细目表",
    `职业：${input.occupationName}    等级：${input.levelLabel}    鉴定方式：技能操作`,
    [outline], true,
  ));
}
