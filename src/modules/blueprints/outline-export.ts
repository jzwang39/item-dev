import ExcelJS from "exceljs";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { withTransaction } from "@/shared/database/mysql";
import { createUlid } from "@/shared/database/ulid";
import { assertOutlineConfirmed } from "./point-review";
import { codeFor } from "./theory-outline-generation/node-code";

export type ExportPoint = {
  code: string; name: string; importance: string | null; requirement: unknown;
};
type CellValue = string | number;
type OutlineWorkbookOptions = { normalizeTheoryHierarchy?: boolean };
type DisplayHierarchy = {
  primaryNo: string;
  primaryName: string;
  primaryWeight: CellValue;
  secondaryNo: string;
  secondaryName: string;
  secondaryWeight: CellValue;
  tertiaryNo: string;
  tertiaryName: string;
  tertiaryWeight: CellValue;
};
type TheoryDisplayCodes = {
  primary: Map<string, string>;
  secondary: Map<string, Map<string, string>>;
  tertiary: Map<string, Map<string, string>>;
};
function object(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown> : {};
}
function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
function weight(value: unknown): CellValue {
  if (value == null || value === "") return "";
  const number = Number(value);
  return Number.isFinite(number) ? number : text(value);
}

function stripDisplayPrefix(value: unknown) {
  return text(value)
    .replace(/^\s*\d+(?:\.\d+)*(?:\s*[.、．])?\s+/, "")
    .trim();
}

function scopedCode(groups: Map<string, Map<string, string>>, parentKey: string, key: string) {
  let values = groups.get(parentKey);
  if (!values) {
    values = new Map<string, string>();
    groups.set(parentKey, values);
  }
  return codeFor(values, key);
}

function theoryHierarchy(point: ExportPoint, index: number, codes: {
  primary: Map<string, string>;
  secondary: Map<string, Map<string, string>>;
  tertiary: Map<string, Map<string, string>>;
}): DisplayHierarchy {
  const r = object(point.requirement);
  const source = object(r.standardSource ?? r.sourceStandardRequirement);
  const rawPrimaryName = text(r.primaryName ?? r.level1Name);
  const rawSecondaryName = text(r.secondaryName ?? r.level2Name);
  const rawTertiaryName = text(r.tertiaryName ?? r.level3Name);
  const isRelated = text(r.sectionKind) === "related_knowledge" || /^相关知识要求/.test(rawPrimaryName);

  const primaryName = isRelated ? "相关知识要求" : stripDisplayPrefix(rawPrimaryName);
  const secondaryName = stripDisplayPrefix(
    isRelated
      ? (source.functionName ?? rawPrimaryName.replace(/^相关知识要求\s*[·.]\s*/, "").trim())
      : rawSecondaryName,
  );
  const tertiaryName = stripDisplayPrefix(
    isRelated
      ? (source.contentName ?? rawSecondaryName)
      : rawTertiaryName,
  );

  return {
    primaryNo: codeFor(codes.primary, primaryName || `primary-${index}`),
    primaryName,
    primaryWeight: isRelated ? weight(r.primaryWeight ?? r.level1Weight) : weight(r.primaryWeight ?? r.level1Weight),
    secondaryNo: scopedCode(codes.secondary, primaryName || `primary-${index}`, secondaryName || `secondary-${index}`),
    secondaryName,
    secondaryWeight: isRelated ? "" : weight(r.secondaryWeight ?? r.level2Weight),
    tertiaryNo: scopedCode(codes.tertiary, `${primaryName}|${secondaryName || `secondary-${index}`}`, tertiaryName || `tertiary-${index}`),
    tertiaryName,
    tertiaryWeight: isRelated ? "" : weight(r.tertiaryWeight ?? r.level3Weight),
  };
}

