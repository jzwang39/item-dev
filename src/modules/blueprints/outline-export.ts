import ExcelJS from "exceljs";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { withTransaction } from "@/shared/database/mysql";
import { createUlid } from "@/shared/database/ulid";
import { assertOutlineConfirmed } from "./point-review";

export type ExportPoint = {
  code: string; name: string; importance: string | null; requirement: unknown;
};
type CellValue = string | number;
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

export function buildOutlineWorkbook(points: ExportPoint[]) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("评价要素细目表", {
    views: [{ state: "frozen", ySplit: 1, showGridLines: false }],
    pageSetup: {
      margins: { left: 0.75, right: 0.75, top: 1, bottom: 1, header: 0.5, footer: 0.5 },
      printTitlesRow: "1:1",
    },
  });
  const headers = ["一级", "一级名称", "权重(%)", "二级序号", "二级名称", "权重(%)", "三级序号", "三级名称", "权重(%)", "考评点序号", "考评点名称", "重要程度", "页码"];
  const widths = [6, 16, 8, 8, 18, 8, 10, 26, 8, 9, 38, 9, 11];
  sheet.columns = widths.map((width) => ({ width }));
  sheet.addRow(headers);
  const values = points.map((point): CellValue[] => {
    const r = object(point.requirement);
    // Use the version's stored hierarchy, not a newer weight table.
    const importance = ["X", "Y", "Z"].includes(text(r.importanceCode))
      ? text(r.importanceCode)
      : ({ critical: "X", high: "Y", medium: "Z", low: "Z" }[point.importance ?? ""] ?? "");
    return [
      text(r.primaryNo ?? r.level1Code), text(r.primaryName ?? r.level1Name),
      weight(r.primaryWeight ?? r.level1Weight),
      text(r.secondaryNo ?? r.level2Code), text(r.secondaryName ?? r.level2Name),
      weight(r.secondaryWeight ?? r.level2Weight),
      text(r.tertiaryNo ?? r.level3Code), text(r.tertiaryName ?? r.level3Name),
      weight(r.tertiaryWeight ?? r.level3Weight),
      point.code.match(/(?:^|-)(\d+)$/)?.[1] ?? point.code,
      point.name, importance, text(r.textbookPage),
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
  // Merge only adjacent identical groups, including all ancestor identities.
  for (const firstColumn of [1, 4, 7]) {
    let start = 0;
    const key = (index: number) => JSON.stringify(values[index]?.slice(0, firstColumn + 2));
    for (let end = 1; end <= values.length; end += 1) {
      if (end < values.length && key(start) === key(end)) continue;
      if (end - start > 1 && values[start].slice(firstColumn - 1, firstColumn + 1).some((value) => value !== "")) {
        for (let column = firstColumn; column < firstColumn + 3; column += 1) {
          sheet.mergeCells(start + 2, column, end + 1, column);
        }
      }
      start = end;
    }
  }
  sheet.pageSetup.printArea = `A1:M${points.length + 1}`;
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
    const bytes = Buffer.from(await buildOutlineWorkbook(points).xlsx.writeBuffer());
    const version = versions[0];
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
