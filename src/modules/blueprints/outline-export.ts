import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import ExcelJS from "exceljs";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { withTransaction } from "@/shared/database/mysql";
import { createUlid } from "@/shared/database/ulid";
import { extractDocxText, extractPdfText } from "@/modules/documents/extraction/service";
import { assertOutlineConfirmed } from "./point-review";
import { codeFor } from "./theory-outline-generation/node-code";
import { parseStandardBasicItems, type StandardBasicSource } from "./theory-outline-generation/standard-basic";

export type ExportPoint = {
  id?: string | null; code: string; name: string; importance: string | null; requirement: unknown; sourceRef?: unknown;
};
type CellValue = string | number;
export type StandardBasicModule = {
  secondaryName: string;
  moduleName: string;
  order: number;
  searchText: string;
};
type OutlineWorkbookOptions = {
  normalizeTheoryHierarchy?: boolean;
  standardBasicModules?: StandardBasicModule[];
};
export type OutlinePointCodeMapping = {
  blueprintNodeId: string;
  sourcePointCode: string;
  exportPointCode: string;
  pointName: string;
};
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
type TheoryDisplayDraft = {
  primaryName: string;
  primaryWeight: CellValue;
  secondaryName: string;
  secondaryWeight: CellValue;
  tertiaryName: string;
  tertiaryWeight: CellValue;
  isRelated: boolean;
};
type DisplayPoint = {
  point: ExportPoint;
  hierarchy: DisplayHierarchy;
  importance: string;
  originalIndex: number;
};
type OutlineWorkbookModel = {
  workbook: ExcelJS.Workbook;
  mappings: OutlinePointCodeMapping[];
};
type TheoryWeightBuckets = {
  basicPrimaryWeights: Map<string, CellValue>;
  relatedPrimaryWeights: Map<string, CellValue>;
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

function normalizeMatchText(value: unknown) {
  return text(value)
    .normalize("NFKC")
    .replace(/^\s*\d+(?:\.\d+)*(?:\s*[.、．])?\s*/u, "")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .trim();
}

function bigrams(value: string) {
  const result = new Set<string>();
  for (let index = 0; index < value.length - 1; index += 1) result.add(value.slice(index, index + 2));
  return result;
}

function overlapScore(left: string, right: string) {
  if (!left || !right) return 0;
  const l = bigrams(left);
  const r = bigrams(right);
  let score = 0;
  for (const token of l) if (r.has(token)) score += 1;
  return score;
}

function distinct(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function secondaryScopeName(item: Pick<StandardBasicSource, "ancestorNames" | "parentName">) {
  return stripDisplayPrefix(item.ancestorNames?.[1] ?? item.parentName);
}

function moduleNameFor(item: Pick<StandardBasicSource, "ancestorNames" | "name">) {
  return stripDisplayPrefix(item.ancestorNames?.[2] ?? item.name);
}

export function buildStandardBasicModules(items: ReadonlyArray<Pick<StandardBasicSource, "ancestorNames" | "parentName" | "name" | "evidence">>) {
  const groups = new Map<string, StandardBasicModule>();
  items.forEach((item, index) => {
    const secondaryName = secondaryScopeName(item);
    const moduleName = moduleNameFor(item);
    if (!secondaryName || !moduleName) return;
    const key = `${normalizeMatchText(secondaryName)}\u0000${normalizeMatchText(moduleName)}`;
    const existing = groups.get(key);
    const searchText = distinct([moduleName, item.name, item.parentName, ...(item.ancestorNames ?? []), item.evidence ?? ""]).join(" ");
    if (existing) {
      existing.searchText = distinct([existing.searchText, searchText]).join(" ");
      return;
    }
    groups.set(key, { secondaryName, moduleName, order: index, searchText });
  });
  return [...groups.values()].sort((left, right) => left.order - right.order);
}

function resolveStandardBasicModule(point: ExportPoint, secondaryName: string, tertiaryName: string, modules: StandardBasicModule[]) {
  const source = object(point.sourceRef).standardBasic;
  const standardBasic = source && typeof source === "object" && !Array.isArray(source)
    ? source as Pick<StandardBasicSource, "ancestorNames" | "parentName" | "name">
    : null;
  if (standardBasic) return moduleNameFor(standardBasic);

  const secondaryKey = normalizeMatchText(secondaryName);
  const candidates = modules.filter((item) => normalizeMatchText(item.secondaryName) === secondaryKey);
  if (!candidates.length) return stripDisplayPrefix(tertiaryName);
  if (candidates.length === 1) return candidates[0].moduleName;
  const pointKey = normalizeMatchText(point.name);
  const tertiaryKey = normalizeMatchText(tertiaryName);
  const ranked = candidates.map((candidate) => {
    const moduleKey = normalizeMatchText(candidate.moduleName);
    const searchKey = normalizeMatchText(candidate.searchText);
    let score = overlapScore(pointKey, searchKey) * 5 + overlapScore(tertiaryKey, searchKey) * 3;
    if (moduleKey && (pointKey.includes(moduleKey) || tertiaryKey.includes(moduleKey))) score += 100;
    if (pointKey && searchKey.includes(pointKey)) score += 80;
    if (tertiaryKey && searchKey.includes(tertiaryKey)) score += 50;
    return { candidate, score };
  }).sort((left, right) => right.score - left.score || left.candidate.order - right.candidate.order);
  return ranked[0]?.candidate.moduleName ?? stripDisplayPrefix(tertiaryName);
}

function scopedCode(groups: Map<string, Map<string, string>>, parentKey: string, key: string) {
  let values = groups.get(parentKey);
  if (!values) {
    values = new Map<string, string>();
    groups.set(parentKey, values);
  }
  return codeFor(values, key);
}

function theoryDisplayDraft(point: ExportPoint, options: OutlineWorkbookOptions = {}): TheoryDisplayDraft {
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
      : (options.standardBasicModules?.length
        ? resolveStandardBasicModule(point, secondaryName, rawTertiaryName, options.standardBasicModules)
        : rawTertiaryName),
  );

  return {
    primaryName,
    primaryWeight: weight(r.primaryWeight ?? r.level1Weight),
    secondaryName,
    secondaryWeight: isRelated ? "" : weight(r.secondaryWeight ?? r.level2Weight),
    tertiaryName,
    tertiaryWeight: isRelated ? "" : weight(r.tertiaryWeight ?? r.level3Weight),
    isRelated,
  };
}

function theoryHierarchy(point: ExportPoint, index: number, codes: {
  primary: Map<string, string>;
  secondary: Map<string, Map<string, string>>;
  tertiary: Map<string, Map<string, string>>;
}, weights: TheoryWeightBuckets, options: OutlineWorkbookOptions = {}): DisplayHierarchy {
  const draft = theoryDisplayDraft(point, options);
  return {
    primaryNo: codeFor(codes.primary, draft.primaryName || `primary-${index}`),
    primaryName: draft.primaryName,
    primaryWeight: draft.isRelated
      ? (weights.relatedPrimaryWeights.get(draft.primaryName) ?? draft.primaryWeight)
      : (weights.basicPrimaryWeights.get(draft.primaryName) ?? draft.primaryWeight),
    secondaryNo: scopedCode(codes.secondary, draft.primaryName || `primary-${index}`, draft.secondaryName || `secondary-${index}`),
    secondaryName: draft.secondaryName,
    secondaryWeight: draft.isRelated ? draft.primaryWeight : draft.secondaryWeight,
    tertiaryNo: scopedCode(codes.tertiary, `${draft.primaryName}|${draft.secondaryName || `secondary-${index}`}`, draft.tertiaryName || `tertiary-${index}`),
    tertiaryName: draft.tertiaryName,
    tertiaryWeight: draft.tertiaryWeight,
  };
}

export function buildOutlineWorkbook(points: ExportPoint[], options: OutlineWorkbookOptions = {}) {
  return buildOutlineWorkbookModel(points, options).workbook;
}

export function buildOutlineWorkbookPackage(points: ExportPoint[], options: OutlineWorkbookOptions = {}) {
  const model = buildOutlineWorkbookModel(points, options);
  return { workbook: model.workbook, mappings: model.mappings };
}

export async function replaceTheoryOutlineExportMappings(
  db: PoolConnection,
  blueprintVersionId: string,
  mappings: OutlinePointCodeMapping[],
) {
  await db.execute("DELETE FROM theory_outline_export_mappings WHERE blueprint_version_id=?", [blueprintVersionId]);
  if (!mappings.length) return;
  const placeholders = mappings.map(() => "(?,?,?,?,?)").join(",");
  const parameters = mappings.flatMap((mapping) => [
    blueprintVersionId,
    mapping.blueprintNodeId,
    mapping.sourcePointCode,
    mapping.exportPointCode,
    mapping.pointName,
  ]);
  await db.execute(
    `INSERT INTO theory_outline_export_mappings
      (blueprint_version_id,blueprint_node_id,source_point_code,export_point_code,point_name)
     VALUES ${placeholders}`,
    parameters,
  );
}

async function extractSourceText(objectKey: string, originalName: string) {
  const extension = extname(originalName).toLowerCase();
  const bytes = await readFile(objectKey);
  if (extension === ".txt") return bytes.toString("utf8").trim();
  if (extension === ".docx") return extractDocxText(bytes);
  return (await extractPdfText(bytes)).text;
}

export async function loadTheoryStandardBasicModules(db: PoolConnection, blueprintVersionId: string) {
  const [rows] = await db.execute<(RowDataPacket & { objectKey: string; originalName: string })[]>(
    `SELECT fo.object_key AS objectKey, fo.original_name AS originalName
       FROM blueprint_version_sources bvs
       JOIN source_versions sv ON sv.id = bvs.source_version_id
       JOIN sources s ON s.id = sv.source_id AND s.source_type = 'occupation_standard' AND s.status = 'active'
       JOIN file_objects fo ON fo.id = sv.file_object_id
      WHERE bvs.blueprint_version_id = ?
      ORDER BY sv.created_at DESC, sv.id DESC
      LIMIT 1`,
    [blueprintVersionId],
  );
  if (!rows[0]) return [];
  return buildStandardBasicModules(parseStandardBasicItems(await extractSourceText(rows[0].objectKey, rows[0].originalName)));
}

function buildOutlineWorkbookModel(points: ExportPoint[], options: OutlineWorkbookOptions = {}): OutlineWorkbookModel {
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
  const weights: TheoryWeightBuckets = {
    basicPrimaryWeights: new Map<string, CellValue>(),
    relatedPrimaryWeights: new Map<string, CellValue>(),
  };
  if (options.normalizeTheoryHierarchy) {
    const basicBuckets = new Map<string, Map<string, CellValue>>();
    const relatedBuckets = new Map<string, Map<string, CellValue>>();
    for (const point of points) {
      const draft = theoryDisplayDraft(point, options);
      if (draft.isRelated) {
        let bySecondary = relatedBuckets.get(draft.primaryName);
        if (!bySecondary) {
          bySecondary = new Map<string, CellValue>();
          relatedBuckets.set(draft.primaryName, bySecondary);
        }
        if (!bySecondary.has(draft.secondaryName) && draft.primaryWeight !== "") {
          bySecondary.set(draft.secondaryName, draft.primaryWeight);
        }
        continue;
      }
      if (draft.secondaryWeight === "") continue;
      let bySecondary = basicBuckets.get(draft.primaryName);
      if (!bySecondary) {
        bySecondary = new Map<string, CellValue>();
        basicBuckets.set(draft.primaryName, bySecondary);
      }
      if (!bySecondary.has(draft.secondaryName)) bySecondary.set(draft.secondaryName, draft.secondaryWeight);
    }
    for (const [primaryName, bySecondary] of basicBuckets) {
      const secondaryWeights = [...bySecondary.values()];
      const numeric = secondaryWeights.map((value) => Number(value)).filter(Number.isFinite);
      const total = numeric.length === secondaryWeights.length ? numeric.reduce((sum, value) => sum + value, 0) : secondaryWeights[0] ?? "";
      weights.basicPrimaryWeights.set(primaryName, total);
    }
    for (const [primaryName, bySecondary] of relatedBuckets) {
      const secondaryWeights = [...bySecondary.values()];
      const numeric = secondaryWeights.map((value) => Number(value)).filter(Number.isFinite);
      const total = numeric.length === secondaryWeights.length ? numeric.reduce((sum, value) => sum + value, 0) : secondaryWeights[0] ?? "";
      weights.relatedPrimaryWeights.set(primaryName, total);
    }
      for (const basicModule of options.standardBasicModules ?? []) {
        scopedCode(displayCodes.tertiary, `基本要求|${basicModule.secondaryName}`, basicModule.moduleName);
    }
  }
  const mappings: OutlinePointCodeMapping[] = [];
  const rows = points.map((point, index): DisplayPoint => {
    const r = object(point.requirement);
    // Use the version's stored hierarchy, not a newer weight table.
    const importance = ["X", "Y", "Z"].includes(text(r.importanceCode))
      ? text(r.importanceCode)
      : ({ critical: "X", high: "Y", medium: "Z", low: "Z" }[point.importance ?? ""] ?? "");
    const hierarchy = options.normalizeTheoryHierarchy
      ? theoryHierarchy(point, index, displayCodes, weights, options)
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
    return { point, hierarchy, importance, originalIndex: index };
  });
  const orderedRows = options.normalizeTheoryHierarchy
    ? [...rows].sort((left, right) =>
      left.hierarchy.primaryNo.localeCompare(right.hierarchy.primaryNo) ||
      left.hierarchy.secondaryNo.localeCompare(right.hierarchy.secondaryNo) ||
      left.hierarchy.tertiaryNo.localeCompare(right.hierarchy.tertiaryNo) ||
      left.originalIndex - right.originalIndex)
    : rows;
  const pointOrdinals = new Map<string, number>();
  const values = orderedRows.map(({ point, hierarchy, importance }): CellValue[] => {
    const pointOrdinal = options.normalizeTheoryHierarchy
      ? (() => {
        const key = [hierarchy.primaryName, hierarchy.secondaryName, hierarchy.tertiaryName].join("\u0000");
        const next = (pointOrdinals.get(key) ?? 0) + 1;
        pointOrdinals.set(key, next);
        return String(next).padStart(3, "0");
      })()
      : (point.code.match(/(?:^|-)(\d+)$/)?.[1] ?? point.code);
    if (point.id) mappings.push({
      blueprintNodeId: point.id,
      sourcePointCode: point.code,
      exportPointCode: [hierarchy.primaryNo, hierarchy.secondaryNo, hierarchy.tertiaryNo, pointOrdinal].join("-"),
      pointName: point.name,
    });
    return [
      hierarchy.primaryNo, hierarchy.primaryName,
      hierarchy.primaryWeight,
      hierarchy.secondaryNo, hierarchy.secondaryName,
      hierarchy.secondaryWeight,
      hierarchy.tertiaryNo, hierarchy.tertiaryName,
      hierarchy.tertiaryWeight,
      pointOrdinal,
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
  return { workbook, mappings };
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
      `SELECT id,node_code AS code,name,importance,requirement_json AS requirement
              ,source_ref_json AS sourceRef
       FROM blueprint_nodes WHERE blueprint_version_id=? AND node_kind='assessment_point'
       ORDER BY ordinal,id`, [versionId],
    );
    const version = versions[0];
    const standardBasicModules = version.assessmentMode === "theory"
      ? await loadTheoryStandardBasicModules(db, versionId)
      : [];
    const exported = buildOutlineWorkbookPackage(points, {
      normalizeTheoryHierarchy: version.assessmentMode === "theory",
      standardBasicModules,
    });
    if (version.assessmentMode === "theory") {
      await replaceTheoryOutlineExportMappings(db, versionId, exported.mappings);
    }
    const bytes = Buffer.from(await exported.workbook.xlsx.writeBuffer());
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
