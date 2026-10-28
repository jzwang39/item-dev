import { createHash } from "node:crypto";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";

import { getSavedModelConnection } from "@/modules/model-connection/service";
import { assertOutlineConfirmed } from "@/modules/blueprints/point-review";
import { buildChapterExcerptPool, selectBatchExcerpts } from "@/modules/blueprints/theory-outline-generation/generation-context";
import { query, withTransaction } from "@/shared/database/mysql";
import { createUlid } from "@/shared/database/ulid";
import { isLegalPoint } from "@/modules/authoring/legal-topics";
import { buildBatches, GENERATION_CONCURRENCY, MAX_ATTEMPTS, parseQuestions, questionTypes, quotaTotal, stemHash, validateQuota, type GeneratedQuestion, type QuotaPoint, type Scope, type Snapshot, type QuestionType } from "./contracts";
import { loadSkillPlanBasis } from "../skill-plan";
import { skillQuestionPrompt } from "./skill-prompt";

function json<T>(value: T | string): T {
  return typeof value === "string" ? JSON.parse(value) as T : value;
}
type Unit = RowDataPacket & {
  id: string; job_id: string; batch_id: string; point_code: string; question_type: QuestionType | "mixed";
  attempts: number; lease_token: string; snapshot_json: Snapshot | string; plan_id: string; created_by: string | null;
};

