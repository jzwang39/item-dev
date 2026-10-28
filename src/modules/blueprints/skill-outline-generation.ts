import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { getPool, query, withTransaction } from "@/shared/database/mysql";
import { createUlid } from "@/shared/database/ulid";
import { getSkillStandard } from "./skill-standard-import";
import { ensureSharedOccupationStandard } from "./shared-standard";
import type { StandardScope } from "./skill-standard";
import { isSkillGenerationLevel, skillGenerationLevels, skillGenerationRule, skillOutlineWorkerVersion } from "./skill-generation-policy";
import { listTextbooks, callModel } from "./theory-outline-generation/service";
import type { ModelCaller } from "./theory-outline-generation/generation-batch";
import { codeFor } from "./theory-outline-generation/node-code";
import { extractSkillKnowledge, knowledgeEntryKey, splitKnowledgeText } from "./skill-knowledge-extraction";
import type { SkillAssessmentPoint } from "./skill-outlines/service";
import { extractDocxText, extractPdfText } from "@/modules/documents/extraction/service";
import {
  bindStandardSkillRequirements, expandStandardSkillHierarchy, generateStandardSkillEntries, standardSkillBatches,
  type BoundSkillRequirement, type StandardSkillRequirement, type StandardSkillEntry,
} from "./skill-standard-generation";

export type GeneratedSkillPoint = SkillAssessmentPoint & {
  direction: string; scopeKey: string; levelCode: string; importanceCode: "X" | "Y" | "Z";
  level1Weight: number; level2Weight: number; sourceChapterIds: string[];
  sourceKnowledgePoint?: { id: string; name: string; evidence: string; locator: string };
  sourceStandardRequirement?: BoundSkillRequirement;
};
type Basis = { versionId: string; sourceName: string; fileObjectId?: string; standardText?: string; scopes: StandardScope[]; generationRule?: string; standardRequirements?: BoundSkillRequirement[] };
type Job = RowDataPacket & {
  id: string; project_id: string; occupation_id: string; created_by: string; occupation_name: string;
  generation_mode: "textbook" | "model"; target_questions: number; status: string;
  textbook_source_version_id: string | null; basis_snapshot_json: Basis | string;
  draft_snapshot_json: { points: GeneratedSkillPoint[] } | string | null;
  completed_batches: number; total_batches: number; generated_point_count: number;
  error_message: string | null; result_versions_json: unknown;
};
const json = <T,>(value: T | string): T => typeof value === "string" ? JSON.parse(value) : value;
const generatedPointKey = (point: GeneratedSkillPoint) => point.sourceStandardRequirement?.id ??
  knowledgeEntryKey({ scopeKey: point.scopeKey, knowledgeName: point.sourceKnowledgePoint?.name ?? point.name });

async function loadStandardSkillRequirements(
  db: PoolConnection, occupationId: string, fileObjectId: string, scopes: StandardScope[], original: string,
) {
  const [rows] = await db.execute<(RowDataPacket & StandardSkillRequirement)[]>(
    `SELECT r.id,s.level_code AS levelCode,s.direction_name AS direction,
       f.id AS functionId,c.id AS contentId,
       f.source_code AS functionCode,f.name AS functionName,c.source_code AS contentCode,c.name AS contentName,
       r.source_code AS code,r.name,r.evidence_text AS evidence,
       s.blueprint_version_id AS blueprintVersionId,s.file_object_id AS fileObjectId,s.source_version_id AS sourceVersionId
     FROM blueprints b JOIN occupation_standard_requirement_scopes s ON s.blueprint_version_id=b.current_version_id
     JOIN occupation_standard_requirement_nodes r ON r.scope_id=s.id AND r.node_kind='skill_requirement'
     LEFT JOIN occupation_standard_requirement_nodes c ON c.id=r.parent_id AND c.scope_id=s.id AND c.node_kind='work_content'
     LEFT JOIN occupation_standard_requirement_nodes f ON f.id=c.parent_id AND f.scope_id=s.id AND f.node_kind='occupational_function'
     WHERE b.occupation_id=? AND s.occupation_id=? AND b.blueprint_kind='theory_weight'
       AND b.assessment_mode='theory' AND s.file_object_id=? AND s.level_code IN ('level_5','level_4','level_3')
     ORDER BY FIELD(s.level_code,'level_5','level_4','level_3','level_2','level_1'),s.direction_name,f.ordinal,c.ordinal,r.ordinal`,
    [occupationId, occupationId, fileObjectId],
  );
  if (rows.some((row) => !row.functionName || !row.contentName)) throw new Error("标准技能要求的职业功能或工作内容父级缺失，无法生成。");
  return expandStandardSkillHierarchy(bindStandardSkillRequirements(rows, scopes, original));
}

