import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import type { PoolConnection, RowDataPacket } from "mysql2/promise";

import { extractDocxText, extractPdfText } from "@/modules/documents/extraction/service";
import { createUlid } from "@/shared/database/ulid";
import { withTransaction } from "@/shared/database/mysql";
import { toOccupationDirection, type OccupationDirection, type StoredOccupationDirection } from "@/modules/authoring/occupations/directions";
import { parseDirectionalTheoryWeights, parseStandardRequirements, TheoryWeightImportError, type StandardRequirementScope, type TheoryWeightScope } from "./standard";
import { readPdfWeightColumns } from "./pdf-columns";
import type { PdfTextRun } from "@/modules/documents/extraction/service";
import { parseSkillStandard } from "../skill-standard";
import { publishSkillStandard } from "../skill-standard-import";
import { readCurrentTheoryVersion } from "../current-theory-version";

const levels = ["level_5", "level_4", "level_3", "level_2", "level_1"] as const;

type LevelCode = (typeof levels)[number];
type ProjectRow = RowDataPacket & { id: string };
type BlueprintRow = RowDataPacket & { id: string; current_version_id: string | null };
type SourceRow = RowDataPacket & { id: string; name: string; original_name: string };
type SourceTextRow = RowDataPacket & { content_excerpt: string };

export type TheoryWeightItem = {
  category: string;
  name: string;
  weights: Record<LevelCode, number | null>;
};

export type TheoryWeightSnapshot = {
  versionId: string;
  versionNo: number;
  sourceName: string;
  usedOcr: boolean;
  importedAt: string;
  items: TheoryWeightItem[];
  scopes?: TheoryWeightScope[];
  requirementScopeCount?: number;
};

export { TheoryWeightImportError } from "./standard";

export async function listOccupationStandards(occupationId: string): Promise<SourceRow[]> {
  return withTransaction(async (connection) => {
    const projectId = await getProjectForOccupation(connection, occupationId);
    const [rows] = await connection.execute<SourceRow[]>(
      `SELECT DISTINCT sv.id, s.name, fo.original_name, sv.created_at
         FROM sources s
         INNER JOIN source_versions sv ON sv.id = s.current_version_id
         INNER JOIN file_objects fo ON fo.id = sv.file_object_id
         INNER JOIN source_scopes ss ON ss.source_version_id = sv.id
        WHERE s.project_id = ?
          AND s.source_type = 'occupation_standard'
          AND s.status = 'active'
          AND sv.parse_status = 'succeeded'
          AND ss.occupation_id = ?
        ORDER BY sv.created_at DESC`,
      [projectId, occupationId]
    );
    return rows;
  });
}

export async function getCurrentTheoryWeights(occupationId: string): Promise<TheoryWeightSnapshot | null> {
  return withTransaction(async (connection) => {
    const projectId = await getProjectForOccupation(connection, occupationId);
    const current = await readCurrentTheoryVersion(connection, { projectId, occupationId, kind: "theory_weight" });
    if (!current) {
      return null;
    }
    const snapshot = typeof current.snapshot_json === "string"
      ? JSON.parse(current.snapshot_json) as Omit<TheoryWeightSnapshot, "versionId" | "versionNo" | "importedAt">
      : current.snapshot_json as Omit<TheoryWeightSnapshot, "versionId" | "versionNo" | "importedAt">;
    return {
      ...snapshot,
      versionId: current.id,
      versionNo: current.version_no,
      importedAt: current.created_at.toISOString()
    };
  });
}