export async function startGeneration(planId: string, actorId: string, retryFailed = false) {
  const connection = await getSavedModelConnection();
  const id = await withTransaction(async (db) => {
    const [plans] = await db.execute<(RowDataPacket & { project_id: string; raw_requirement: string; scope_json: Scope | string; quota_json: string; status: string })[]>(
      "SELECT project_id, raw_requirement, scope_json, quota_json, status FROM authoring_plans WHERE id=? FOR UPDATE", [planId],
    );
    const plan = plans[0];
    if (!plan || plan.status !== "confirmed") throw new Error("计划不存在或未确认。");
    const [existing] = await db.execute<(RowDataPacket & { id: string })[]>("SELECT id FROM authoring_generation_jobs WHERE plan_id=?", [planId]);
    if (existing[0]) {
      if (retryFailed) {
        await db.execute("UPDATE authoring_generation_units SET status='queued', attempts=0, error_message=NULL, next_attempt_at=UTC_TIMESTAMP(3) WHERE job_id=? AND status='failed'", [existing[0].id]);
        await db.execute("UPDATE authoring_generation_jobs SET status='running' WHERE id=? AND status='partial'", [existing[0].id]);
        await audit(db, plan.project_id, actorId, planId, "authoring.plan.retry_failed", { jobId: existing[0].id });
      }
      return existing[0].id;
    }
    if (!connection) throw new Error("未配置可用模型连接，请先保存模型设置。");
    const [legacy] = await db.execute<(RowDataPacket & { count: number })[]>(
      "SELECT COUNT(*) AS count FROM question_versions WHERE JSON_UNQUOTE(JSON_EXTRACT(source_snapshot_json,'$.planId'))=?", [planId],
    );
    if (Number(legacy[0].count)) throw new Error("该历史计划已有试题成果，请查看成果；新需求请创建新计划。");
    const scope = json<Scope>(plan.scope_json);
    await assertOutlineConfirmed(db, scope.blueprintVersions.outline.id);
    const quota = json<{ points: QuotaPoint[]; qualityRequirements: string[] }>(plan.quota_json);
    const skillBasis = scope.assessmentMode === "操作技能" ? await loadSkillPlanBasis(db, scope.occupationId, scope.levelCode, scope.blueprintVersions) : null;
    validateQuota(quota.points, scope.levelCode, scope.assessmentMode);
    const [nodes] = await db.execute<(RowDataPacket & { id: string; node_code: string; name: string; requirement_json: unknown; source_ref_json: string | { chapterIds?: string[] } })[]>(
      "SELECT id,node_code,name,requirement_json,source_ref_json FROM blueprint_nodes WHERE blueprint_version_id=? AND node_kind='assessment_point'", [scope.blueprintVersions.outline.id],
    );
    const byCode = new Map(nodes.map((node) => [node.node_code, node]));
    if (quota.points.some((point) => !byCode.has(point.code))) throw new Error("计划考评点不属于冻结细目表。");
    if (quota.points.some((point) => isLegalPoint(byCode.get(point.code)!))) throw new Error("此计划包含法律法规考评点，不能通过普通AI命题。请重新生成计划，并在题库检索使用法律法规智能体。");
    const [sources] = await db.execute<(RowDataPacket & { source_version_id: string })[]>(
      "SELECT source_version_id FROM blueprint_version_sources WHERE blueprint_version_id=?", [scope.blueprintVersions.outline.id],
    );
    const [settings] = await db.execute<(RowDataPacket & { setting_value_json: string | { content?: string } })[]>(
      "SELECT setting_value_json FROM system_settings WHERE setting_key='authoring.question_quality_standard' LIMIT 1",
    );
    const snapshot: Snapshot = {
      projectId: plan.project_id, requirement: plan.raw_requirement, scope,
      points: quota.points.map((point) => ({ ...point, total: quotaTotal(point) })),
      skillStructure: skillBasis?.structure,
      qualityRequirements: quota.qualityRequirements ?? [],
      qualityStandard: settings[0] ? json<{ content?: string }>(settings[0].setting_value_json).content ?? "" : "",
      sourceVersionIds: sources.map((source) => source.source_version_id),
      nodes: quota.points.map((point) => {
        const node = byCode.get(point.code)!;
        return { id: node.id, code: node.node_code, name: node.name, chapterIds: node.source_ref_json ? json<{ chapterIds?: string[] }>(node.source_ref_json).chapterIds ?? [] : [],
          skillContext: skillBasis ? { point: node.requirement_json ? json(node.requirement_json) : null,
            source: node.source_ref_json ? json(node.source_ref_json) : null } : undefined };
      }),
      model: { provider: connection.provider, baseUrl: connection.baseUrl, model: connection.model },
    };
    const batches = buildBatches(snapshot.points);
    const jobId = createUlid();
    await db.execute("INSERT INTO authoring_generation_jobs(id,plan_id,snapshot_json,target_count,created_by) VALUES(?,?,?,?,?)",
      [jobId, planId, JSON.stringify(snapshot), batches.reduce((sum, batch) => sum + batch.target, 0), actorId]);
    for (const batch of batches) {
      const batchId = createUlid();
      await db.execute("INSERT INTO authoring_generation_batches(id,job_id,ordinal,target_count) VALUES(?,?,?,?)", [batchId, jobId, batch.ordinal, batch.target]);
      for (const [index, unit] of batch.units.entries()) {
        const unitId = createUlid();
        await db.execute("INSERT INTO authoring_generation_units(id,job_id,batch_id,ordinal,point_code,question_type,next_attempt_at) VALUES(?,?,?,?,?,?,UTC_TIMESTAMP(3))",
          [unitId, jobId, batchId, index + 1, unit.code, unit.type]);
        for (const [slotIndex, ordinal] of unit.ordinals.entries()) {
          await db.execute("INSERT INTO authoring_generation_slots(id,job_id,unit_id,ordinal,question_type) VALUES(?,?,?,?,?)", [createUlid(), jobId, unitId, ordinal, unit.slotTypes[slotIndex]]);
        }
      }
    }
    await audit(db, plan.project_id, actorId, planId, "authoring.plan.generation_started", { jobId, total: batches.reduce((sum, batch) => sum + batch.target, 0), batches: batches.length });
    return jobId;
  });
  ensureGenerationWorker();
  return { jobId: id, ...await getGenerationState(planId) };
}