export function distributeQuestionTargets(points: GeneratedSkillPoint[], total: number) {
  if (!points.length || !Number.isInteger(total) || total < 30 || total > 50) throw new Error("每等级目标题量必须为30～50题。");
  return points.map((point, index) => ({
    ...point,
    targetCount: Math.floor((index + 1) * total / points.length) - Math.floor(index * total / points.length),
  }));
}

export async function getSkillGenerationState(occupationId: string) {
  const textbooks = await listTextbooks(occupationId, "level_5", "skill");
  const jobs = await query<Job[]>(
    `SELECT id,status,total_batches,completed_batches,generated_point_count,error_message
     FROM skill_outline_generation_jobs WHERE occupation_id=? ORDER BY created_at DESC,id DESC LIMIT 10`, [occupationId],
  );
  const versions = await query<RowDataPacket[]>(
    `SELECT v.id AS versionId,v.version_no AS versionNo,b.level_code AS levelCode,v.created_at AS createdAt
     FROM blueprints b JOIN blueprint_versions v ON v.blueprint_id=b.id
     WHERE b.occupation_id=? AND b.blueprint_kind='skill_outline' AND b.assessment_mode='skill'
     ORDER BY v.created_at DESC,v.id DESC LIMIT 100`, [occupationId],
  );
  // Sort lightweight metadata first; MySQL sort buffers must not hold large
  // all-direction JSON snapshots.
  const snapshots = versions.length ? await query<RowDataPacket[]>(
    `SELECT id,snapshot_json FROM blueprint_versions WHERE id IN (${versions.map(() => "?").join(",")})`,
    versions.map((version) => version.versionId),
  ) : [];
  const byId = new Map(snapshots.map((snapshot) => [snapshot.id, json(snapshot.snapshot_json)]));
  return {
    textbooks,
    jobs: jobs.map((job) => ({
      id: job.id, status: job.status, totalBatches: job.total_batches, completedBatches: job.completed_batches,
      generatedPointCount: job.generated_point_count, errorMessage: job.error_message,
    })),
    versions: versions.map((version) => ({
      versionId: version.versionId, versionNo: version.versionNo, levelCode: version.levelCode, createdAt: version.createdAt,
      ...byId.get(version.versionId),
    })),
  };
}

