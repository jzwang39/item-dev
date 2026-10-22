import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import ExcelJS from "exceljs";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";

import { createUlid } from "@/shared/database/ulid";
import { withTransaction } from "@/shared/database/mysql";

const uploadDirectory = "/tmp/itembank-blueprint-imports";
const levelCodes = ["level_5", "level_4", "level_3", "level_2", "level_1"] as const;

type LevelCode = (typeof levelCodes)[number];
type BlueprintRow = RowDataPacket & { id: string };
type ProjectRow = RowDataPacket & { id: string };
type Snapshot = { sourceName: string; points: TheoryAssessmentPoint[] };

export type TheoryAssessmentPoint = {
  code: string;
  name: string;
  primaryNo: string;
  primaryName: string;
  secondaryNo: string;
  secondaryName: string;
  tertiaryNo: string;
  tertiaryName: string;
  importance: "low" | "medium" | "high" | "critical" | null;
  remark: string;
  textbookPage: string;
};

export type TheoryOutlineSnapshot = {
  versionId: string;
  versionNo: number;
  sourceName: string;
  importedAt: string;
  points: TheoryAssessmentPoint[];
};

export class TheoryOutlineImportError extends Error {}

export async function getCurrentTheoryOutline(
  occupationId: string,
  levelCode: string
): Promise<TheoryOutlineSnapshot | null> {
  const level = validateLevel(levelCode);
  return withTransaction(async (connection) => {
    const projectId = await getProjectForOccupation(connection, occupationId);
    const [rows] = await connection.execute<(RowDataPacket & {
      id: string;
      version_no: number;
      snapshot_json: Snapshot | string;
      created_at: Date;
    })[]>(
      `SELECT bv.id, bv.version_no, bv.snapshot_json, bv.created_at
         FROM blueprints b
         INNER JOIN blueprint_versions bv ON bv.id = b.current_version_id
        WHERE b.project_id = ? AND b.occupation_id = ?
          AND b.blueprint_kind = 'theory_outline'
          AND b.assessment_mode = 'theory' AND b.level_code = ?
        LIMIT 1`,
      [projectId, occupationId, level]
    );
    const current = rows[0];
    if (!current) return null;
    const snapshot = typeof current.snapshot_json === "string"
      ? JSON.parse(current.snapshot_json) as Snapshot
      : current.snapshot_json;
    return { ...snapshot, versionId: current.id, versionNo: current.version_no, importedAt: current.created_at.toISOString() };
  });
}

