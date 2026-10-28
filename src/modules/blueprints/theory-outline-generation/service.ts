import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { codeFor } from "./node-code";
import { isTheoryOutlineGenerationLevel } from "./policy";
import { generateTextbookOutlines, generateStandardOutlines, validateTextbookInputs, validateStandardInputs, type StandardKnowledge, type TextbookPoint } from "./textbook-generation";
import { parseStandardBasicItems, type StandardBasicSource } from "./standard-basic";
import { planTextbookQuotas, planStandardQuotas, type TextbookWeight, type TextbookQuotaPlan } from "./textbook-quota";
import { extractDocxText, extractPdfText } from "@/modules/documents/extraction/service";
import { getSavedModelConnection } from "@/modules/model-connection/service";
import { createUlid } from "@/shared/database/ulid";
import { query, withTransaction } from "@/shared/database/mysql";
import { ensureSharedOccupationStandard } from "../shared-standard";

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
  primaryName: string; primaryWeight: number | null; secondaryName: string; secondaryWeight: number | null;
  tertiaryName: string; tertiaryWeight: number | null; name: string; importanceCode: "X" | "Y" | "Z";
  sourceChapterIds: string[];
  sectionKind?: TextbookPoint["sectionKind"];
  sharedPointKey?: string;
  standardSource?: StandardKnowledge;
  quotaSource?: TextbookPoint["quotaSource"];
  standardBasicSource?: StandardBasicSource;
  sourceWarning?: string;
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
        ORDER BY sv.created_at DESC, sv.id DESC`,
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
  const jobs = await startOutlineGeneration(occupationId, [levelCode], actorId, mode);
  return jobs[0];
}

async function loadStandardKnowledge(connection: PoolConnection, occupationId: string) {
  const [scopes] = await connection.execute<(RowDataPacket & { direction_id: string | null; total: number })[]>(
    `SELECT s.direction_id, COUNT(r.id) AS total FROM blueprints b
     INNER JOIN occupation_standard_requirement_scopes s ON s.blueprint_version_id = b.current_version_id
     LEFT JOIN occupation_standard_requirement_nodes r ON r.scope_id = s.id AND r.node_kind = 'related_knowledge'
     WHERE b.occupation_id = ? AND s.occupation_id = ? AND b.blueprint_kind = 'theory_weight' AND b.assessment_mode = 'theory'
     GROUP BY s.direction_id`,
    [occupationId, occupationId],
  );
  if (scopes.some((scope) => scope.direction_id !== null)) {
    throw new TheoryOutlineGenerationError("当前标准包含职业方向，不能混合生成职业级细目表。");
  }
  const [rows] = await connection.execute<(RowDataPacket & StandardKnowledge & { directionId: string | null })[]>(
    `SELECT r.id, s.level_code AS levelCode, s.direction_id AS directionId,
            f.source_code AS functionCode, f.name AS functionName,
            c.source_code AS contentCode, c.name AS contentName,
            r.source_code AS code, r.name, r.evidence_text AS evidence,
            s.blueprint_version_id AS blueprintVersionId, s.file_object_id AS fileObjectId,
            s.source_version_id AS sourceVersionId
       FROM blueprints b
       INNER JOIN occupation_standard_requirement_scopes s ON s.blueprint_version_id = b.current_version_id
       INNER JOIN occupation_standard_requirement_nodes r ON r.scope_id = s.id AND r.node_kind = 'related_knowledge'
       INNER JOIN occupation_standard_requirement_nodes c ON c.id = r.parent_id AND c.scope_id = s.id AND c.node_kind = 'work_content'
       INNER JOIN occupation_standard_requirement_nodes f ON f.id = c.parent_id AND f.scope_id = s.id AND f.node_kind = 'occupational_function'
      WHERE b.occupation_id = ? AND s.occupation_id = ? AND b.blueprint_kind = 'theory_weight' AND b.assessment_mode = 'theory'
      ORDER BY s.level_code, f.ordinal, c.ordinal, r.ordinal`,
    [occupationId, occupationId],
  );
  if (rows.length !== scopes.reduce((sum, scope) => sum + Number(scope.total), 0)) {
    throw new TheoryOutlineGenerationError("相关知识要求存在缺失的职业功能或工作内容父级，请重新识别职业标准。");
  }
  return rows;
}

export async function startTextbookOutlineGeneration(occupationId: string, requestedLevels: readonly string[], actorId: string) {
  return startOutlineGeneration(occupationId, requestedLevels, actorId, "textbook");
}

export async function startStandardOutlineGeneration(occupationId: string, requestedLevels: readonly string[], actorId: string) {
  return startOutlineGeneration(occupationId, requestedLevels, actorId, "model");
}

async function loadStandardBasic(connection: PoolConnection, knowledge: StandardKnowledge[], projectId: string) {
  const refs = new Map(knowledge.map((item) => [`${item.blueprintVersionId}:${item.fileObjectId}`, item]));
  if (refs.size !== 1) throw new TheoryOutlineGenerationError("未找到唯一的当前职业标准版本，请先识别完整职业标准。");
  const ref = [...refs.values()][0];
  const [files] = await connection.execute<(RowDataPacket & { object_key: string; original_name: string })[]>(
    "SELECT object_key, original_name FROM file_objects WHERE id = ? AND project_id = ?",
    [ref.fileObjectId, projectId],
  );
  if (!files[0]) throw new TheoryOutlineGenerationError("职业标准原文件不存在，请重新上传标准。");
  const extension = extname(files[0].original_name).toLowerCase();
  if (![".pdf", ".docx", ".txt"].includes(extension)) throw new TheoryOutlineGenerationError("标准原文件仅支持 PDF、DOCX、TXT。");
  try {
    const text = await extractText(await readFile(files[0].object_key), extension);
    return parseStandardBasicItems(text).map((item) => ({
      ...item, blueprintVersionId: ref.blueprintVersionId, fileObjectId: ref.fileObjectId, sourceVersionId: ref.sourceVersionId,
    }));
  } catch (error) {
    throw new TheoryOutlineGenerationError(`标准公共基本条目读取失败：${error instanceof Error ? error.message : "请重新上传完整标准。"}`);
  }
}

async function startOutlineGeneration(occupationId: string, requestedLevels: readonly string[], actorId: string, mode: "textbook" | "model") {
  const selectedLevels = Array.from(new Set(requestedLevels)).map(validateLevel);
  if (!selectedLevels.length || selectedLevels.some((level) => !isTheoryOutlineGenerationLevel(level))) {
    throw new TheoryOutlineGenerationError("本次仅支持五级、四级、三级。");
  }
  await ensureSharedOccupationStandard(occupationId, actorId);
  const input = await withTransaction(async (connection) => {
    const projectId = await getProjectForOccupation(connection, occupationId);
    const [active] = await connection.execute<RowDataPacket[]>(
      `SELECT id FROM theory_outline_generation_jobs WHERE occupation_id = ? AND status IN ('queued', 'running') LIMIT 1 FOR UPDATE`,
      [occupationId],
    );
    if (active.length) throw new TheoryOutlineGenerationError("当前职业已有生成任务，请等待完成后再生成。");
    const [textbooks] = mode === "textbook" ? await connection.execute<(RowDataPacket & { id: string })[]>(
      `SELECT DISTINCT sv.id, sv.created_at FROM sources s
       INNER JOIN source_versions sv ON sv.id = s.current_version_id
       INNER JOIN source_scopes ss ON ss.source_version_id = sv.id
       WHERE s.project_id = ? AND s.source_type = 'textbook' AND s.status = 'active'
         AND ss.occupation_id = ? AND ss.assessment_mode = 'theory'
       ORDER BY sv.created_at DESC, sv.id DESC LIMIT 1`,
      [projectId, occupationId],
    ) : [[]];
    const textbookVersionId = textbooks[0]?.id ?? null;
    if (mode === "textbook" && !textbookVersionId) throw new TheoryOutlineGenerationError("请先上传一次基础知识教材，后续自动使用最新教材。");
    const chapters = textbookVersionId ? await loadChapters(textbookVersionId, connection) : [];
    const knowledge = await loadStandardKnowledge(connection, occupationId);
    const basic = mode === "model" ? await loadStandardBasic(connection, knowledge, projectId) : [];
    const [weightRows] = await connection.execute<(RowDataPacket & { id: string; name: string; blueprintVersionId: string; requirement_json: string | { category: string; weights: Record<string, number | null> } })[]>(
      `SELECT n.id,n.name,n.requirement_json,b.current_version_id AS blueprintVersionId
       FROM blueprints b JOIN blueprint_nodes n ON n.blueprint_version_id=b.current_version_id AND n.node_kind='weight_item'
       WHERE b.project_id=? AND b.occupation_id=? AND b.blueprint_kind='theory_weight' AND b.assessment_mode='theory'
       ORDER BY n.ordinal`, [projectId, occupationId],
    );
    const weights: TextbookWeight[] = weightRows.map((row) => ({
      id: row.id, name: row.name, blueprintVersionId: row.blueprintVersionId,
      ...(typeof row.requirement_json === "string" ? JSON.parse(row.requirement_json) : row.requirement_json),
    }));
    const plans = mode === "textbook" ? planTextbookQuotas(chapters, knowledge, selectedLevels, weights)
      : planStandardQuotas(basic, knowledge, selectedLevels, weights);
    const sharedIds = mode === "textbook" ? chapters.map((chapter) => chapter.id) : basic.map((item) => item.code);
    const sharedBatches = sharedIds.filter((id) => selectedLevels.some((level) =>
      plans.get(level)!.basic.some((quota) => quota.sourceId === id && quota.count > 0))).length;
    try {
      if (mode === "textbook") validateTextbookInputs(chapters, knowledge, selectedLevels);
      else validateStandardInputs(basic, knowledge, selectedLevels);
    } catch (error) {
      throw new TheoryOutlineGenerationError(error instanceof Error ? error.message : "教材或标准条目不完整。");
    }
    const jobs: Array<{ jobId: string; level: LevelCode }> = [];
    for (const level of selectedLevels) {
      const jobId = createUlid();
      await connection.execute(
        `INSERT INTO theory_outline_generation_jobs
          (id, project_id, occupation_id, level_code, textbook_source_version_id, generation_mode, total_batches, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [jobId, projectId, occupationId, level, textbookVersionId, mode,
          sharedBatches + plans.get(level)!.related.filter((quota) => quota.count > 0).length, actorId],
      );
      jobs.push({ jobId, level });
    }
    return { jobs, chapters, knowledge, basic, mode, weights };
  });
  void runOutlineGeneration(input).catch(() => undefined);
  return input.jobs.map(({ jobId }) => ({ jobId }));
}

