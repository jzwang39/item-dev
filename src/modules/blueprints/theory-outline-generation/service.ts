import { createHash } from "node:crypto";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { generateAssessmentBatch } from "./generation-batch";
import { codeFor } from "./node-code";
import { extractDocxText, extractPdfText } from "@/modules/documents/extraction/service";
import { getSavedModelConnection } from "@/modules/model-connection/service";
import { getCurrentTheoryWeights, type TheoryWeightItem } from "@/modules/blueprints/theory-weights/service";
import { createUlid } from "@/shared/database/ulid";
import { query, withTransaction } from "@/shared/database/mysql";

const levels = ["level_5", "level_4", "level_3", "level_2", "level_1"] as const;
const uploadDirectory = join(process.cwd(), ".data", "uploads", "textbooks");
let modelRequestTail: Promise<void> = Promise.resolve();
type LevelCode = (typeof levels)[number];

type Chapter = {
  id: string;
  ordinal: number;
  chapterTitle: string;
  sectionTitle: string | null;
  content: string;
};
type Textbook = { sourceId: string; sourceVersionId: string; name: string; originalName: string; createdAt: string; chapterCount: number };
type JobRow = RowDataPacket & {
  id: string; status: "queued" | "running" | "succeeded" | "failed"; generation_mode: "textbook" | "model";
  total_batches: number; completed_batches: number; generated_point_count: number; error_message: string | null;
  textbook_source_version_id: string | null; result_blueprint_version_id: string | null; created_at: Date; updated_at: Date;
};
type GeneratedPoint = {
  primaryName: string; primaryWeight: number; secondaryName: string; secondaryWeight: number;
  tertiaryName: string; tertiaryWeight: number; name: string; importanceCode: "X" | "Y" | "Z";
  sourceChapterIds: string[];
};
export class TheoryOutlineGenerationError extends Error {}

export async function listTextbooks(occupationId: string, levelCode: string, assessmentMode: "theory" | "skill" = "theory") {
  validateLevel(levelCode);
  return withTransaction(async (connection) => {
    const projectId = await getProjectForOccupation(connection, occupationId);
    const [rows] = await connection.execute<(RowDataPacket & Textbook)[]>(
      `SELECT s.id AS sourceId, sv.id AS sourceVersionId, s.name, fo.original_name AS originalName,
              sv.created_at AS createdAt, COUNT(DISTINCT tc.id) AS chapterCount
         FROM sources s
         INNER JOIN source_versions sv ON sv.id = s.current_version_id
         INNER JOIN source_scopes ss ON ss.source_version_id = sv.id
         INNER JOIN file_objects fo ON fo.id = sv.file_object_id
         LEFT JOIN textbook_chapters tc ON tc.source_version_id = sv.id
        WHERE s.project_id = ? AND s.source_type = 'textbook' AND s.status = 'active'
          AND ss.occupation_id = ? AND ss.assessment_mode = ?
        GROUP BY s.id, sv.id, s.name, fo.original_name, sv.created_at
        ORDER BY sv.created_at DESC`,
      [projectId, occupationId, assessmentMode],
    );
    return rows.map((row) => ({ ...row, chapterCount: Number(row.chapterCount) }));
  });
}