export async function importTheoryOutline(
  occupationId: string,
  levelCode: string,
  file: File | undefined,
  actorId: string
): Promise<TheoryOutlineSnapshot> {
  const level = validateLevel(levelCode);
  if (!file) throw new TheoryOutlineImportError("请选择理论知识考评要素细目表文件。");
  const points = await parseOutlineFile(file);

  return withTransaction(async (connection) => {
    const projectId = await getProjectForOccupation(connection, occupationId);
    const source = await saveImportFile(connection, projectId, file, actorId);
    const blueprintId = await getOrCreateOutlineBlueprint(connection, projectId, occupationId, level);
    const [versionRows] = await connection.execute<(RowDataPacket & { version_no: number })[]>(
      "SELECT COALESCE(MAX(version_no), 0) AS version_no FROM blueprint_versions WHERE blueprint_id = ? FOR UPDATE",
      [blueprintId]
    );
    const versionNo = Number(versionRows[0].version_no) + 1;
    const versionId = createUlid();
    const snapshot: Snapshot = { sourceName: source.name, points };

    await connection.execute(
      `INSERT INTO blueprint_versions (
        id, blueprint_id, version_no, status, content_hash, snapshot_json, published_at, created_by
      ) VALUES (?, ?, ?, 'published', ?, ?, UTC_TIMESTAMP(3), ?)`,
      [versionId, blueprintId, versionNo, createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"), JSON.stringify(snapshot), actorId]
    );
    for (const [index, point] of points.entries()) {
      await connection.execute(
        `INSERT INTO blueprint_nodes (
          id, blueprint_version_id, parent_id, node_kind, node_code, name, ordinal, weight, importance, requirement_json, source_ref_json
        ) VALUES (?, ?, NULL, 'assessment_point', ?, ?, ?, NULL, ?, ?, ?)`,
        [
          createUlid(), versionId, point.code, point.name, index + 1, point.importance,
          JSON.stringify({
            primaryNo: point.primaryNo, primaryName: point.primaryName,
            secondaryNo: point.secondaryNo, secondaryName: point.secondaryName,
            tertiaryNo: point.tertiaryNo, tertiaryName: point.tertiaryName,
            remark: point.remark, textbookPage: point.textbookPage
          }),
          JSON.stringify({ sourceName: source.name })
        ]
      );
    }
    await connection.execute(
      "UPDATE blueprints SET current_version_id = ?, status = 'published', row_version = row_version + 1 WHERE id = ?",
      [versionId, blueprintId]
    );
    await connection.execute(
      `INSERT INTO blueprint_imports (
        id, project_id, file_object_id, blueprint_kind, scope_json, status, validation_json, created_by
      ) VALUES (?, ?, ?, 'theory_outline', ?, 'succeeded', ?, ?)`,
      [
        createUlid(), projectId, source.fileObjectId,
        JSON.stringify({ occupationId, assessmentMode: "theory", levelCode: level }),
        JSON.stringify({ pointCount: points.length }), actorId
      ]
    );
    await connection.execute(
      `INSERT INTO audit_logs (id, project_id, actor_id, action, object_type, object_id, after_json, result)
       VALUES (?, ?, ?, 'blueprint.theory_outline.import', 'blueprint_version', ?, ?, 'success')`,
      [createUlid(), projectId, actorId, versionId, JSON.stringify({ versionNo, levelCode: level, pointCount: points.length, sourceName: source.name })]
    );
    return { ...snapshot, versionId, versionNo, importedAt: new Date().toISOString() };
  });
}

async function parseOutlineFile(file: File): Promise<TheoryAssessmentPoint[]> {
  if (extname(file.name).toLowerCase() !== ".xlsx") {
    throw new TheoryOutlineImportError("仅支持 .xlsx 格式的理论知识考评要素细目表；请将 .xls 文件另存为 .xlsx 后上传。");
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  if (!bytes.length || bytes.length > 30 * 1024 * 1024) throw new TheoryOutlineImportError("文件不能为空且不得超过 30MB。");
  await mkdir(uploadDirectory, { recursive: true });
  const path = join(uploadDirectory, `${createUlid()}.xlsx`);
  await writeFile(path, bytes);

  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path);
    const worksheet = workbook.worksheets[0];
    if (!worksheet) throw new TheoryOutlineImportError("Excel 文件中未找到可读取的工作表。");
    return parseWorksheet(worksheet);
  } catch (error) {
    if (error instanceof TheoryOutlineImportError) throw error;
    throw new TheoryOutlineImportError(`细目表读取失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

function parseWorksheet(worksheet: ExcelJS.Worksheet): TheoryAssessmentPoint[] {
  const rows = Array.from({ length: worksheet.rowCount }, (_, index) => {
    const cells: Record<string, string> = {};
    worksheet.getRow(index + 1).eachCell({ includeEmpty: false }, (cell, columnNumber) => {
      cells[columnNumberToLetter(columnNumber)] = getCellText(cell.value).trim();
    });
    return cells;
  });
  if (rows.length < 2) throw new TheoryOutlineImportError("细目表至少需要表头和一条考评点数据。");

  const columns = new Map<string, string>();
  for (const [column, value] of Object.entries(rows[0])) columns.set(normalizeHeader(value), column);
  const required = ["一级序号", "一级名称", "二级序号", "二级名称", "三级序号", "三级名称", "考评点序号", "考评点名称"];
  const missing = required.filter((header) => !columns.has(normalizeHeader(header)));
  if (missing.length) throw new TheoryOutlineImportError(`细目表缺少必要列：${missing.join("、")}。`);

  const carry: Record<string, string> = {};
  const points: TheoryAssessmentPoint[] = [];
  const seen = new Set<string>();
  for (const row of rows.slice(1)) {
    const get = (header: string, inherit = true) => {
      const column = columns.get(normalizeHeader(header));
      const value = column ? (row[column] ?? "").trim() : "";
      if (value) carry[header] = value;
      return value || (inherit ? (carry[header] ?? "") : "");
    };
    const code = get("考评点序号", false);
    const name = get("考评点名称", false);
    if (!code && !name) continue;
    if (!code || !name) throw new TheoryOutlineImportError("每条考评点必须同时填写“考评点序号”和“考评点名称”。");
    const pointCode = [get("一级序号"), get("二级序号"), get("三级序号"), code].filter(Boolean).join("-");
    if (seen.has(pointCode)) throw new TheoryOutlineImportError(`考评点路径“${pointCode}”重复。`);
    seen.add(pointCode);
    points.push({
      code: pointCode, name,
      primaryNo: get("一级序号"), primaryName: get("一级名称"),
      secondaryNo: get("二级序号"), secondaryName: get("二级名称"),
      tertiaryNo: get("三级序号"), tertiaryName: get("三级名称"),
      importance: parseImportance(get("重要程度", false)),
      remark: get("备注", false),
      textbookPage: get("教材页码", false)
    });
  }
  if (!points.length) throw new TheoryOutlineImportError("未识别到考评点。请确认文件已填写“考评点序号”和“考评点名称”。");
  return points;
}

function getCellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((part) => getCellText(part)).join("");
  if ("richText" in value) return value.richText.map((part) => part.text).join("");
  if ("text" in value) return value.text;
  if ("result" in value) return getCellText(value.result);
  return "";
}

function columnNumberToLetter(columnNumber: number) {
  let column = "";
  let current = columnNumber;
  while (current > 0) {
    const remainder = (current - 1) % 26;
    column = String.fromCharCode(65 + remainder) + column;
    current = Math.floor((current - 1) / 26);
  }
  return column;
}

function normalizeHeader(value: string) {
  return value.replace(/[\s（）()]/g, "").replace("权重%", "权重").trim();
}

function parseImportance(value: string): TheoryAssessmentPoint["importance"] {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (["低", "low"].includes(normalized)) return "low";
  if (["中", "medium"].includes(normalized)) return "medium";
  if (["高", "high", "重要"].includes(normalized)) return "high";
  if (["关键", "非常重要", "critical"].includes(normalized)) return "critical";
  throw new TheoryOutlineImportError(`重要程度“${value}”无效，请填写低、中、高或关键。`);
}

function validateLevel(level: string): LevelCode {
  if (!levelCodes.includes(level as LevelCode)) throw new TheoryOutlineImportError("技能等级无效。");
  return level as LevelCode;
}

async function getProjectForOccupation(connection: PoolConnection, occupationId: string) {
  const [rows] = await connection.execute<ProjectRow[]>(
    `SELECT p.id FROM projects p INNER JOIN project_occupations po ON po.project_id = p.id
     WHERE po.id = ? AND po.status = 'active' AND p.status = 'active' FOR UPDATE`,
    [occupationId]
  );
  if (!rows[0]) throw new TheoryOutlineImportError("职业不存在、已归档或不属于当前启用项目。");
  return rows[0].id;
}

async function saveImportFile(connection: PoolConnection, projectId: string, file: File, actorId: string) {
  const bytes = Buffer.from(await file.arrayBuffer());
  const id = createUlid();
  const path = join(uploadDirectory, `${id}.xlsx`);
  await mkdir(uploadDirectory, { recursive: true });
  await writeFile(path, bytes);
  await connection.execute(
    `INSERT INTO file_objects (id, project_id, storage_provider, bucket, object_key, original_name, mime_type, size_bytes, sha256, purpose, created_by)
     VALUES (?, ?, 'local', 'itembank-local', ?, ?, ?, ?, ?, 'blueprint_import', ?)`,
    [id, projectId, path, basename(file.name), file.type || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes.length, createHash("sha256").update(bytes).digest("hex"), actorId]
  );
  return { fileObjectId: id, name: file.name };
}

async function getOrCreateOutlineBlueprint(connection: PoolConnection, projectId: string, occupationId: string, level: LevelCode) {
  const [rows] = await connection.execute<BlueprintRow[]>(
    `SELECT id FROM blueprints WHERE project_id = ? AND occupation_id = ? AND blueprint_kind = 'theory_outline'
       AND assessment_mode = 'theory' AND level_code = ? LIMIT 1 FOR UPDATE`,
    [projectId, occupationId, level]
  );
  if (rows[0]) return rows[0].id;
  const id = createUlid();
  await connection.execute(
    `INSERT INTO blueprints (id, project_id, name, blueprint_kind, occupation_id, level_code, assessment_mode, status)
     VALUES (?, ?, '理论知识考评要素细目表', 'theory_outline', ?, ?, 'theory', 'draft')`,
    [id, projectId, occupationId, level]
  );
  return id;
}