export async function importTheoryWeights(
  occupationId: string,
  input: Readonly<{ file?: File; sourceVersionId?: string }>,
  actorId: string
): Promise<TheoryWeightSnapshot> {
  if (!input.file && !input.sourceVersionId) {
    throw new TheoryWeightImportError("请选择国家职业标准文件或已解析的资料依据。");
  }
  if (input.file && input.sourceVersionId) {
    throw new TheoryWeightImportError("一次只能选择一种识别来源。");
  }

  const extracted = input.file
    ? await extractUploadedText(input.file)
    : await extractSourceText(input.sourceVersionId!, occupationId);

  let storedPath: string | undefined;
  try {
    return await withTransaction(async (connection) => {
      const projectId = await getProjectForOccupation(connection, occupationId);
      const source = input.file
        ? await saveImportFile(connection, projectId, input.file, actorId, (path) => { storedPath = path; })
        : await getSourceFile(connection, input.sourceVersionId!, projectId, occupationId);
      return publishSharedOccupationStandard(connection, projectId, occupationId, extracted, {
        ...source, sourceVersionId: input.sourceVersionId ?? null,
      }, actorId);
    });
  } catch (error) {
    if (storedPath) await unlink(storedPath).catch(() => undefined);
    throw error;
  }
}

export async function publishSharedOccupationStandard(
  connection: PoolConnection,
  projectId: string,
  occupationId: string,
  extracted: { text: string; usedOcr: boolean; layout?: PdfTextRun[][] },
  source: { name: string; fileObjectId: string; sourceVersionId: string | null },
  actorId: string,
): Promise<TheoryWeightSnapshot> {
    const [occupationRows] = await connection.execute<(RowDataPacket & { name: string; code: string })[]>(
      "SELECT name, code FROM project_occupations WHERE id = ? FOR UPDATE", [occupationId],
    );
    const [directionRows] = await connection.execute<(RowDataPacket & StoredOccupationDirection)[]>(
      "SELECT id, name, ordinal, status FROM project_occupation_directions WHERE occupation_id = ? AND status = 'active' ORDER BY ordinal FOR UPDATE",
      [occupationId],
    );
    const directions: OccupationDirection[] = directionRows.map((direction) => toOccupationDirection(direction, occupationRows[0].code));
    const scopes = parseDirectionalTheoryWeights(extracted.text, { ...occupationRows[0], directions },
      extracted.layout ? readPdfWeightColumns(extracted.layout, directions) : undefined);
    const requirements = parseStandardRequirements(extracted.text, scopes);
    const skillData = parseSkillStandard(extracted.text);
    source = { ...source, sourceVersionId: await ensureSharedStandardSource(connection, projectId, occupationId, source, extracted.text, actorId) };
    // Keep the legacy single-scope shape only when it is unambiguous.
    const items = scopes.length === 1 ? scopes[0].items : [];
    const blueprintId = await getOrCreateTheoryWeightBlueprint(connection, projectId, occupationId);
    const [versionRows] = await connection.execute<(RowDataPacket & { version_no: number })[]>(
      "SELECT COALESCE(MAX(version_no), 0) AS version_no FROM blueprint_versions WHERE blueprint_id = ? FOR UPDATE",
      [blueprintId]
    );
    const versionNo = Number(versionRows[0].version_no) + 1;
    const versionId = createUlid();
    const snapshot = {
      sourceName: source.name,
      fileObjectId: source.fileObjectId,
      sourceVersionId: source.sourceVersionId,
      usedOcr: extracted.usedOcr,
      items,
      scopes,
      requirementScopeCount: requirements.length,
    };
    const contentHash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");

    await connection.execute(
      `INSERT INTO blueprint_versions (
        id, blueprint_id, version_no, status, content_hash, snapshot_json, published_at, created_by
      ) VALUES (?, ?, ?, 'published', ?, ?, UTC_TIMESTAMP(3), ?)`,
      [versionId, blueprintId, versionNo, contentHash, JSON.stringify(snapshot), actorId]
    );

    for (const scope of scopes) {
    for (const [index, item] of scope.items.entries()) {
      await connection.execute(
        `INSERT INTO blueprint_nodes (
          id, blueprint_version_id, parent_id, node_kind, node_code, name, ordinal, weight, requirement_json, source_ref_json
        ) VALUES (?, ?, NULL, 'weight_item', ?, ?, ?, NULL, ?, ?)`,
        [
          createUlid(),
          versionId,
          `${scope.directionCode ?? "occupation"}-weight-${String(index + 1).padStart(3, "0")}`,
          item.name,
          index + 1,
          JSON.stringify({ category: item.category, weights: item.weights, directionId: scope.directionId, directionName: scope.directionName }),
          JSON.stringify({ sourceName: source.name, usedOcr: extracted.usedOcr })
        ]
      );
    }
    }
    await saveStandardRequirements(connection, occupationId, versionId, source.fileObjectId, source.sourceVersionId, requirements);

    await connection.execute(
      `UPDATE blueprints
          SET current_version_id = ?, status = 'published', row_version = row_version + 1
        WHERE id = ?`,
      [versionId, blueprintId]
    );
    await connection.execute(
      `INSERT INTO blueprint_imports (
        id, project_id, file_object_id, blueprint_kind, scope_json, status, validation_json, created_by
      ) VALUES (?, ?, ?, 'theory_weight', ?, 'succeeded', ?, ?)`,
      [
        createUlid(),
        projectId,
        source.fileObjectId,
        JSON.stringify({ occupationId, assessmentMode: "theory", levelCodes: levels, directions: scopes.map((scope) => ({ id: scope.directionId, name: scope.directionName, code: scope.occupationCode })) }),
        JSON.stringify({ usedOcr: extracted.usedOcr, scopes: scopes.map((scope) => ({ directionId: scope.directionId, itemCount: scope.items.length, totals: calculateTotals(scope.items) })), requirementScopeCount: requirements.length }),
        actorId
      ]
    );
    if (source.sourceVersionId) {
      await connection.execute(
        "INSERT INTO blueprint_version_sources (blueprint_version_id, source_version_id) VALUES (?, ?)",
        [versionId, source.sourceVersionId]
      );
    }
    await connection.execute(
      `INSERT INTO audit_logs (
        id, project_id, actor_id, action, object_type, object_id, after_json, result
      ) VALUES (?, ?, ?, 'blueprint.theory_weight.import', 'blueprint_version', ?, ?, 'success')`,
      [createUlid(), projectId, actorId, versionId, JSON.stringify({ versionNo, scopeCount: scopes.length, requirementScopeCount: requirements.length, sourceName: source.name })]
    );
    await publishSkillStandard(connection, projectId, occupationId, skillData, {
      sourceName: source.name, fileObjectId: source.fileObjectId,
      sourceVersionId: source.sourceVersionId, usedOcr: extracted.usedOcr,
    }, actorId);

    return {
      ...snapshot,
      versionId,
      versionNo,
      importedAt: new Date().toISOString()
    };
}