export async function getGenerationState(planId: string) {
  const jobs = await query<(RowDataPacket & { id: string; status: string; target_count: number })[]>(
    "SELECT id,status,target_count FROM authoring_generation_jobs WHERE plan_id=?", [planId],
  );
  if (!jobs[0]) return { job: null };
  const job = jobs[0];
  const batches = await query<(RowDataPacket & { ordinal: number; target: number; generated_count: number; failed: number; pending: number; running: number })[]>(
    `SELECT b.ordinal,b.target_count AS target,COUNT(s.question_id) AS generated_count,
       COUNT(DISTINCT IF(u.status='failed',u.id,NULL)) AS failed,
       COUNT(DISTINCT IF(u.status IN ('queued','running'),u.id,NULL)) AS pending,
       COUNT(DISTINCT IF(u.status='running',u.id,NULL)) AS running
     FROM authoring_generation_batches b JOIN authoring_generation_units u ON u.batch_id=b.id
     JOIN authoring_generation_slots s ON s.unit_id=u.id WHERE b.job_id=?
     GROUP BY b.id ORDER BY b.ordinal`, [job.id],
  );
  const failed = await query<(RowDataPacket & { id: string; point_code: string; question_type: string; error_message: string; remaining: number })[]>(
    `SELECT u.id,u.point_code,u.question_type,u.error_message,COUNT(*) AS remaining
       FROM authoring_generation_units u JOIN authoring_generation_slots s ON s.unit_id=u.id
      WHERE u.job_id=? AND u.status='failed' AND s.question_id IS NULL GROUP BY u.id`, [job.id],
  );
  const generated = batches.reduce((sum, batch) => sum + Number(batch.generated_count), 0);
  const pending = batches.reduce((sum, batch) => sum + Number(batch.pending), 0);
  const status = generated === Number(job.target_count) ? "succeeded" : pending ? job.status === "queued" ? "queued" : "running" : "partial";
  return {
    job: {
      id: job.id, status, target: Number(job.target_count), generated,
      totalBatches: batches.length,
      completedBatches: batches.filter((batch) => Number(batch.generated_count) === Number(batch.target)).length,
      currentBatch: batches.find((batch) => Number(batch.running))?.ordinal ?? batches.find((batch) => Number(batch.pending))?.ordinal ?? null,
      failedUnits: failed.map((unit) => ({ id: unit.id, code: unit.point_code, type: unit.question_type, remaining: Number(unit.remaining), error: unit.error_message })),
      batches: batches.map((batch) => ({
        ordinal: batch.ordinal, target: Number(batch.target), generated: Number(batch.generated_count),
        status: Number(batch.generated_count) === Number(batch.target) ? "succeeded" : Number(batch.pending) ? "running" : "partial",
      })),
    },
  };
}

async function audit(db: PoolConnection, projectId: string, actorId: string | null, planId: string, action: string, detail: unknown) {
  await db.execute("INSERT INTO audit_logs(id,project_id,actor_id,action,object_type,object_id,after_json,result) VALUES(?,?,?,?,'authoring_plan',?,?,'success')",
    [createUlid(), projectId, actorId, action, planId, JSON.stringify(detail)]);
}

async function claimUnit(): Promise<Unit | null> {
  return withTransaction(async (db) => {
    const [capacity] = await db.execute<(RowDataPacket & { cooling: number })[]>(
      "SELECT cooldown_until>UTC_TIMESTAMP(3) AS cooling FROM authoring_generation_capacity WHERE id=1 FOR UPDATE",
    );
    if (capacity[0]?.cooling) return null;
    // Expired leases are recoverable after a process exit; the interrupted try is
    // not charged again. Token fencing prevents that old worker from committing.
    await db.execute(`UPDATE authoring_generation_units SET status='queued',attempts=GREATEST(0,CAST(attempts AS SIGNED)-1),
      lease_token=NULL,lease_until=NULL,next_attempt_at=UTC_TIMESTAMP(3)
      WHERE status='running' AND lease_until<UTC_TIMESTAMP(3)`);
    const [running] = await db.execute<(RowDataPacket & { count: number })[]>(
      "SELECT COUNT(*) AS count FROM authoring_generation_units WHERE status='running'",
    );
    if (Number(running[0].count) >= GENERATION_CONCURRENCY) return null;
    const [rows] = await db.execute<Unit[]>(
      `SELECT u.*,j.snapshot_json,j.plan_id,j.created_by FROM authoring_generation_units u
       JOIN authoring_generation_batches b ON b.id=u.batch_id
       JOIN authoring_generation_jobs j ON j.id=u.job_id
       JOIN authoring_plans p ON p.id=j.plan_id AND p.status='confirmed'
       WHERE u.status='queued' AND u.next_attempt_at<=UTC_TIMESTAMP(3) AND j.status IN ('queued','running')
       ORDER BY j.created_at,b.ordinal,u.ordinal LIMIT 1 FOR UPDATE SKIP LOCKED`,
    );
    if (!rows[0]) return null;
    const unit = rows[0];
    unit.lease_token = createUlid();
    unit.attempts = Number(unit.attempts) + 1;
    await db.execute("UPDATE authoring_generation_units SET status='running',attempts=?,lease_token=?,lease_until=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 180 SECOND) WHERE id=?",
      [unit.attempts, unit.lease_token, unit.id]);
    return unit;
  });
}