export async function startSkillGeneration(occupationId: string, mode: "textbook" | "model", targetQuestions: number, actorId: string) {
  if (!Number.isInteger(targetQuestions) || targetQuestions < 30 || targetQuestions > 50) throw new Error("每等级目标题量必须为30～50题。");
  await ensureSharedOccupationStandard(occupationId, actorId);
  const standard = await getSkillStandard(occupationId);
  if (!standard?.scopes?.length) throw new Error("请先上传国家职业标准并确认权重与内容结构。");
  const selectedScopes = (standard.scopes as StandardScope[]).filter((scope) => isSkillGenerationLevel(scope.column.levelCode));
  if (!selectedScopes.length) throw new Error("当前标准没有五级、四级、三级的可用技能要求。");
  const files = await query<RowDataPacket[]>("SELECT object_key,original_name FROM file_objects WHERE id=?", [standard.fileObjectId]);
  if (!files.length) throw new Error("国家标准原件不存在，请重新上传标准。");
  const bytes = await readFile(files[0].object_key);
  const extension = extname(files[0].original_name).toLowerCase();
  const standardText = extension === ".pdf" ? (await extractPdfText(bytes)).text : extension === ".docx" ? await extractDocxText(bytes) : bytes.toString("utf8");
  for (const scope of selectedScopes) {
    if (Math.abs(scope.rows.reduce((sum, row) => sum + row.score, 0) - 100) > 0.0001) throw new Error("内容结构比重合计必须为100%。");
  }
  const result = await withTransaction(async (db) => {
    const [occupations] = await db.execute<RowDataPacket[]>(
      `SELECT po.project_id FROM project_occupations po JOIN projects p ON p.id=po.project_id
       WHERE po.id=? AND po.status='active' AND p.status='active' FOR UPDATE`, [occupationId],
    );
    if (!occupations.length) throw new Error("职业不存在或已停用。");
    const [active] = await db.execute<RowDataPacket[]>(
      "SELECT id FROM skill_outline_generation_jobs WHERE occupation_id=? AND status IN ('queued','running')", [occupationId],
    );
    if (active.length) throw new Error("当前职业已有生成任务，请等待完成。");
    const [basisVersion] = await db.execute<RowDataPacket[]>(
      "SELECT current_version_id FROM blueprints WHERE occupation_id=? AND assessment_mode='skill' AND blueprint_kind='theory_weight' FOR UPDATE", [occupationId],
    );
    if (basisVersion[0]?.current_version_id !== standard.versionId) throw new Error("标准版本已变化，请刷新后重新生成。");
    const textbooks = mode === "textbook" ? await db.execute<RowDataPacket[]>(
      `SELECT sv.id FROM sources s JOIN source_versions sv ON sv.id=s.current_version_id
       WHERE s.project_id=? AND s.source_type='textbook' AND s.status='active' AND sv.parse_status='succeeded'
       AND EXISTS (SELECT 1 FROM source_scopes ss WHERE ss.source_version_id=sv.id AND ss.occupation_id=? AND ss.assessment_mode='skill')
       ORDER BY sv.created_at DESC LIMIT 1`, [occupations[0].project_id, occupationId],
    ) : null;
    const textbookId = textbooks?.[0][0]?.id ?? null;
    if (mode === "textbook" && !textbookId) throw new Error("请先上传操作技能教材。");
    const standardRequirements = mode === "model"
      ? await loadStandardSkillRequirements(db, occupationId, standard.fileObjectId, selectedScopes, standardText) : undefined;
    const id = createUlid();
    await db.execute(
      `INSERT INTO skill_outline_generation_jobs(id,project_id,occupation_id,textbook_source_version_id,generation_mode,target_questions,basis_snapshot_json,created_by)
       VALUES(?,?,?,?,?,?,?,?)`, [id, occupations[0].project_id, occupationId, textbookId, mode, targetQuestions,
        JSON.stringify({ ...standard, scopes: selectedScopes, standardText, standardRequirements,
          generationRule: skillGenerationRule(mode), generationLevels: skillGenerationLevels }), actorId],
    );
    return { id };
  });
  ensureSkillOutlineWorker();
  return result;
}

declare global {
  // A single timer per process survives development hot reload.
  var __skillOutlineWorker: ReturnType<typeof setInterval> | undefined;
  var __skillOutlineWorkerVersion: string | undefined;
  var __skillOutlineTickActive: boolean | undefined;
}
export function ensureSkillOutlineWorker() {
  const workerVersion = skillOutlineWorkerVersion;
  if (globalThis.__skillOutlineWorker && globalThis.__skillOutlineWorkerVersion === workerVersion) return;
  if (globalThis.__skillOutlineWorker) clearInterval(globalThis.__skillOutlineWorker);
  globalThis.__skillOutlineWorkerVersion = workerVersion;
  globalThis.__skillOutlineWorker = setInterval(() => void tick(), 5000);
  globalThis.__skillOutlineWorker.unref();
  void tick();
}
async function tick() {
  if (globalThis.__skillOutlineTickActive) return;
  globalThis.__skillOutlineTickActive = true;
  let db: PoolConnection | undefined;
  let locked = false;
  try {
    db = await getPool().getConnection();
    // Connection-scoped advisory lock prevents a second process from publishing
    // the same running job. A process crash releases it automatically.
    const [lock] = await db.execute<RowDataPacket[]>("SELECT GET_LOCK('itembank.skill_outline.worker',0) AS acquired");
    locked = Number(lock[0].acquired) === 1;
    if (!locked) return;
    const [jobs] = await db.execute<RowDataPacket[]>(
      "SELECT id FROM skill_outline_generation_jobs WHERE status IN ('queued','running') ORDER BY created_at LIMIT 1",
    );
    if (jobs.length) await runSkillGeneration(jobs[0].id);
  } catch (error) {
    console.error("操作技能细目表后台任务失败", error);
  } finally {
    if (locked && db) await db.execute("SELECT RELEASE_LOCK('itembank.skill_outline.worker')").catch(() => undefined);
    db?.release();
    globalThis.__skillOutlineTickActive = false;
  }
}