async function extractUploadedText(file: File): Promise<{ text: string; usedOcr: boolean; layout?: PdfTextRun[][] }> {
  const extension = extname(file.name).toLowerCase();
  if (![".pdf", ".docx", ".txt"].includes(extension)) {
    throw new TheoryWeightImportError("仅支持 PDF、DOCX 或 TXT 格式的国家职业标准。");
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length === 0 || bytes.length > 30 * 1024 * 1024) {
    throw new TheoryWeightImportError("文件不能为空且不得超过 30MB。");
  }
  if (extension === ".txt") {
    return { text: bytes.toString("utf8"), usedOcr: false };
  }
  if (extension === ".docx") {
    return { text: await extractDocxText(bytes), usedOcr: false };
  }

  try {
    const result = await extractPdfText(bytes, { includeLayout: true });
    return { text: result.text, usedOcr: result.usedOcr, layout: result.layout };
  } catch (error) {
    throw new TheoryWeightImportError(`PDF 文本提取或 OCR 失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

async function extractSourceText(sourceVersionId: string, occupationId: string): Promise<{ text: string; usedOcr: boolean; layout?: PdfTextRun[][] }> {
  return withTransaction(async (connection) => {
    const projectId = await getProjectForOccupation(connection, occupationId);
    const [rows] = await connection.execute<(SourceTextRow & { object_key: string; original_name: string; storage_provider: string })[]>(
      `SELECT DISTINCT seg.ordinal, seg.content_excerpt, fo.object_key, fo.original_name, fo.storage_provider
         FROM source_segments seg
         JOIN source_versions sv ON sv.id = seg.source_version_id AND sv.parse_status = 'succeeded'
         JOIN sources s ON s.id = sv.source_id AND s.status = 'active' AND s.source_type = 'occupation_standard'
         JOIN source_scopes ss ON ss.source_version_id = sv.id
         JOIN file_objects fo ON fo.id = sv.file_object_id
        WHERE sv.id = ? AND s.project_id = ? AND ss.occupation_id = ?
        ORDER BY seg.ordinal`,
      [sourceVersionId, projectId, occupationId]
    );
    const text = rows.map((row) => row.content_excerpt).join("\n");
    if (!text.trim()) {
      throw new TheoryWeightImportError("该资料尚无可用解析文本，请重新解析或使用本地文件上传。");
    }
    if (rows[0]?.storage_provider === "local" && extname(rows[0].original_name).toLowerCase() === ".pdf") {
      try {
        const parsed = await extractPdfText(await readFile(rows[0].object_key), { includeLayout: true });
        return { text: parsed.text, usedOcr: parsed.usedOcr, layout: parsed.layout };
      } catch (error) {
        if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    return { text, usedOcr: false };
  });
}

export function parseTheoryWeights(text: string): TheoryWeightItem[] {
  const items: TheoryWeightItem[] = [];
  let category = "未分类";
  const theorySection = getTheoryWeightSection(text);
  const flatItems = parseFlatTheoryWeightRows(theorySection);
  if (flatItems.length) return flatItems;
  const lines = theorySection.replace(/\r/g, "\n").split("\n")
    .map((rawLine) => rawLine.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const cells = getWeightCells(line);
    if (!cells) {
      if (line.length <= 20 && !/[。；，：]/.test(line)) category = line;
      continue;
    }
    const name = getWeightRowName(line, cells);
    if (!name || /等级|初级工|中级工|高级工|技师|百分比|权重|合计/.test(name)) continue;
    items.push({
      category,
      name,
      weights: Object.fromEntries(levels.map((level, index) => [level, parseWeight(cells[index])])) as TheoryWeightItem["weights"]
    });
  }

  if (!items.length) return parseSplitTheoryWeightRows(lines);
  return items;
}

async function ensureSharedStandardSource(
  connection: PoolConnection,
  projectId: string,
  occupationId: string,
  source: { name: string; fileObjectId: string; sourceVersionId: string | null },
  text: string,
  actorId: string,
) {
  const [existing] = await connection.execute<(RowDataPacket & { id: string })[]>(
    `SELECT sv.id FROM source_versions sv JOIN sources s ON s.id=sv.source_id AND s.current_version_id=sv.id
     WHERE sv.file_object_id=? AND s.project_id=? AND s.source_type='occupation_standard' AND s.status='active'
       AND sv.parse_status='succeeded' LIMIT 1`, [source.fileObjectId, projectId],
  );
  const sourceVersionId = existing[0]?.id ?? createUlid();
  if (!existing.length) {
    const sourceId = createUlid();
    await connection.execute(
      `INSERT INTO sources(id,project_id,name,source_type,remark,current_version_id,created_by)
       VALUES(?,?,?,'occupation_standard','理论知识与操作技能共用国家职业标准',?,?)`,
      [sourceId, projectId, source.name, sourceVersionId, actorId],
    );
    await connection.execute(
      `INSERT INTO source_versions(id,source_id,version_no,file_object_id,parse_status,parser_version,content_hash,created_by)
       VALUES(?,?,1,?,'succeeded','shared-standard-v1',?,?)`,
      [sourceVersionId, sourceId, source.fileObjectId, createHash("sha256").update(text).digest("hex"), actorId],
    );
    for (let offset = 0, ordinal = 1; offset < text.length; offset += 12000, ordinal++) {
      const excerpt = text.slice(offset, offset + 12000);
      await connection.execute(
        `INSERT INTO source_segments(id,source_version_id,ordinal,locator,content_excerpt,content_hash)
         VALUES(?,?,?,?,?,?)`,
        [createUlid(), sourceVersionId, ordinal, `职业标准原文片段${ordinal}`, excerpt,
          createHash("sha256").update(excerpt).digest("hex")],
      );
    }
  }
  for (const level of levels) for (const mode of ["theory", "skill"]) {
    await connection.execute(
      `INSERT IGNORE INTO source_scopes(id,source_version_id,occupation_id,level_code,assessment_mode)
       VALUES(?,?,?,?,?)`, [createUlid(), sourceVersionId, occupationId, level, mode],
    );
  }
  return sourceVersionId;
}

function parseFlatTheoryWeightRows(section: string) {
  const flat = section.replace(/\s+/g, " ").trim();
  const cell = "(?:—|－|--|-|\\d+(?:\\.\\d+)?[%％]?)";
  const pattern = new RegExp(`(${cell}(?:\\s+${cell}){4})`, "g");
  const items: TheoryWeightItem[] = [];
  let category = "未分类";
  let previousEnd = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(flat))) {
    const cells = getWeightCells(match[1]);
    if (!cells) continue;
    const prefix = flat.slice(previousEnd, match.index);
    previousEnd = pattern.lastIndex;
    if (/合计/.test(prefix)) break;
    if (/基本\s*要求/.test(prefix)) category = "基本要求";
    if (/相关\s*知识\s*要求/.test(prefix)) category = "相关知识要求";
    const name = prefix
      .replace(/^.*?(?:\)\s*)/, "")
      .replace(/基本\s*要求|相关\s*知识\s*要求/g, "")
      .trim()
      .split(/\s+/)
      .at(-1) ?? "";
    if (!name || /等级|初级工|中级工|高级工|技师|百分比|权重|合计|职业编码/.test(name)) continue;
    items.push({
      category,
      name,
      weights: Object.fromEntries(
        levels.map((level, index) => [level, parseWeight(cells[index])]),
      ) as TheoryWeightItem["weights"],
    });
  }
  return items;
}

function getTheoryWeightSection(text: string): string {
  const normalized = text.replace(/\r/g, "\n");
  const start = normalized.search(/4\s*[.．、]?\s*1\s*理论知识权重表/);
  if (start < 0) {
    throw new TheoryWeightImportError("未找到“4.1 理论知识权重表”区块，请确认上传的是完整职业标准。");
  }
  const afterTitle = normalized.slice(start);
  const nextSection = afterTitle.search(/4\s*[.．、]?\s*2\s*技能要求权重表/);
  return nextSection < 0 ? afterTitle : afterTitle.slice(0, nextSection);
}

function getWeightCells(line: string): string[] | null {
  const tokens = [...line.matchAll(/(?:—|－|--|-|\d+(?:\.\d+)?[%％]?)/g)].map((token) => token[0]);

  // Some PDF text layers merge adjacent one-digit cells, e.g. "5 5 5 5 5" becomes "55555".
  if (tokens.length === 1 && /^\d{5}$/.test(tokens[0])) {
    return [...tokens[0]];
  }
  if (tokens.length < 5) return null;

  // Table rows often include an ordinal before the five grade columns.
  const cells = tokens.slice(-5);
  const values = cells.map(parseWeight);
  return values.every((value) => value === null || (value >= 0 && value <= 100)) ? cells : null;
}

function parseWeight(value: string): number | null {
  if (value === "—" || value === "－" || value === "-" || value === "--") return null;
  const parsed = Number(value.replace(/[%％]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function getWeightRowName(line: string, cells: string[]) {
  const tokens = [...line.matchAll(/(?:—|－|--|-|\d+(?:\.\d+)?[%％]?)/g)];
  if (tokens.length < cells.length) {
    const merged = line.match(/\d{5}/);
    return merged?.index === undefined
      ? ""
      : line.slice(0, merged.index).replace(/[|｜、:：]/g, " ").trim();
  }
  const start = tokens[tokens.length - cells.length];
  if (start.index === undefined) return "";
  return line
    .slice(0, start.index)
    .replace(/^\s*\d+(?:[.．、]\s*)?/, "")
    .replace(/[|｜、:：]/g, " ")
    .trim();
}

function parseSplitTheoryWeightRows(lines: string[]) {
  const items: TheoryWeightItem[] = [];
  let category = "未分类";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.length <= 20 && !/[。；，：]/.test(line) && !getWeightCells(line)) {
      category = line;
      continue;
    }
    if (getWeightCells(line) || !/[\u4e00-\u9fff]/.test(line)) continue;
    const candidate = [lines[index + 1], lines[index + 2], lines[index + 3]]
      .filter(Boolean)
      .join(" ");
    const cells = getWeightCells(candidate);
    if (!cells) continue;
    const name = line.replace(/^\s*\d+(?:[.．、]\s*)?/, "").trim();
    if (/等级|初级工|中级工|高级工|技师|百分比|权重|合计/.test(name)) continue;
    items.push({
      category,
      name,
      weights: Object.fromEntries(
        levels.map((level, weightIndex) => [level, parseWeight(cells[weightIndex])]),
      ) as TheoryWeightItem["weights"],
    });
    index += 3;
  }
  if (!items.length) {
    throw new TheoryWeightImportError("未能从文件中识别出“项目 + 五个等级权重”的完整表格。请上传含可复制文本的国家职业标准，或先完成扫描件 OCR。");
  }
  return items;
}

function calculateTotals(items: TheoryWeightItem[]): Record<LevelCode, number> {
  return Object.fromEntries(
    levels.map((level) => [level, items.reduce((total, item) => total + (item.weights[level] ?? 0), 0)])
  ) as Record<LevelCode, number>;
}

async function getProjectForOccupation(connection: PoolConnection, occupationId: string): Promise<string> {
  const [rows] = await connection.execute<ProjectRow[]>(
    `SELECT p.id
       FROM projects p
       INNER JOIN project_occupations po ON po.project_id = p.id
      WHERE po.id = ? AND po.status = 'active' AND p.status = 'active'
      FOR UPDATE`,
    [occupationId]
  );
  if (!rows[0]) throw new TheoryWeightImportError("职业不存在、已归档或不属于当前启用项目。");
  return rows[0].id;
}

async function saveStandardRequirements(
  connection: PoolConnection,
  occupationId: string,
  blueprintVersionId: string,
  fileObjectId: string,
  sourceVersionId: string | null,
  scopes: readonly StandardRequirementScope[],
) {
  for (const scope of scopes) {
    const scopeId = createUlid();
    await connection.execute(
      `INSERT INTO occupation_standard_requirement_scopes (
        id, occupation_id, direction_id, direction_name, level_code, blueprint_version_id, file_object_id, source_version_id, scope_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [scopeId, occupationId, scope.directionId, scope.directionName, scope.levelCode, blueprintVersionId, fileObjectId, sourceVersionId,
        `${scope.directionId ?? "occupation"}:${scope.levelCode}`],
    );
    const insertNode = async (parentId: string | null, kind: string, key: string, code: string, name: string, ordinal: number, evidence: string) => {
      const id = createUlid();
      await connection.execute(
        `INSERT INTO occupation_standard_requirement_nodes (
          id, scope_id, parent_id, node_kind, node_key, source_code, name, ordinal, evidence_text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, scopeId, parentId, kind, key, code, name, ordinal, evidence],
      );
      return id;
    };
    for (const [functionIndex, fn] of scope.functions.entries()) {
      const functionKey = `F${functionIndex + 1}`;
      const functionId = await insertNode(null, "occupational_function", functionKey, fn.code, fn.name, functionIndex + 1, `${fn.code} ${fn.name}`);
      for (const [contentIndex, content] of fn.contents.entries()) {
        const contentKey = `${functionKey}-C${contentIndex + 1}`;
        const contentId = await insertNode(functionId, "work_content", contentKey, content.code, content.name, contentIndex + 1, `${content.code} ${content.name}`);
        for (const [index, requirement] of content.requirements.entries()) {
          await insertNode(contentId, requirement.kind, `${contentKey}-R${index + 1}`, requirement.code, requirement.name, index + 1, requirement.evidence);
        }
      }
    }
  }
}

async function saveImportFile(connection: PoolConnection, projectId: string, file: File, actorId: string, onStored: (path: string) => void) {
  const bytes = Buffer.from(await file.arrayBuffer());
  const id = createUlid();
  const extension = extname(file.name).toLowerCase();
  const uploadDirectory = process.env.UPLOAD_DIR || join(process.cwd(), ".data", "uploads", "blueprint-imports");
  const objectPath = join(uploadDirectory, `${id}${extension}`);
  await mkdir(uploadDirectory, { recursive: true });
  await writeFile(objectPath, bytes);
  onStored(objectPath);
  await connection.execute(
    `INSERT INTO file_objects (
      id, project_id, storage_provider, bucket, object_key, original_name, mime_type, size_bytes, sha256, purpose, created_by
    ) VALUES (?, ?, 'local', 'itembank-local', ?, ?, ?, ?, ?, 'blueprint_import', ?)`,
    [id, projectId, objectPath, basename(file.name), file.type || "application/octet-stream", bytes.length, createHash("sha256").update(bytes).digest("hex"), actorId]
  );
  return { fileObjectId: id, name: file.name };
}

async function getSourceFile(connection: PoolConnection, sourceVersionId: string, projectId: string, occupationId: string) {
  const [rows] = await connection.execute<(RowDataPacket & { id: string; original_name: string })[]>(
    `SELECT fo.id, fo.original_name
       FROM source_versions sv
       INNER JOIN sources s ON s.id = sv.source_id
       INNER JOIN file_objects fo ON fo.id = sv.file_object_id
       INNER JOIN source_scopes ss ON ss.source_version_id = sv.id
      WHERE sv.id = ? AND s.project_id = ? AND s.status = 'active' AND ss.occupation_id = ?`,
    [sourceVersionId, projectId, occupationId]
  );
  if (!rows[0]) throw new TheoryWeightImportError("所选资料不属于当前职业项目。");
  return { fileObjectId: rows[0].id, name: rows[0].original_name };
}

async function getOrCreateTheoryWeightBlueprint(connection: PoolConnection, projectId: string, occupationId: string): Promise<string> {
  const [rows] = await connection.execute<BlueprintRow[]>(
    `SELECT id, current_version_id
       FROM blueprints
      WHERE project_id = ? AND occupation_id = ? AND blueprint_kind = 'theory_weight'
        AND assessment_mode = 'theory' AND level_code = 'level_5'
      ORDER BY created_at
      LIMIT 1
      FOR UPDATE`,
    [projectId, occupationId]
  );
  if (rows[0]) return rows[0].id;

  const blueprintId = createUlid();
  await connection.execute(
    `INSERT INTO blueprints (
      id, project_id, name, blueprint_kind, occupation_id, level_code, assessment_mode, status
    ) VALUES (?, ?, '理论知识权重表', 'theory_weight', ?, 'level_5', 'theory', 'draft')`,
    [blueprintId, projectId, occupationId]
  );
  return blueprintId;
}