export async function uploadTextbook(occupationId: string, levelCode: string, file: File | undefined, actorId: string, assessmentMode: "theory" | "skill" = "theory") {
  validateLevel(levelCode);
  if (!file) throw new TheoryOutlineGenerationError(assessmentMode === "skill" ? "请选择操作技能教材。" : "请选择理论知识教材。");
  const extension = extname(file.name).toLowerCase();
  if (![".pdf", ".docx", ".txt"].includes(extension)) throw new TheoryOutlineGenerationError("仅支持 PDF、DOCX、TXT 格式教材。");
  const bytes = Buffer.from(await file.arrayBuffer());
  if (!bytes.length || bytes.length > 30 * 1024 * 1024) throw new TheoryOutlineGenerationError("教材文件不能为空且不得超过 30MB。");
  const text = await extractText(bytes, extension);
  if (text.length < 80) throw new TheoryOutlineGenerationError("教材未提取到足够的可用文本，无法按章节生成细目表。");
  const chapters = splitTextbook(text);
  if (!chapters.length) throw new TheoryOutlineGenerationError("教材未识别出章节内容。");

  let storedPath: string | undefined;
  try {
  return await withTransaction(async (connection) => {
    const projectId = await getProjectForOccupation(connection, occupationId);
    const fileId = createUlid();
    const sourceId = createUlid();
    const sourceVersionId = createUlid();
    const objectPath = join(uploadDirectory, `${fileId}${extension}`);
    await mkdir(uploadDirectory, { recursive: true });
    await writeFile(objectPath, bytes);
    storedPath = objectPath;
    const hash = createHash("sha256").update(bytes).digest("hex");
    const name = basename(file.name, extension);
    await connection.execute(
      `INSERT INTO file_objects (id, project_id, storage_provider, bucket, object_key, original_name, mime_type, size_bytes, sha256, purpose, created_by)
       VALUES (?, ?, 'local', 'itembank-local', ?, ?, ?, ?, ?, 'textbook_upload', ?)`,
      [fileId, projectId, objectPath, basename(file.name), file.type || "application/octet-stream", bytes.length, hash, actorId],
    );
    await connection.execute(
      `INSERT INTO sources (id, project_id, name, source_type, remark, current_version_id, created_by)
       VALUES (?, ?, ?, 'textbook', ?, ?, ?)`,
      [sourceId, projectId, name, assessmentMode === "skill" ? "操作技能教材" : "理论知识教材", sourceVersionId, actorId],
    );
    await connection.execute(
      `INSERT INTO source_versions (id, source_id, version_no, file_object_id, parse_status, content_hash, created_by)
       VALUES (?, ?, 1, ?, 'succeeded', ?, ?)`,
      [sourceVersionId, sourceId, fileId, hash, actorId],
    );
    for (const level of levels) {
      await connection.execute(
        `INSERT INTO source_scopes (id, source_version_id, occupation_id, level_code, assessment_mode)
         VALUES (?, ?, ?, ?, ?)`,
        [createUlid(), sourceVersionId, occupationId, level, assessmentMode],
      );
    }
    for (const chapter of chapters) {
      await connection.execute(
        `INSERT INTO textbook_chapters (id, source_version_id, ordinal, chapter_no, chapter_title, section_no, section_title, content_text, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [createUlid(), sourceVersionId, chapter.ordinal, chapter.chapterNo, chapter.chapterTitle, chapter.sectionNo, chapter.sectionTitle, chapter.content, createHash("sha256").update(chapter.content).digest("hex")],
      );
    }
    await connection.execute(
      `INSERT INTO audit_logs (id, project_id, actor_id, action, object_type, object_id, after_json, result)
       VALUES (?, ?, ?, 'textbook.upload', 'source_version', ?, ?, 'success')`,
      [createUlid(), projectId, actorId, sourceVersionId, JSON.stringify({ occupationId, assessmentMode, levelCodes: levels, chapterCount: chapters.length, fileName: file.name })],
    );
    return { sourceId, sourceVersionId, name, originalName: file.name, chapterCount: chapters.length };
  });
  } catch (error) {
    if (storedPath) await unlink(storedPath).catch(() => undefined);
    throw error;
  }
}

export async function getTheoryOutlineGenerationState(occupationId: string, levelCode: string) {
  const level = validateLevel(levelCode);
  const [jobs, textbooks] = await Promise.all([
    withTransaction(async (connection) => {
      const projectId = await getProjectForOccupation(connection, occupationId);
      const [rows] = await connection.execute<JobRow[]>(
        `SELECT id, status, generation_mode, total_batches, completed_batches, generated_point_count, error_message,
                textbook_source_version_id, result_blueprint_version_id, created_at, updated_at
           FROM theory_outline_generation_jobs
          WHERE project_id = ? AND occupation_id = ? AND level_code = ?
          ORDER BY created_at DESC LIMIT 10`,
        [projectId, occupationId, level],
      );
      return rows;
    }),
    listTextbooks(occupationId, level),
  ]);
  return {
    textbooks,
    jobs: jobs.map((job) => ({
      id: job.id, status: job.status, mode: job.generation_mode, totalBatches: job.total_batches,
      completedBatches: job.completed_batches, generatedPointCount: job.generated_point_count,
      errorMessage: job.error_message, textbookSourceVersionId: job.textbook_source_version_id,
      resultBlueprintVersionId: job.result_blueprint_version_id, createdAt: job.created_at.toISOString(), updatedAt: job.updated_at.toISOString(),
    })),
  };
}

export async function startTheoryOutlineGeneration(occupationId: string, levelCode: string, mode: "textbook" | "model", actorId: string) {
  const level = validateLevel(levelCode);
  const result = await withTransaction(async (connection) => {
    const projectId = await getProjectForOccupation(connection, occupationId);
    let textbookVersionId: string | null = null;
    if (mode === "textbook") {
      const [rows] = await connection.execute<(RowDataPacket & { id: string })[]>(
        `SELECT sv.id FROM sources s INNER JOIN source_versions sv ON sv.id = s.current_version_id
         INNER JOIN source_scopes ss ON ss.source_version_id = sv.id
         WHERE s.project_id = ? AND s.source_type = 'textbook' AND s.status = 'active'
           AND ss.occupation_id = ? AND ss.assessment_mode = 'theory'
         ORDER BY sv.created_at DESC LIMIT 1`,
        [projectId, occupationId],
      );
      textbookVersionId = rows[0]?.id ?? null;
      if (!textbookVersionId) throw new TheoryOutlineGenerationError("请先上传该职业等级的理论知识教材。");
    }
    // A restarted job replaces an interrupted draft for the same grade.
    await connection.execute(
      `UPDATE theory_outline_generation_jobs
       SET status = 'failed', error_message = '已按最新权重规则终止，由新的生成任务替代。',
           finished_at = UTC_TIMESTAMP(3), draft_snapshot_json = NULL
       WHERE occupation_id = ? AND level_code = ? AND status IN ('queued', 'running')`,
      [occupationId, level],
    );
    const id = createUlid();
    await connection.execute(
      `INSERT INTO theory_outline_generation_jobs (id, project_id, occupation_id, level_code, textbook_source_version_id, generation_mode, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, projectId, occupationId, level, textbookVersionId, mode, actorId],
    );
    return { id, projectId, textbookVersionId };
  });
  void runTheoryOutlineGeneration(result.id).catch(() => undefined);
  return { jobId: result.id };
}

async function runTheoryOutlineGeneration(jobId: string) {
  try {
    const job = await loadJob(jobId);
    if (!job) return;
    const weights = await getCurrentTheoryWeights(job.occupation_id);
    if (!weights) throw new TheoryOutlineGenerationError("请先完成理论知识权重表的识别。");
    const weightItems = weights.items.filter((item) => Number(item.weights[job.level_code] ?? 0) > 0);
    if (!weightItems.length) throw new TheoryOutlineGenerationError("当前等级没有可用于生成的理论知识权重。");
    const chapters = job.textbook_source_version_id ? await loadChapters(job.textbook_source_version_id) : [];
    if (job.generation_mode === "textbook" && !chapters.length) throw new TheoryOutlineGenerationError("最新教材没有已解析的章节，无法生成细目表。");
    const batches = weightItems.flatMap((item) => {
      // The stored value is a percentage point (for example 5 means 5%).
      // Each percentage point requires two assessment points.
      const total = Number(item.weights[job.level_code] ?? 0) * 2;
      return Array.from({ length: Math.ceil(total / 10) }, (_, index) => ({
        item, batchIndex: index, batchCount: Math.ceil(total / 10),
        targetCount: Math.min(10, total - index * 10),
      }));
    });
    await query(`UPDATE theory_outline_generation_jobs SET status = 'running', total_batches = ?, started_at = UTC_TIMESTAMP(3) WHERE id = ?`, [batches.length, jobId]);

    const generated: GeneratedPoint[] = [];
    for (const [index, batch] of batches.entries()) {
      const reservedPointKeys = new Set(
        generated
          .filter((point) => point.primaryName === batch.item.category && point.secondaryName === batch.item.name)
          .map((point) => [point.tertiaryName, point.name].join("\u0000")),
      );
      const points = await generateForWeight(job, batch.item, chapters, batch.targetCount, reservedPointKeys, batch.batchIndex, batch.batchCount);
      generated.push(...points);
      await query(
        `UPDATE theory_outline_generation_jobs SET completed_batches = ?, generated_point_count = ?, draft_snapshot_json = ? WHERE id = ?`,
        [index + 1, generated.length, JSON.stringify(generated), jobId],
      );
    }
    const pointKeys = generated.map((point) => [point.primaryName, point.secondaryName, point.tertiaryName, point.name].join("\u0000"));
    if (new Set(pointKeys).size !== generated.length) {
      throw new TheoryOutlineGenerationError("生成结果包含重复考评点，未发布不完整版本。");
    }
    const versionId = await publishGeneratedOutline(job, generated);
    await query(
      `UPDATE theory_outline_generation_jobs SET status = 'succeeded', result_blueprint_version_id = ?, finished_at = UTC_TIMESTAMP(3), error_message = NULL WHERE id = ?`,
      [versionId, jobId],
    );
  } catch (error) {
    await query(
      `UPDATE theory_outline_generation_jobs SET status = 'failed', error_message = ?, finished_at = UTC_TIMESTAMP(3), draft_snapshot_json = NULL WHERE id = ?`,
      [error instanceof Error ? error.message.slice(0, 2000) : "细目表生成失败。", jobId],
    );
  }
}

async function generateForWeight(job: RowDataPacket & { occupation_name: string; level_code: LevelCode; generation_mode: "textbook" | "model" }, item: TheoryWeightItem, chapters: Chapter[], targetCount: number, reservedPointKeys: Set<string>, batchIndex: number, batchCount: number) {
  const weight = Number(item.weights[job.level_code] ?? 0);
  const accepted = await generateAssessmentBatch({
    occupationName: job.occupation_name, levelCode: job.level_code, mode: job.generation_mode,
    category: item.category, topic: item.name, weight, chapters, targetCount, reservedPointKeys,
    batchIndex, batchCount,
  }, callModel);
  const primaryWeight = Number(item.weights[job.level_code] ?? 0);
  return accepted.map((point) => ({
    primaryName: item.category, primaryWeight, secondaryName: item.name, secondaryWeight: weight,
    tertiaryName: point.tertiaryName || item.name, tertiaryWeight: weight, name: point.name,
    importanceCode: point.importance, sourceChapterIds: point.sourceChapterIds,
  }));
}

async function publishGeneratedOutline(job: RowDataPacket & { project_id: string; occupation_id: string; level_code: LevelCode; generation_mode: string; textbook_source_version_id: string | null; created_by: string }, points: GeneratedPoint[]) {
  return withTransaction(async (connection) => {
    const blueprintId = await getOrCreateOutlineBlueprint(connection, job.project_id, job.occupation_id, job.level_code);
    const [versions] = await connection.execute<(RowDataPacket & { version_no: number })[]>(
      "SELECT COALESCE(MAX(version_no), 0) AS version_no FROM blueprint_versions WHERE blueprint_id = ? FOR UPDATE", [blueprintId],
    );
    const versionId = createUlid();
    const versionNo = Number(versions[0].version_no) + 1;
    const snapshot = { sourceName: job.generation_mode === "textbook" ? "最新教材 AI 生成" : "AI 大模型生成", points: points.map((point, index) => ({ ...point, ordinal: index + 1 })) };
    await connection.execute(
      `INSERT INTO blueprint_versions (id, blueprint_id, version_no, status, content_hash, snapshot_json, published_at, created_by)
       VALUES (?, ?, ?, 'published', ?, ?, UTC_TIMESTAMP(3), ?)`,
      [versionId, blueprintId, versionNo, createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"), JSON.stringify(snapshot), job.created_by],
    );
    const categoryCodes = new Map<string, string>();
    const secondaryCodes = new Map<string, string>();
    const tertiaryCodes = new Map<string, string>();
    for (const [index, point] of points.entries()) {
      const primaryCode = codeFor(categoryCodes, point.primaryName);
      const secondaryCode = codeFor(secondaryCodes, `${point.primaryName}|${point.secondaryName}`);
      const tertiaryCode = codeFor(tertiaryCodes, `${point.primaryName}|${point.secondaryName}|${point.tertiaryName}`);
      const prefix = `${primaryCode}-${secondaryCode}-${tertiaryCode}`;
      const ordinal = points.slice(0, index + 1).filter((candidate) => candidate.primaryName === point.primaryName && candidate.secondaryName === point.secondaryName && candidate.tertiaryName === point.tertiaryName).length;
      const nodeId = createUlid();
      const importance = point.importanceCode === "X" ? "critical" : point.importanceCode === "Y" ? "high" : "medium";
      await connection.execute(
        `INSERT INTO blueprint_nodes (id, blueprint_version_id, node_kind, node_code, name, ordinal, weight, importance, requirement_json, source_ref_json)
         VALUES (?, ?, 'assessment_point', ?, ?, ?, ?, ?, ?, ?)`,
        [nodeId, versionId, `${prefix}-${String(ordinal).padStart(3, "0")}`, point.name, index + 1, point.tertiaryWeight, importance,
          JSON.stringify({ primaryNo: primaryCode, primaryName: point.primaryName, primaryWeight: point.primaryWeight, secondaryNo: secondaryCode, secondaryName: point.secondaryName, secondaryWeight: point.secondaryWeight, tertiaryNo: tertiaryCode, tertiaryName: point.tertiaryName, tertiaryWeight: point.tertiaryWeight, importanceCode: point.importanceCode }),
          JSON.stringify({ chapterIds: point.sourceChapterIds })],
      );
      for (const [type, count] of [["single", 4], ["judgement", 2]] as const) {
        await connection.execute(`INSERT INTO theory_outline_point_quotas (id, blueprint_node_id, question_type, target_count) VALUES (?, ?, ?, ?)`, [createUlid(), nodeId, type, count]);
      }
    }
    await connection.execute("UPDATE blueprints SET current_version_id = ?, status = 'published', row_version = row_version + 1 WHERE id = ?", [versionId, blueprintId]);
    if (job.textbook_source_version_id) {
      await connection.execute(
        "INSERT INTO blueprint_version_sources (blueprint_version_id, source_version_id) VALUES (?, ?)",
        [versionId, job.textbook_source_version_id],
      );
    }
    await connection.execute(`INSERT INTO audit_logs (id, project_id, actor_id, action, object_type, object_id, after_json, result) VALUES (?, ?, ?, 'blueprint.theory_outline.generate', 'blueprint_version', ?, ?, 'success')`, [createUlid(), job.project_id, job.created_by, versionId, JSON.stringify({ versionNo, pointCount: points.length })]);
    return versionId;
  });
}

async function loadJob(jobId: string) {
  const rows = await query<(RowDataPacket & { project_id: string; occupation_id: string; level_code: LevelCode; generation_mode: "textbook" | "model"; textbook_source_version_id: string | null; created_by: string; occupation_name: string })[]>(
    `SELECT j.project_id, j.occupation_id, j.level_code, j.generation_mode, j.textbook_source_version_id, j.created_by, po.name AS occupation_name
       FROM theory_outline_generation_jobs j INNER JOIN project_occupations po ON po.id = j.occupation_id WHERE j.id = ? LIMIT 1`, [jobId],
  );
  return rows[0] ?? null;
}
async function loadChapters(sourceVersionId: string) {
  const rows = await query<(RowDataPacket & { id: string; ordinal: number; chapter_title: string; section_title: string | null; content_text: string })[]>(
    "SELECT id, ordinal, chapter_title, section_title, content_text FROM textbook_chapters WHERE source_version_id = ? ORDER BY ordinal", [sourceVersionId],
  );
  return rows.map((row) => ({ id: row.id, ordinal: row.ordinal, chapterTitle: row.chapter_title, sectionTitle: row.section_title, content: row.content_text }));
}
async function extractText(bytes: Buffer, extension: string) {
  if (extension === ".txt") return bytes.toString("utf8").trim();
  if (extension === ".docx") return extractDocxText(bytes);
  return (await extractPdfText(bytes)).text;
}
function splitTextbook(text: string) {
  const lines = text.replace(/\r/g, "").split("\n");
  const headings = lines.map((line, index) => ({ line: line.trim(), index })).filter(({ line }) => /^(第[一二三四五六七八九十百\d]+[章节]|[一二三四五六七八九十]+、|\d+(?:\.\d+){0,2}\s+)/.test(line) && line.length <= 120);
  const usable = headings.filter((heading) => /第[一二三四五六七八九十百\d]+[章节]/.test(heading.line) || /^\d+\.\d+/.test(heading.line));
  const targets = usable.some((heading) => /节/.test(heading.line)) ? usable.filter((heading) => /节/.test(heading.line) || /^\d+\.\d+/.test(heading.line)) : usable.filter((heading) => /章/.test(heading.line) || /^\d+\s/.test(heading.line));
  if (!targets.length) return [{ ordinal: 1, chapterNo: null, chapterTitle: "教材全文", sectionNo: null, sectionTitle: null, content: text }];
  return targets.map((heading, index) => {
    const end = targets[index + 1]?.index ?? lines.length;
    const match = heading.line.match(/^(第[一二三四五六七八九十百\d]+[章节]|\d+(?:\.\d+)*)\s*(.*)$/);
    return { ordinal: index + 1, chapterNo: match?.[1] ?? null, chapterTitle: match?.[2] || heading.line, sectionNo: /节/.test(heading.line) ? match?.[1] ?? null : null, sectionTitle: /节/.test(heading.line) ? match?.[2] || heading.line : null, content: lines.slice(heading.index, end).join("\n").trim() };
  }).filter((chapter) => chapter.content.length >= 40);
}
function validateLevel(level: string): LevelCode {
  if (!levels.includes(level as LevelCode)) throw new TheoryOutlineGenerationError("技能等级无效。");
  return level as LevelCode;
}
async function getProjectForOccupation(connection: PoolConnection, occupationId: string) {
  const [rows] = await connection.execute<(RowDataPacket & { id: string })[]>(`SELECT p.id FROM projects p INNER JOIN project_occupations po ON po.project_id = p.id WHERE po.id = ? AND po.status = 'active' AND p.status = 'active' FOR UPDATE`, [occupationId]);
  if (!rows[0]) throw new TheoryOutlineGenerationError("职业不存在、已归档或不属于当前启用项目。");
  return rows[0].id;
}
async function getOrCreateOutlineBlueprint(connection: PoolConnection, projectId: string, occupationId: string, level: LevelCode) {
  const [rows] = await connection.execute<(RowDataPacket & { id: string })[]>(`SELECT id FROM blueprints WHERE project_id = ? AND occupation_id = ? AND level_code = ? AND blueprint_kind = 'theory_outline' AND assessment_mode = 'theory' LIMIT 1 FOR UPDATE`, [projectId, occupationId, level]);
  if (rows[0]) return rows[0].id;
  const id = createUlid();
  await connection.execute(`INSERT INTO blueprints (id, project_id, name, blueprint_kind, occupation_id, level_code, assessment_mode) VALUES (?, ?, '理论知识考评要素细目表', 'theory_outline', ?, ?, 'theory')`, [id, projectId, occupationId, level]);
  return id;
}
function getEndpoint(baseUrl: string, provider: string) {
  const url = new URL(baseUrl); url.pathname = url.pathname.replace(/\/+$/, "");
  const zhipu = url.hostname === "open.bigmodel.cn" && url.pathname.startsWith("/api/paas/");
  const anthropic = !zhipu && (provider.toLowerCase().includes("claude") || provider.toLowerCase().includes("anthropic") || url.pathname.endsWith("/messages"));
  if (anthropic) return { url: url.toString(), protocol: "anthropic" as const };
  if (!url.pathname.endsWith("/chat/completions")) { if (!(zhipu && url.pathname.endsWith("/api/paas/v4")) && !url.pathname.endsWith("/v1")) url.pathname = `${url.pathname}/v1`; url.pathname = `${url.pathname}/chat/completions`; }
  return { url: url.toString(), protocol: "openai" as const };
}
export async function callModel(instruction: string, prompt: string, temperature = 0) {
  const connection = await getSavedModelConnection();
  if (!connection) throw new TheoryOutlineGenerationError("未配置可用模型连接，请先在模型设置中保存配置。");
  const target = getEndpoint(connection.baseUrl, connection.provider);
  return withModelRequestSlot(async () => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetch(target.url, { method: "POST", headers: target.protocol === "anthropic" ? { "x-api-key": connection.apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" } : { Authorization: `Bearer ${connection.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(target.protocol === "anthropic" ? { model: connection.model, temperature, max_tokens: 8192, system: instruction, messages: [{ role: "user", content: prompt }] } : { model: connection.model, temperature, max_tokens: 8192, response_format: { type: "json_object" }, messages: [{ role: "system", content: instruction }, { role: "user", content: prompt }] }), signal: AbortSignal.timeout(90 * 1000) });
        const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }>; content?: Array<{ text?: string }>; error?: { message?: string } };
        if (response.ok) return target.protocol === "anthropic" ? payload.content?.[0]?.text ?? "" : payload.choices?.[0]?.message?.content ?? "";
        if (response.status < 500 && response.status !== 429) throw new TheoryOutlineGenerationError(payload.error?.message || `AI 接口调用失败（${response.status}）。`);
        lastError = new TheoryOutlineGenerationError(payload.error?.message || `AI 接口调用失败（${response.status}）。`);
      } catch (error) {
        if (error instanceof TheoryOutlineGenerationError && !/（(?:429|5\d\d)）/.test(error.message)) throw error;
        lastError = error;
      }
      if (attempt < 3) await wait(1000 * attempt);
    }
    throw lastError instanceof Error ? lastError : new TheoryOutlineGenerationError("AI 接口调用失败。");
  });
}
async function withModelRequestSlot<T>(work: () => Promise<T>) {
  let release: (() => void) | undefined;
  const previous = modelRequestTail;
  modelRequestTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await work();
  } finally {
    await wait(500);
    release?.();
  }
}
function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