async function refreshJob(db: PoolConnection, jobId: string) {
  const [counts] = await db.execute<(RowDataPacket & { pending: number; failed: number })[]>(
    "SELECT SUM(status IN ('queued','running')) AS pending,SUM(status='failed') AS failed FROM authoring_generation_units WHERE job_id=?", [jobId],
  );
  await db.execute("UPDATE authoring_generation_jobs SET status=? WHERE id=?",
    [Number(counts[0].pending) ? "running" : Number(counts[0].failed) ? "partial" : "succeeded", jobId]);
}

async function saveOutput(unit: Unit, questions: GeneratedQuestion[], errorMessage: string) {
  const snapshot = json<Snapshot>(unit.snapshot_json);
  return withTransaction(async (db) => {
    // Claiming and saving use the same leading lock; network calls stay outside
    // these short transactions so both model requests still run in parallel.
    await db.execute("SELECT id FROM authoring_generation_capacity WHERE id=1 FOR UPDATE");
    await db.execute("SELECT id FROM authoring_generation_jobs WHERE id=? FOR UPDATE", [unit.job_id]);
    const [leases] = await db.execute<(RowDataPacket & { lease_token: string; status: string })[]>(
      "SELECT lease_token,status FROM authoring_generation_units WHERE id=? FOR UPDATE", [unit.id],
    );
    if (leases[0]?.status !== "running" || leases[0].lease_token !== unit.lease_token) return;
    const [slots] = await db.execute<(RowDataPacket & { id: string; ordinal: number; question_type: QuestionType })[]>(
      "SELECT id,ordinal,question_type FROM authoring_generation_slots WHERE unit_id=? AND question_id IS NULL ORDER BY ordinal FOR UPDATE", [unit.id],
    );
    const node = snapshot.nodes.find((item) => item.code === unit.point_code)!;
    let saved = 0;
    for (const question of questions) {
      if (!slots.length) break;
      const hash = stemHash(question.stem);
      const [duplicates] = await db.execute<RowDataPacket[]>("SELECT id FROM authoring_generation_slots WHERE job_id=? AND stem_hash=? LIMIT 1", [unit.job_id, hash]);
      if (duplicates.length) continue;
      const slot = slots.find((item) => item.question_type === question.questionType);
      if (!slot) continue;
      const questionId = createUlid();
      const versionId = createUlid();
      const skill = snapshot.scope.assessmentMode === "操作技能";
      const status = skill ? "pending_review" : "draft";
      const type = question.questionType === "practical" ? "实操题" : question.questionType === "single" ? "单项选择题" : question.questionType === "multiple" ? "多项选择题" : "判断题";
      const source = {
        planId: unit.plan_id, jobId: unit.job_id, batchId: unit.batch_id, unitId: unit.id,
        blueprintVersionId: snapshot.scope.blueprintVersions.outline.id,
        weightVersionId: snapshot.scope.blueprintVersions.weights.id,
        textbookSourceVersionIds: snapshot.sourceVersionIds, chapterIds: node.chapterIds,
        structureVersionId: snapshot.scope.blueprintVersions.structure?.id,
        skillContext: node.skillContext, skillStructure: snapshot.skillStructure,
        assessmentPointCode: node.code, generatedAt: new Date().toISOString(),
      };
      await db.execute(`INSERT INTO questions(id,project_id,question_no,occupation_id,level_code,assessment_mode,question_type,current_version_id,current_status)
        VALUES(?,?,?,?,?,?,?,?,?)`, [questionId, snapshot.projectId, `AI-${unit.plan_id}-${String(slot.ordinal).padStart(4, "0")}`,
        snapshot.scope.occupationId, snapshot.scope.levelCode, skill ? "skill" : "theory", type, versionId, status]);
      await db.execute(`INSERT INTO question_versions(id,question_id,version_no,stem,content_json,answer_json,analysis_text,score_rubric_json,source_snapshot_json,content_hash,created_by)
        VALUES(?,?,1,?,?,?,?,?,?,?,?)`, [versionId, questionId, question.stem, JSON.stringify({ options: question.options }),
        JSON.stringify({ answers: question.answers }), question.analysis, question.scoreRubric ? JSON.stringify(question.scoreRubric) : null, JSON.stringify(source),
        createHash("sha256").update(JSON.stringify(question)).digest("hex"), unit.created_by]);
      for (const option of question.options) {
        await db.execute("INSERT INTO question_options(id,question_version_id,option_key,content,is_correct) VALUES(?,?,?,?,?)",
          [createUlid(), versionId, option.key, option.content, question.answers.includes(option.key) ? 1 : 0]);
      }
      await db.execute("INSERT INTO question_assessment_points(question_version_id,blueprint_node_id) VALUES(?,?)", [versionId, node.id]);
      await db.execute(`INSERT INTO question_quality_checks(id,question_version_id,check_round,check_code,severity,result,detail_json)
        VALUES(?,?,'rule','authoring.basic_structure','info','pass',?)`, [createUlid(), versionId, JSON.stringify({ planId: unit.plan_id, unitId: unit.id, optionsValid: true })]);
      await db.execute(`INSERT INTO question_status_events(id,question_id,question_version_id,from_status,to_status,reason,actor_id)
        VALUES(?,?,?,NULL,?,'分批AI生成，等待人工核查',?)`, [createUlid(), questionId, versionId, status, unit.created_by]);
      await db.execute("UPDATE authoring_generation_slots SET question_id=?,stem_hash=? WHERE id=?", [questionId, hash, slot.id]);
      slots.splice(slots.indexOf(slot), 1);
      saved += 1;
    }
    const complete = slots.length === 0;
    await db.execute(`UPDATE authoring_generation_units SET status=?,error_message=?,lease_token=NULL,lease_until=NULL,
      next_attempt_at=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 5 SECOND) WHERE id=?`,
    [complete ? "succeeded" : unit.attempts >= MAX_ATTEMPTS ? "failed" : "queued",
      complete ? null : `${errorMessage || "返回重复或无效试题"}；本次保存${saved}题，尚缺${slots.length}题`.slice(0, 2000), unit.id]);
    await refreshJob(db, unit.job_id);
    if (saved) await audit(db, snapshot.projectId, unit.created_by, unit.plan_id, "authoring.plan.batch_output_saved", { jobId: unit.job_id, batchId: unit.batch_id, unitId: unit.id, saved });
    if (!complete && unit.attempts >= MAX_ATTEMPTS) {
      await audit(db, snapshot.projectId, unit.created_by, unit.plan_id, "authoring.plan.unit_failed", { jobId: unit.job_id, unitId: unit.id, missing: slots.length, error: errorMessage });
    }
  });
}