export function buildOutlineWorkbook(points: ExportPoint[], options: OutlineWorkbookOptions = {}) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("评价要素细目表", {
    views: [{ state: "frozen", ySplit: 1, showGridLines: false }],
    pageSetup: {
      margins: { left: 0.75, right: 0.75, top: 1, bottom: 1, header: 0.5, footer: 0.5 },
      printTitlesRow: "1:1",
    },
  });
  const headers = ["一级", "一级名称", "权重(%)", "二级序号", "二级名称", "权重(%)", "三级序号", "三级名称", "权重(%)", "考评点序号", "考评点名称", "重要程度"];
  const widths = [6, 16, 8, 8, 18, 8, 10, 26, 8, 9, options.normalizeTheoryHierarchy ? 49 : 38, 9];
  sheet.columns = widths.map((width) => ({ width }));
  sheet.addRow(headers);
  const displayCodes = {
    primary: new Map<string, string>(),
    secondary: new Map<string, Map<string, string>>(),
    tertiary: new Map<string, Map<string, string>>(),
  } satisfies TheoryDisplayCodes;
  const values = points.map((point, index): CellValue[] => {
    const r = object(point.requirement);
    // Use the version's stored hierarchy, not a newer weight table.
    const importance = ["X", "Y", "Z"].includes(text(r.importanceCode))
      ? text(r.importanceCode)
      : ({ critical: "X", high: "Y", medium: "Z", low: "Z" }[point.importance ?? ""] ?? "");
    const hierarchy = options.normalizeTheoryHierarchy
      ? theoryHierarchy(point, index, displayCodes)
      : {
        primaryNo: text(r.primaryNo ?? r.level1Code),
        primaryName: text(r.primaryName ?? r.level1Name),
        primaryWeight: weight(r.primaryWeight ?? r.level1Weight),
        secondaryNo: text(r.secondaryNo ?? r.level2Code),
        secondaryName: text(r.secondaryName ?? r.level2Name),
        secondaryWeight: weight(r.secondaryWeight ?? r.level2Weight),
        tertiaryNo: text(r.tertiaryNo ?? r.level3Code),
        tertiaryName: text(r.tertiaryName ?? r.level3Name),
        tertiaryWeight: weight(r.tertiaryWeight ?? r.level3Weight),
      };
    return [
      hierarchy.primaryNo, hierarchy.primaryName,
      hierarchy.primaryWeight,
      hierarchy.secondaryNo, hierarchy.secondaryName,
      hierarchy.secondaryWeight,
      hierarchy.tertiaryNo, hierarchy.tertiaryName,
      hierarchy.tertiaryWeight,
      point.code.match(/(?:^|-)(\d+)$/)?.[1] ?? point.code,
      point.name, importance,
    ];
  });
  for (const row of values) sheet.addRow(row);
  sheet.eachRow((row, index) => {
    row.height = index === 1 ? 26 : 18;
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = { name: "宋体", size: 11, bold: index === 1 };
      cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      const edge = { style: "thin" as const, color: { argb: "FF000000" } };
      cell.border = { top: edge, bottom: edge, left: edge, right: edge };
      if (index === 1) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9E1F2" } };
    });
  });
  const mergeGroups = [
    { columns: [1, 2], keyEnd: 2, allowEmpty: false },
    { columns: [3], keyEnd: 3, allowEmpty: true, anchorColumns: [1, 2] },
    { columns: [4, 5], keyEnd: 5, allowEmpty: false },
    { columns: [6], keyEnd: 6, allowEmpty: true, anchorColumns: [4, 5] },
    { columns: [7, 8], keyEnd: 8, allowEmpty: false },
    { columns: [9], keyEnd: 9, allowEmpty: true, anchorColumns: [7, 8] },
  ];
  for (const group of mergeGroups) {
    let start = 0;
    const key = (index: number) => JSON.stringify(values[index]?.slice(0, group.keyEnd));
    for (let end = 1; end <= values.length; end += 1) {
      if (end < values.length && key(start) === key(end)) continue;
      const hasTargetValue = group.columns.some((column) => values[start][column - 1] !== "");
      const hasAnchorValue = (group.anchorColumns ?? []).some((column) => values[start][column - 1] !== "");
      if (end - start > 1 && (hasTargetValue || (group.allowEmpty && hasAnchorValue))) {
        for (const column of group.columns) {
          sheet.mergeCells(start + 2, column, end + 1, column);
        }
      }
      start = end;
    }
  }
  sheet.pageSetup.printArea = `A1:L${points.length + 1}`;
  return workbook;
}

export async function exportConfirmedOutline(
  versionId: string, actorId: string, role: "admin" | "expert",
  transaction = withTransaction,
) {
  if (role !== "admin") throw new Error("仅管理员可导出已确认细目表。");
  return transaction(async (db: PoolConnection) => {
    const [versions] = await db.execute<(RowDataPacket & {
      projectId: string; occupationName: string; levelCode: string; assessmentMode: string; versionNo: number;
    })[]>(
      `SELECT b.project_id AS projectId,po.name AS occupationName,b.level_code AS levelCode,
        b.assessment_mode AS assessmentMode,v.version_no AS versionNo
       FROM blueprint_versions v JOIN blueprints b ON b.id=v.blueprint_id
       JOIN projects p ON p.id=b.project_id AND p.status='active'
       JOIN project_occupations po ON po.id=b.occupation_id AND po.status='active'
       WHERE v.id=? AND v.status<>'archived'
         AND b.blueprint_kind IN ('theory_outline','skill_outline') FOR UPDATE`, [versionId],
    );
    if (!versions.length) throw new Error("细目表版本不存在或已归档。");
    await assertOutlineConfirmed(db, versionId);
    const [points] = await db.execute<(RowDataPacket & ExportPoint)[]>(
      `SELECT node_code AS code,name,importance,requirement_json AS requirement
       FROM blueprint_nodes WHERE blueprint_version_id=? AND node_kind='assessment_point'
       ORDER BY ordinal,id`, [versionId],
    );
    const version = versions[0];
    const bytes = Buffer.from(await buildOutlineWorkbook(points, {
      normalizeTheoryHierarchy: version.assessmentMode === "theory",
    }).xlsx.writeBuffer());
    const level = ({ level_5: "五级", level_4: "四级", level_3: "三级", level_2: "二级", level_1: "一级" } as Record<string, string>)[version.levelCode] ?? version.levelCode;
    const mode = version.assessmentMode === "skill" ? "操作技能" : "理论知识";
    const filename = `评价要素细目表-${version.occupationName}${level}-${mode}-V${version.versionNo}.xlsx`.replace(/[/\\\r\n]/g, "_");
    await db.execute(
      `INSERT INTO audit_logs(id,project_id,actor_id,action,object_type,object_id,after_json,result)
       VALUES(?,?,?,'blueprint.outline.export','blueprint_version',?,?,'success')`,
      [createUlid(), version.projectId, actorId, versionId, JSON.stringify({ filename, versionNo: version.versionNo, pointCount: points.length })],
    );
    return { bytes, filename };
  });
}