async function runOutlineGeneration(input: {
  jobs: Array<{ jobId: string; level: LevelCode }>; chapters: Chapter[]; knowledge: StandardKnowledge[];
  basic: StandardBasicSource[]; mode: "textbook" | "model";
  weights: TextbookWeight[];
}) {
  const ids = input.jobs.map((job) => job.jobId);
  const placeholders = ids.map(() => "?").join(",");
  try {
    await query(`UPDATE theory_outline_generation_jobs SET status = 'running', started_at = UTC_TIMESTAMP(3) WHERE id IN (${placeholders})`, ids);
    const first = await loadJob(ids[0]);
    if (!first) throw new TheoryOutlineGenerationError("生成任务不存在。");
    const onProgress = async (level: string, completed: number, points: TextbookPoint[]) => {
        await query(
          `UPDATE theory_outline_generation_jobs SET completed_batches = ?, generated_point_count = ?, draft_snapshot_json = ? WHERE id = ? AND status = 'running'`,
          [completed, points.length, JSON.stringify(points), input.jobs.find((job) => job.level === level)!.jobId],
        );
    };
    const result = input.mode === "textbook"
      ? await generateTextbookOutlines(first.occupation_name, input.chapters, input.knowledge, input.jobs.map((job) => job.level), callModel, onProgress, input.weights)
      : await generateStandardOutlines(first.occupation_name, input.basic, input.knowledge, input.jobs.map((job) => job.level), callModel, onProgress, input.weights);
    // Publish all selected grades and their shared foundation in one transaction.
    await withTransaction(async (connection) => {
      await getProjectForOccupation(connection, first.occupation_id);
      {
        const [versions] = await connection.execute<(RowDataPacket & { current_version_id: string })[]>(
          "SELECT current_version_id FROM blueprints WHERE occupation_id=? AND blueprint_kind='theory_weight' AND assessment_mode='theory' FOR UPDATE",
          [first.occupation_id],
        );
        if (!input.weights.every((weight) => versions.some((version) => version.current_version_id === weight.blueprintVersionId))) {
          throw new TheoryOutlineGenerationError("生成期间权重表已变化，未发布新版本，请重新生成。");
        }
      }
      const [jobs] = await connection.execute<(RowDataPacket & { id: string; status: string })[]>(
        `SELECT id, status FROM theory_outline_generation_jobs WHERE id IN (${placeholders}) FOR UPDATE`, ids,
      );
      if (jobs.length !== ids.length || jobs.some((job) => job.status !== "running")) {
        throw new TheoryOutlineGenerationError("生成任务已终止，未发布新版本。");
      }
      const quotaPlans = input.mode === "textbook"
        ? planTextbookQuotas(input.chapters, input.knowledge, input.jobs.map((job) => job.level), input.weights)
        : planStandardQuotas(input.basic, input.knowledge, input.jobs.map((job) => job.level), input.weights);
      for (const { jobId, level } of input.jobs) {
        const versionId = await saveGeneratedOutline(connection, { ...first, level_code: level }, result.get(level)!, quotaPlans.get(level));
        await connection.execute(
          `UPDATE theory_outline_generation_jobs SET status = 'succeeded', result_blueprint_version_id = ?, finished_at = UTC_TIMESTAMP(3), error_message = NULL, draft_snapshot_json = NULL WHERE id = ?`,
          [versionId, jobId],
        );
      }
    });
  } catch (error) {
    await query(
      `UPDATE theory_outline_generation_jobs SET status = 'failed', error_message = ?, finished_at = UTC_TIMESTAMP(3), draft_snapshot_json = NULL WHERE id IN (${placeholders}) AND status IN ('queued', 'running')`,
      [error instanceof Error ? error.message.slice(0, 2000) : "教材与标准生成失败。", ...ids],
    );
  }
}