function endpoint(model: Snapshot["model"]) {
  const url = new URL(model.baseUrl);
  url.pathname = url.pathname.replace(/\/+$/, "");
  const zhipu = url.hostname === "open.bigmodel.cn" && url.pathname.startsWith("/api/paas/");
  const anthropic = !zhipu && (/claude|anthropic/i.test(model.provider) || url.pathname.endsWith("/messages"));
  if (!anthropic && !url.pathname.endsWith("/chat/completions")) {
    if (!(zhipu && url.pathname.endsWith("/api/paas/v4")) && !url.pathname.endsWith("/v1")) url.pathname += "/v1";
    url.pathname += "/chat/completions";
  }
  return { url: url.toString(), anthropic };
}

async function requestQuestions(unit: Unit) {
  const snapshot = json<Snapshot>(unit.snapshot_json);
  const connection = await getSavedModelConnection();
  if (!connection || connection.provider !== snapshot.model.provider || connection.baseUrl !== snapshot.model.baseUrl) {
    throw new Error("模型连接已变更，请恢复原连接后重试失败部分，或新建计划。");
  }
  const missing = await query<(RowDataPacket & { question_type: QuestionType })[]>("SELECT question_type FROM authoring_generation_slots WHERE unit_id=? AND question_id IS NULL", [unit.id]);
  if (!missing.length) return [];
  const quotas = Object.fromEntries(questionTypes.map((type) => [type, missing.filter((slot) => slot.question_type === type).length]));
  const node = snapshot.nodes.find((item) => item.code === unit.point_code)!;
  const [metadata] = await query<(RowDataPacket & { name: string; requirement_json: unknown; source_ref_json: unknown })[]>(
    "SELECT name,requirement_json,source_ref_json FROM blueprint_nodes WHERE id=?", [node.id],
  );
  if (metadata && isLegalPoint(metadata)) throw new NonRetryableError("法律法规考评点必须通过法规智能体及已核验原文命题，已阻止普通生成。");
  const previous = await query<(RowDataPacket & { stem: string })[]>(
    `SELECT qv.stem FROM authoring_generation_slots s JOIN authoring_generation_units u ON u.id=s.unit_id
      JOIN questions q ON q.id=s.question_id JOIN question_versions qv ON qv.id=q.current_version_id
     WHERE s.job_id=? AND u.point_code=? ORDER BY s.ordinal`, [unit.job_id, unit.point_code],
  );
  let excerpts: Array<{ title: string; content: string; start: number }> = [];
  if (node.chapterIds.length && snapshot.sourceVersionIds.length) {
    const chapters = await query<(RowDataPacket & { id: string; ordinal: number; chapter_title: string; section_title: string | null; content_text: string })[]>(
      `SELECT id,ordinal,chapter_title,section_title,content_text FROM textbook_chapters
       WHERE id IN (${node.chapterIds.map(() => "?").join(",")}) AND source_version_id IN (${snapshot.sourceVersionIds.map(() => "?").join(",")}) ORDER BY ordinal`,
      [...node.chapterIds, ...snapshot.sourceVersionIds],
    );
    const pool = buildChapterExcerptPool(chapters.map((chapter) => ({
      id: chapter.id, ordinal: chapter.ordinal, chapterTitle: chapter.chapter_title, sectionTitle: chapter.section_title, content: chapter.content_text,
    })), node.name);
    excerpts = selectBatchExcerpts(pool, previous.length, Math.max(1, previous.length + missing.length), unit.attempts);
  }
  let instruction = `你是职业技能理论知识试题编制助手。严格依据冻结考评点和提供的教材编制中文试题草稿，覆盖指定题型和数量。题目不得重复已生成题干，不得仅改写同一题。答案、解析必须明确且符合知识依据。只返回JSON：
{"questions":[{"assessmentPointCode":"指定考评点代码","questionType":"single","stem":"真实中文题干","options":[{"key":"A","content":"真实选项"}],"answers":["A"],"analysis":"答案依据解析"}]}。
严格按照“本次题型配额”分别生成各题型的缺额。mixed仅表示同一请求包含多题型，绝不能作为任何题目的questionType。
每条questionType只能是single（单选）、multiple（多选）或judgement（判断），禁止中文题型值。
先在考评点范围内选择不同的事实、条件、流程步骤或应用情境，每道题考查不同内容，不能复制题干或只换语序、正反问法。排除题干所考查的内容也不得重复。即使只补1题，也必须是新的知识角度。
单选恰好4个不同选项和1个答案；多选至少4个不同选项和至少2个答案；答案键必须对应选项。判断options必须为[]，answers必须为["正确"]或["错误"]，不能写true/false、对/错或A/B。`;
  let prompt = JSON.stringify({
    用户需求: snapshot.requirement, 职业: snapshot.scope.occupation, 等级: snapshot.scope.levelCode,
    考评点: { code: node.code, name: node.name }, 指定题型: unit.question_type, 本次必须生成数: missing.length,
    本次题型配额: quotas,
    质量要求: snapshot.qualityRequirements, 试题质量标准: snapshot.qualityStandard,
    教材片段: excerpts, 排除题干: previous.map((item) => item.stem), 补齐次数: unit.attempts,
  });
  if (snapshot.scope.assessmentMode === "操作技能") {
    ({ instruction, prompt } = skillQuestionPrompt(snapshot, node.code, missing.length, previous.map((item) => item.stem)));
  }
  const target = endpoint(snapshot.model);
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(target.url, {
        method: "POST",
        headers: target.anthropic ? { "x-api-key": connection.apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" }
          : { Authorization: `Bearer ${connection.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(target.anthropic
          ? { model: snapshot.model.model, max_tokens: 8192, system: instruction, messages: [{ role: "user", content: prompt }] }
          : { model: snapshot.model.model, temperature: unit.attempts > 1 ? 0.7 : 0.5, max_tokens: 8192, response_format: { type: "json_object" },
            messages: [{ role: "system", content: instruction }, { role: "user", content: prompt }] }),
        signal: AbortSignal.timeout(90000),
      });
      if (!response.ok) {
        if (response.status === 429) {
          await query("UPDATE authoring_generation_capacity SET cooldown_until=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 30 SECOND) WHERE id=1");
          throw new NonRetryableError("模型限流 HTTP 429，暂停新请求30秒后补齐。");
        }
        if (response.status !== 429 && response.status < 500) throw new NonRetryableError(`模型请求失败 HTTP ${response.status}`);
        throw new Error(`模型请求失败 HTTP ${response.status}`);
      }
      const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }>; content?: Array<{ text?: string }> };
      const output = target.anthropic ? payload.content?.map((item) => item.text ?? "").join("") ?? "" : payload.choices?.[0]?.message?.content ?? "";
      const parsed = parseQuestions(output, node.code, snapshot.scope.assessmentMode === "操作技能" ? "practical" : unit.question_type);
      if (parsed.invalidReasons.length) console.warn("命题响应字段校验：", node.code, [...new Set(parsed.invalidReasons)].slice(0, 3).join("; "));
      if (!parsed.valid.length) throw new NonRetryableError(`模型返回${parsed.received}题，其中有效题为0：${parsed.invalidReasons[0] ?? "未知原因"}`);
      return parsed.valid;
    } catch (error) {
      last = error;
      if (error instanceof NonRetryableError) throw error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  throw last;
}
class NonRetryableError extends Error {}

export async function runGenerationTick() {
  const unit = await claimUnit();
  if (!unit) return false;
  const heartbeat = setInterval(() => {
    void query("UPDATE authoring_generation_units SET lease_until=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 180 SECOND) WHERE id=? AND lease_token=? AND status='running'",
      [unit.id, unit.lease_token]).catch(() => undefined);
  }, 30000);
  heartbeat.unref();
  try {
    let output: GeneratedQuestion[] = [];
    let message = "";
    try { output = await requestQuestions(unit); }
    catch (error) { message = error instanceof Error ? error.message : "模型请求失败"; }
    try {
      await saveOutput(unit, output, message);
    } catch (error) {
      // A permanent write/constraint error must not become an endless lease
      // recovery loop. The transaction already rolled back this response.
      await withTransaction(async (db) => {
        await db.execute("SELECT id FROM authoring_generation_capacity WHERE id=1 FOR UPDATE");
        await db.execute("SELECT id FROM authoring_generation_jobs WHERE id=? FOR UPDATE", [unit.job_id]);
        await db.execute(`UPDATE authoring_generation_units SET status='failed',error_message=?,lease_token=NULL,lease_until=NULL
          WHERE id=? AND lease_token=? AND status='running'`,
          [`试题保存失败：${error instanceof Error ? error.message : "数据库异常"}`.slice(0, 2000), unit.id, unit.lease_token]);
        await refreshJob(db, unit.job_id);
      });
    }
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}

declare global {
  var __authoringGenerationWorker: { active: number; timer: ReturnType<typeof setInterval>; runTick?: typeof runGenerationTick } | undefined;
}
export function ensureGenerationWorker() {
  if (process.env.AUTHORING_GENERATION_WORKER_DISABLED === "1") return;
  const existing = globalThis.__authoringGenerationWorker;
  if (existing?.runTick) {
    // Refresh the implementation after Next.js HMR without spawning a second
    // timer. Existing leases still protect work already in flight.
    existing.runTick = runGenerationTick;
    existing.active ??= 0;
    return;
  }
  if (existing) clearInterval(existing.timer);
  const state = { active: 0, timer: undefined as unknown as ReturnType<typeof setInterval>, runTick: runGenerationTick };
  globalThis.__authoringGenerationWorker = state;
  const tick = async () => {
    if (state.active >= GENERATION_CONCURRENCY) return;
    state.active += 1;
    try { await state.runTick(); }
    catch (error) { console.error("命题后台任务执行异常：", error instanceof Error ? error.message : "未知错误"); }
    finally { state.active -= 1; }
  };
  state.timer = setInterval(() => void tick(), 1500);
  state.timer.unref();
  void tick();
}
