import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";

import type { PoolConnection, RowDataPacket } from "mysql2/promise";

import { createUlid } from "@/shared/database/ulid";
import { withTransaction } from "@/shared/database/mysql";

const execFileAsync = promisify(execFile);
const levels = ["level_5", "level_4", "level_3", "level_2", "level_1"] as const;
const uploadDirectory = "/tmp/itembank-blueprint-imports";
const pdfExtractorPath = "/tmp/itembank-pdf-text-extractor";
const pdfExtractionTimeoutMs = 10 * 60 * 1000;

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
};

export class TheoryWeightImportError extends Error {}

export async function listOccupationStandards(occupationId: string): Promise<SourceRow[]> {
  return withTransaction(async (connection) => {
    const projectId = await getProjectForOccupation(connection, occupationId);
    const [rows] = await connection.execute<SourceRow[]>(
      `SELECT sv.id, s.name, fo.original_name
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
    const [rows] = await connection.execute<(RowDataPacket & {
      id: string;
      version_no: number;
      snapshot_json: string | Omit<TheoryWeightSnapshot, "versionId" | "versionNo" | "importedAt">;
      created_at: Date;
    })[]>(
      `SELECT bv.id, bv.version_no, bv.snapshot_json, bv.created_at
         FROM blueprints b
         INNER JOIN blueprint_versions bv ON bv.id = b.current_version_id
        WHERE b.project_id = ?
          AND b.occupation_id = ?
          AND b.blueprint_kind = 'theory_weight'
          AND b.assessment_mode = 'theory'
        ORDER BY b.updated_at DESC
        LIMIT 1`,
      [projectId, occupationId]
    );
    const current = rows[0];
    if (!current) {
      return null;
    }
    const snapshot = typeof current.snapshot_json === "string"
      ? JSON.parse(current.snapshot_json) as Omit<TheoryWeightSnapshot, "versionId" | "versionNo" | "importedAt">
      : current.snapshot_json;
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
    : await extractSourceText(input.sourceVersionId!);
  const items = parseTheoryWeights(extracted.text);
  validateWeights(items);

  return withTransaction(async (connection) => {
    const projectId = await getProjectForOccupation(connection, occupationId);
    const source = input.file
      ? await saveImportFile(connection, projectId, input.file, actorId)
      : await getSourceFile(connection, input.sourceVersionId!, projectId, occupationId);
    const blueprintId = await getOrCreateTheoryWeightBlueprint(connection, projectId, occupationId);
    const [versionRows] = await connection.execute<(RowDataPacket & { version_no: number })[]>(
      "SELECT COALESCE(MAX(version_no), 0) AS version_no FROM blueprint_versions WHERE blueprint_id = ? FOR UPDATE",
      [blueprintId]
    );
    const versionNo = Number(versionRows[0].version_no) + 1;
    const versionId = createUlid();
    const snapshot = {
      sourceName: source.name,
      usedOcr: extracted.usedOcr,
      items
    };
    const contentHash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");

    await connection.execute(
      `INSERT INTO blueprint_versions (
        id, blueprint_id, version_no, status, content_hash, snapshot_json, published_at, created_by
      ) VALUES (?, ?, ?, 'published', ?, ?, UTC_TIMESTAMP(3), ?)`,
      [versionId, blueprintId, versionNo, contentHash, JSON.stringify(snapshot), actorId]
    );

    for (const [index, item] of items.entries()) {
      await connection.execute(
        `INSERT INTO blueprint_nodes (
          id, blueprint_version_id, parent_id, node_kind, node_code, name, ordinal, weight, requirement_json, source_ref_json
        ) VALUES (?, ?, NULL, 'weight_item', ?, ?, ?, NULL, ?, ?)`,
        [
          createUlid(),
          versionId,
          `theory-weight-${String(index + 1).padStart(3, "0")}`,
          item.name,
          index + 1,
          JSON.stringify({ category: item.category, weights: item.weights }),
          JSON.stringify({ sourceName: source.name, usedOcr: extracted.usedOcr })
        ]
      );
    }

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
        JSON.stringify({ occupationId, assessmentMode: "theory", levelCodes: levels }),
        JSON.stringify({ usedOcr: extracted.usedOcr, itemCount: items.length, totals: calculateTotals(items) }),
        actorId
      ]
    );
    if (input.sourceVersionId) {
      await connection.execute(
        "INSERT INTO blueprint_version_sources (blueprint_version_id, source_version_id) VALUES (?, ?)",
        [versionId, input.sourceVersionId]
      );
    }
    await connection.execute(
      `INSERT INTO audit_logs (
        id, project_id, actor_id, action, object_type, object_id, after_json, result
      ) VALUES (?, ?, ?, 'blueprint.theory_weight.import', 'blueprint_version', ?, ?, 'success')`,
      [createUlid(), projectId, actorId, versionId, JSON.stringify({ versionNo, itemCount: items.length, sourceName: source.name })]
    );

    return {
      ...snapshot,
      versionId,
      versionNo,
      importedAt: new Date().toISOString()
    };
  });
}

async function extractUploadedText(file: File): Promise<{ text: string; usedOcr: boolean }> {
  const extension = extname(file.name).toLowerCase();
  if (![".pdf", ".docx", ".txt"].includes(extension)) {
    throw new TheoryWeightImportError("仅支持 PDF、DOCX 或 TXT 格式的国家职业标准。");
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length === 0 || bytes.length > 30 * 1024 * 1024) {
    throw new TheoryWeightImportError("文件不能为空且不得超过 30MB。");
  }
  await mkdir(uploadDirectory, { recursive: true });
  const temporaryPath = join(uploadDirectory, `${createUlid()}${extension}`);
  await writeFile(temporaryPath, bytes);

  if (extension === ".txt") {
    return { text: bytes.toString("utf8"), usedOcr: false };
  }
  if (extension === ".docx") {
    const { stdout } = await execFileAsync("/usr/bin/textutil", ["-convert", "txt", "-stdout", temporaryPath], { maxBuffer: 12 * 1024 * 1024 });
    return { text: stdout, usedOcr: false };
  }

  try {
    await ensurePdfExtractor();
    const { stdout } = await execFileAsync(pdfExtractorPath, [temporaryPath], {
      maxBuffer: 20 * 1024 * 1024,
      // Scanned occupational standards can require several minutes of Vision OCR.
      timeout: pdfExtractionTimeoutMs
    });
    return JSON.parse(stdout) as { text: string; usedOcr: boolean };
  } catch (error) {
    throw new TheoryWeightImportError(`PDF 文本提取或 OCR 失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

async function ensurePdfExtractor() {
  try {
    await access(pdfExtractorPath);
    return;
  } catch {
    await execFileAsync(
      "/usr/bin/xcrun",
      [
        "swiftc",
        "-framework", "PDFKit",
        "-framework", "Vision",
        "-framework", "AppKit",
        join(process.cwd(), "scripts", "extract-pdf-text.swift"),
        "-o", pdfExtractorPath
      ],
      { timeout: 120000 }
    );
  }
}

async function extractSourceText(sourceVersionId: string): Promise<{ text: string; usedOcr: boolean }> {
  return withTransaction(async (connection) => {
    const [rows] = await connection.execute<SourceTextRow[]>(
      `SELECT content_excerpt
         FROM source_segments
        WHERE source_version_id = ?
        ORDER BY ordinal`,
      [sourceVersionId]
    );
    const text = rows.map((row) => row.content_excerpt).join("\n");
    if (!text.trim()) {
      throw new TheoryWeightImportError("该资料尚无可用解析文本，请重新解析或使用本地文件上传。");
    }
    return { text, usedOcr: false };
  });
}

function parseTheoryWeights(text: string): TheoryWeightItem[] {
  const items: TheoryWeightItem[] = [];
  let category = "未分类";
  const theorySection = getTheoryWeightSection(text);

  for (const rawLine of theorySection.replace(/\r/g, "\n").split("\n")) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line) continue;
    const cells = getWeightCells(line);
    if (!cells) {
      if (line.length <= 20 && !/[。；，：]/.test(line)) category = line;
      continue;
    }
    const first = line.match(/(?:—|--|-|\d+(?:\.\d+)?%?)/);
    if (!first || first.index === undefined) continue;
    const name = line.slice(0, first.index).replace(/[|｜、:：]/g, " ").trim();
    if (!name || /等级|初级工|中级工|高级工|技师|百分比|权重|合计/.test(name)) continue;
    items.push({
      category,
      name,
      weights: Object.fromEntries(levels.map((level, index) => [level, parseWeight(cells[index])])) as TheoryWeightItem["weights"]
    });
  }

  if (!items.length) {
    throw new TheoryWeightImportError("未能从文件中识别出“项目 + 五个等级权重”的完整表格。请上传含可复制文本的国家职业标准，或先完成扫描件 OCR。");
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
  const tokens = [...line.matchAll(/(?:—|--|-|\d+(?:\.\d+)?%?)/g)].map((token) => token[0]);

  // Some PDF text layers merge adjacent one-digit cells, e.g. "5 5 5 5 5" becomes "55555".
  if (tokens.length === 1 && /^\d{5}$/.test(tokens[0])) {
    return [...tokens[0]];
  }
  if (tokens.length !== 5) return null;

  const values = tokens.map(parseWeight);
  return values.every((value) => value === null || (value >= 0 && value <= 100)) ? tokens : null;
}

function parseWeight(value: string): number | null {
  if (value === "—" || value === "-" || value === "--") return null;
  const parsed = Number(value.replace("%", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function validateWeights(items: TheoryWeightItem[]) {
  const totals = calculateTotals(items);
  for (const level of levels) {
    if (Math.abs(totals[level] - 100) > 0.0001) {
      throw new TheoryWeightImportError(`${level} 的权重合计为 ${totals[level]}%，不等于 100%，本次不会覆盖已有权重表。`);
    }
  }
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

async function saveImportFile(connection: PoolConnection, projectId: string, file: File, actorId: string) {
  const bytes = Buffer.from(await file.arrayBuffer());
  const id = createUlid();
  const extension = extname(file.name).toLowerCase();
  const objectPath = join(uploadDirectory, `${id}${extension}`);
  await mkdir(uploadDirectory, { recursive: true });
  await writeFile(objectPath, bytes);
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