async function saveGeneratedOutline(connection: PoolConnection, job: RowDataPacket & { project_id: string; occupation_id: string; level_code: LevelCode; generation_mode: string; textbook_source_version_id: string | null; created_by: string }, points: GeneratedPoint[], quotaPlan?: TextbookQuotaPlan) {
    const blueprintId = await getOrCreateOutlineBlueprint(connection, job.project_id, job.occupation_id, job.level_code);
    const [versions] = await connection.execute<(RowDataPacket & { version_no: number })[]>(
      "SELECT COALESCE(MAX(version_no), 0) AS version_no FROM blueprint_versions WHERE blueprint_id = ? FOR UPDATE", [blueprintId],
    );
    const versionId = createUlid();
    const versionNo = Number(versions[0].version_no) + 1;
    const snapshot = { sourceName: job.generation_mode === "textbook" ? "教材公共基础池 + 对应等级职业标准（权重值×2）" : "职业标准公共基础池 + 对应等级相关知识要求（权重值×2）", quotaPlan, points: points.map((point, index) => ({ ...point, ordinal: index + 1 })) };
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
          JSON.stringify({ primaryNo: primaryCode, primaryName: point.primaryName, primaryWeight: point.primaryWeight, secondaryNo: secondaryCode, secondaryName: point.secondaryName, secondaryWeight: point.secondaryWeight, tertiaryNo: tertiaryCode, tertiaryName: point.tertiaryName, tertiaryWeight: point.tertiaryWeight, importanceCode: point.importanceCode, sectionKind: point.sectionKind, sharedPointKey: point.sharedPointKey, standardSource: point.standardSource, quotaSource: point.quotaSource, remark: point.sourceWarning }),
          JSON.stringify({ chapterIds: point.sourceChapterIds, sharedPointKey: point.sharedPointKey, standard: point.standardSource, standardBasic: point.standardBasicSource })],
      );
      for (const [type, count] of [["single", 4], ["judgement", 2]] as const) {
        await connection.execute(`INSERT INTO theory_outline_point_quotas (id, blueprint_node_id, question_type, target_count) VALUES (?, ?, ?, ?)`, [createUlid(), nodeId, type, count]);
      }
    }
    const standardSourceIds = new Set(points.flatMap((point) => [point.standardSource?.sourceVersionId, point.standardBasicSource?.sourceVersionId].filter((id): id is string => Boolean(id))));
    for (const sourceId of standardSourceIds) {
      await connection.execute("INSERT INTO blueprint_version_sources (blueprint_version_id, source_version_id) VALUES (?, ?)", [versionId, sourceId]);
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
}

async function loadJob(jobId: string) {
  const rows = await query<(RowDataPacket & { project_id: string; occupation_id: string; level_code: LevelCode; generation_mode: "textbook" | "model"; textbook_source_version_id: string | null; created_by: string; occupation_name: string })[]>(
    `SELECT j.project_id, j.occupation_id, j.level_code, j.generation_mode, j.textbook_source_version_id, j.created_by, po.name AS occupation_name
       FROM theory_outline_generation_jobs j INNER JOIN project_occupations po ON po.id = j.occupation_id WHERE j.id = ? LIMIT 1`, [jobId],
  );
  return rows[0] ?? null;
}
async function loadChapters(sourceVersionId: string, connection?: PoolConnection) {
  type ChapterRow = RowDataPacket & { id: string; ordinal: number; chapter_title: string; section_title: string | null; content_text: string };
  const sql = "SELECT id, ordinal, chapter_title, section_title, content_text FROM textbook_chapters WHERE source_version_id = ? ORDER BY ordinal, id";
  const rows = connection
    ? (await connection.execute<ChapterRow[]>(sql, [sourceVersionId]))[0]
    : await query<ChapterRow[]>(sql, [sourceVersionId]);
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