export async function runSkillGeneration(jobId: string, model: ModelCaller = callModel) {
  const jobs = await query<Job[]>(
    `SELECT j.*,po.name AS occupation_name FROM skill_outline_generation_jobs j
     JOIN project_occupations po ON po.id=j.occupation_id WHERE j.id=?`, [jobId],
  );
  const job = jobs[0];
  if (!job || !["queued", "running"].includes(job.status)) return;
  try {
    const basis = json<Basis>(job.basis_snapshot_json);
    const expectedRule = skillGenerationRule(job.generation_mode);
    if (basis.generationRule !== expectedRule) throw new Error("鉴定点生成规则已调整，请重新创建生成任务。历史完整版本不受影响。");
    if (basis.scopes.some((scope) => !isSkillGenerationLevel(scope.column.levelCode)) ||
      basis.standardRequirements?.some((item) => !isSkillGenerationLevel(item.levelCode))) {
      throw new Error("当前任务只允许五级、四级、三级，不能生成二级或一级技能等级。");
    }
    const chapters = job.textbook_source_version_id ? await query<RowDataPacket[]>(
      "SELECT id,ordinal,chapter_title,section_title,content_text FROM textbook_chapters WHERE source_version_id=? ORDER BY ordinal", [job.textbook_source_version_id],
    ) : [];
    if (job.generation_mode === "textbook" && !chapters.length) throw new Error("教材没有可用的已解析章节。");
    const standardBatches = job.generation_mode === "model" ? standardSkillBatches(basis.standardRequirements ?? []) : null;
    const batches = standardBatches ??
      chapters.flatMap((chapter) => splitKnowledgeText(chapter.content_text, chapter.id, [chapter.chapter_title, chapter.section_title].filter(Boolean).join(" / ")));
    if (!batches.length) throw new Error("没有可提取知识点的正文。");
    const points: GeneratedSkillPoint[] = job.draft_snapshot_json ? json<{ points: GeneratedSkillPoint[] }>(job.draft_snapshot_json).points : [];
    await getPool().execute(
      "UPDATE skill_outline_generation_jobs SET status='running',total_batches=?,started_at=COALESCE(started_at,UTC_TIMESTAMP(3)) WHERE id=?", [batches.length, jobId],
    );
    for (let index = job.completed_batches; index < batches.length; index++) {
      const batch = batches[index];
      const standardBatch = standardBatches?.[index];
      const generated = standardBatch
        ? await generateStandardSkillEntries(standardBatch, model)
        : await extractSkillKnowledge(batch, basis.scopes, job.generation_mode,
          points.map((point) => `${point.scopeKey}: ${point.sourceKnowledgePoint?.name ?? point.name}`), model);
      const seen = new Set(points.map(generatedPointKey));
      for (const point of generated) {
      const requirement = "requirement" in point ? (point as StandardSkillEntry).requirement : undefined;
      const key = requirement?.id ?? knowledgeEntryKey(point);
      if (seen.has(key)) continue;
      const scope = basis.scopes.find((item) => item.column.key === point.scopeKey)!;
      const row = scope.rows.find((item) => item.name === point.rowName)!;
      const primary = /设备|维护|保养/.test(row.name) ? "设备保养与调整" : /培训|指导|管理/.test(row.name) ? "培训指导与技术管理" : "工作任务";
      const scoped = points.filter((item) => item.scopeKey === scope.column.key && item.level2Name === row.name);
      const primaryCodes = new Map<string, string>();
      const secondaryCodes = new Map<string, string>();
      for (const row of scope.rows) {
        const category = /设备|维护|保养/.test(row.name) ? "设备保养与调整" : /培训|指导|管理/.test(row.name) ? "培训指导与技术管理" : "工作任务";
        codeFor(primaryCodes, category);
        codeFor(secondaryCodes, row.name);
      }
      const primaryCode = primaryCodes.get(primary)!;
      const secondaryCode = secondaryCodes.get(row.name)!;
      const primaryWeight = scope.rows.filter((row) =>
        (/设备|维护|保养/.test(row.name) ? "设备保养与调整" : /培训|指导|管理/.test(row.name) ? "培训指导与技术管理" : "工作任务") === primary,
      ).reduce((sum, row) => sum + row.score, 0);
        const ordinal = scoped.length + 1;
        points.push({
          code: `D${basis.scopes.indexOf(scope) + 1}-${primaryCode}-${secondaryCode}-${String(ordinal).padStart(3, "0")}`,
          name: point.name, range: primary, weight: row.score, importance: point.importance === "X" ? "critical" : point.importance === "Y" ? "high" : "medium",
          importanceCode: point.importance, level1Code: primaryCode, level1Name: primary, level2Code: secondaryCode, level2Name: row.name,
          level3Code: secondaryCode, level3Name: row.name, level1Weight: primaryWeight, level2Weight: row.score,
          ordinal, abilityLevel: "操作", targetCount: 0, selection: row.selection ?? "待核对",
          method: row.method ?? "待核对", minutes: row.minutes ?? 0, standardText: point.evidence, citation: basis.sourceName,
          knowledgeMaterial: job.textbook_source_version_id ?? "国家职业标准", knowledgePoints: point.knowledgeName,
          direction: scope.column.direction, scopeKey: scope.column.key, levelCode: scope.column.levelCode, sourceChapterIds: batch.chapterId ? [batch.chapterId] : [],
          sourceStandardRequirement: requirement,
          sourceKnowledgePoint: {
            id: createHash("sha256").update(`${job.textbook_source_version_id ?? basis.versionId}\u0000${key}`).digest("hex"),
            name: point.knowledgeName, evidence: point.evidence, locator: batch.locator,
          },
        });
        seen.add(key);
      }
      await getPool().execute(
        "UPDATE skill_outline_generation_jobs SET completed_batches=?,generated_point_count=?,draft_snapshot_json=? WHERE id=?",
        [index + 1, points.length, JSON.stringify({ points }), jobId],
      );
    }
    if (!points.length) throw new Error("正文未提取出可匹配当前技能范围的知识点，未发布空细目表。");
    if (job.generation_mode === "model") {
      const expected = new Set(basis.standardRequirements!.map((item) => item.id));
      if (points.length !== expected.size || new Set(points.map(generatedPointKey)).size !== expected.size ||
        points.some((point) => !expected.has(point.sourceStandardRequirement?.id ?? ""))) {
        throw new Error("鉴定点未与三级技能要求、二级工作内容和一级职业功能逐项完整对应，未发布不完整版本。");
      }
    }
    const allocated = skillGenerationLevels.flatMap((level) => {
      const levelPoints = points.filter((point) => point.levelCode === level).sort((left, right) =>
        left.scopeKey.localeCompare(right.scopeKey) || left.level1Code.localeCompare(right.level1Code)
        || left.level2Code.localeCompare(right.level2Code) || left.ordinal - right.ordinal,
      );
      return levelPoints.length ? distributeQuestionTargets(levelPoints, job.target_questions) : [];
    });
    await publishSkillGeneration(job, basis, allocated);
  } catch (error) {
    await getPool().execute(
      "UPDATE skill_outline_generation_jobs SET status='failed',error_message=?,draft_snapshot_json=NULL,finished_at=UTC_TIMESTAMP(3) WHERE id=?",
      [(error instanceof Error ? error.message : "生成失败").slice(0, 2000), jobId],
    );
  }
}
async function publishSkillGeneration(job: Job, basis: Basis, points: GeneratedSkillPoint[]) {
  if (points.some((point) => !isSkillGenerationLevel(point.levelCode))) throw new Error("只能发布五级、四级、三级的新细目表。");
  await withTransaction(async (db) => {
    const [active] = await db.execute<RowDataPacket[]>(
      `SELECT po.id FROM project_occupations po JOIN projects p ON p.id=po.project_id
       WHERE po.id=? AND po.status='active' AND p.status='active' FOR UPDATE`, [job.occupation_id],
    );
    if (!active.length) throw new Error("职业已停用，未发布生成结果。");
    const [current] = await db.execute<RowDataPacket[]>(
      "SELECT current_version_id FROM blueprints WHERE occupation_id=? AND blueprint_kind='theory_weight' AND assessment_mode='skill' FOR UPDATE", [job.occupation_id],
    );
    if (current[0]?.current_version_id !== basis.versionId) throw new Error("生成期间国家标准版本发生变化，未发布过期结果。");
    const results: { levelCode: string; versionId: string; versionNo: number }[] = [];
    for (const levelCode of skillGenerationLevels.filter((level) => basis.scopes.some((scope) => scope.column.levelCode === level))) {
      const [blueprints] = await db.execute<RowDataPacket[]>(
        "SELECT id FROM blueprints WHERE occupation_id=? AND level_code=? AND blueprint_kind='skill_outline' AND assessment_mode='skill' FOR UPDATE", [job.occupation_id, levelCode],
      );
      const blueprintId = blueprints[0]?.id ?? createUlid();
      if (!blueprints.length) await db.execute(
        "INSERT INTO blueprints(id,project_id,occupation_id,level_code,name,blueprint_kind,assessment_mode) VALUES(?,?,?,?,'操作技能考评要素细目表','skill_outline','skill')",
        [blueprintId, job.project_id, job.occupation_id, levelCode],
      );
      const [versions] = await db.execute<RowDataPacket[]>("SELECT COALESCE(MAX(version_no),0)+1 AS n FROM blueprint_versions WHERE blueprint_id=?", [blueprintId]);
      const versionId = createUlid(), versionNo = Number(versions[0].n);
      const levelPoints = points.filter((point) => point.levelCode === levelCode);
      const snapshot = {
        levelCode, points: levelPoints, sourceName: job.generation_mode === "textbook" ? "技能教材 AI 生成" : "AI 大模型生成",
        textbookSourceVersionId: job.textbook_source_version_id, standardVersionId: basis.versionId, targetQuestions: job.target_questions,
        generationRule: basis.generationRule,
        generationLevels: skillGenerationLevels,
      };
      await db.execute(
        "INSERT INTO blueprint_versions(id,blueprint_id,version_no,status,content_hash,snapshot_json,published_at,created_by) VALUES(?,?,?,'published',?,?,UTC_TIMESTAMP(3),?)",
        [versionId, blueprintId, versionNo, createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"), JSON.stringify(snapshot), job.created_by],
      );
      for (const [index, point] of levelPoints.entries()) await insertPoint(db, versionId, point, index, basis);
      if (job.textbook_source_version_id) await db.execute(
        "INSERT INTO blueprint_version_sources(blueprint_version_id,source_version_id) VALUES(?,?)", [versionId, job.textbook_source_version_id],
      );
      await db.execute("UPDATE blueprints SET current_version_id=?,status='published',row_version=row_version+1 WHERE id=?", [versionId, blueprintId]);
      results.push({ levelCode, versionId, versionNo });
    }
    await db.execute(
      "UPDATE skill_outline_generation_jobs SET status='succeeded',result_versions_json=?,draft_snapshot_json=NULL,finished_at=UTC_TIMESTAMP(3) WHERE id=?",
      [JSON.stringify(results), job.id],
    );
    await db.execute(
      "INSERT INTO audit_logs(id,project_id,actor_id,action,object_type,object_id,after_json,result) VALUES(?,?,?,'blueprint.skill_outline.generate','generation_job',?,?,'success')",
      [createUlid(), job.project_id, job.created_by, job.id, JSON.stringify({ results, pointCount: points.length, basisVersionId: basis.versionId })],
    );
  });
}
async function insertPoint(db: PoolConnection, versionId: string, point: GeneratedSkillPoint, ordinal: number, basis: Basis) {
  await db.execute(
    "INSERT INTO blueprint_nodes(id,blueprint_version_id,node_kind,node_code,name,ordinal,weight,importance,requirement_json,source_ref_json) VALUES(?,?,'assessment_point',?,?,?,?,?,?,?)",
    [createUlid(), versionId, point.code, point.name, ordinal + 1, point.weight, point.importance, JSON.stringify(point),
      JSON.stringify({ standardVersionId: basis.versionId, fileObjectId: basis.fileObjectId ?? null,
        chapterIds: point.sourceChapterIds, standardRequirement: point.sourceStandardRequirement })],
  );
}
