import { createHash } from "node:crypto";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";

import { getSavedModelConnection } from "@/modules/model-connection/service";
import { assertOutlineConfirmed } from "@/modules/blueprints/point-review";
import { buildChapterExcerptPool, selectBatchExcerpts } from "@/modules/blueprints/theory-outline-generation/generation-context";
import { query, withTransaction } from "@/shared/database/mysql";
import { createUlid } from "@/shared/database/ulid";
import { isLegalPoint } from "@/modules/authoring/legal-topics";
import { buildBatches, GENERATION_CONCURRENCY, parseQuestions, questionTypes, quotaTotal, stemHash, validateQuota, type QuotaPoint, type Scope, type Snapshot, type QuestionType } from "./contracts";
import { loadSkillPlanBasis } from "../skill-plan";
import { skillQuestionPrompt } from "./skill-prompt";
import { readSkillQualityStandard, type AppliedSkillQualityStandard } from "./skill-quality-standard";
import { qualityStandardConfigs, qualityStandardContent } from "../quality-standard";
import { assertFrozenPlanBasis, theoryPointContext } from "./plan-basis";
import { readGenerationActivity } from "./activity";
import { registerGenerationRequest } from "./cancellation";
import { anglePlanningPrompt, angleSources, completeRetry, failureOf, GenerationFailure, keepSelectedAngle, MAX_TOTAL_ATTEMPTS, MAX_TARGETED_ATTEMPTS,
  parseAnglePlan, prepareManualRetry, retryBlocked, retryQuestionFeedback, retryState, validationFailure,
  type RequestOutput, type RetryFailure, type RetryState } from "./retry-policy";

function json<T>(value: T | string): T {
  return typeof value === "string" ? JSON.parse(value) as T : value;
}
type Unit = RowDataPacket & {
  id: string; job_id: string; batch_id: string; point_code: string; question_type: QuestionType | "mixed";
  attempts: number; lease_token: string; snapshot_json: Snapshot | string; plan_id: string; created_by: string | null;
  retry_state_json: RetryState | string | null;
  error_message: string | null;
  appliedSkillQualityStandard?: AppliedSkillQualityStandard;
};

export async function startGeneration(planId: string, actorId: string, retryFailed = false) {
  const connection = await getSavedModelConnection();
  const id = await withTransaction(async (db) => {
    const [plans] = await db.execute<(RowDataPacket & { project_id: string; raw_requirement: string; scope_json: Scope | string; quota_json: string; status: string })[]>(
      "SELECT project_id, raw_requirement, scope_json, quota_json, status FROM authoring_plans WHERE id=? FOR UPDATE", [planId],
    );
    const plan = plans[0];
    if (!plan || plan.status !== "confirmed") throw new Error("计划不存在或未确认。");
    const scope = json<Scope>(plan.scope_json);
    await assertFrozenPlanBasis(db, plan.project_id, scope);
    const [existing] = await db.execute<(RowDataPacket & { id: string; status: string })[]>("SELECT id,status FROM authoring_generation_jobs WHERE plan_id=?", [planId]);
    if (existing[0]) {
      if (["stopped", "cancelled"].includes(existing[0].status)) throw new Error("任务已结束，不能恢复生成或重试；如需补题请新建计划。");
      if (retryFailed) {
        const [active] = await db.execute<RowDataPacket[]>(
          "SELECT id FROM authoring_generation_units WHERE job_id=? AND status IN ('queued','running') LIMIT 1", [existing[0].id],
        );
        if (active.length) throw new Error("任务仍在执行，请待本轮结束后重试失败部分。");
        const [failed] = await db.execute<(RowDataPacket & { id: string; attempts: number; retry_state_json: unknown; error_message: string | null })[]>(
          "SELECT id,attempts,retry_state_json,error_message FROM authoring_generation_units WHERE job_id=? AND status='failed' FOR UPDATE", [existing[0].id],
        );
        let retried = 0;
        for (const unit of failed) {
          const state = retryState(unit.retry_state_json);
          if (retryBlocked(state, Number(unit.attempts), true)) continue;
          const next = prepareManualRetry(state, Number(unit.attempts), unit.error_message);
          await db.execute("UPDATE authoring_generation_units SET status='queued',retry_state_json=?,next_attempt_at=UTC_TIMESTAMP(3) WHERE id=?",
            [JSON.stringify(next), unit.id]);
          retried++;
        }
        if (!retried) throw new Error("失败请求已达到累计上限或需补充依据、修复配置，不能继续原样重试。");
        await refreshJob(db, existing[0].id);
        await audit(db, plan.project_id, actorId, planId, "authoring.plan.retry_failed", { jobId: existing[0].id, retried, skipped: failed.length - retried });
      }
      return existing[0].id;
    }
    if (!connection) throw new Error("未配置可用模型连接，请先保存模型设置。");
    const [legacy] = await db.execute<(RowDataPacket & { count: number })[]>(
      "SELECT COUNT(*) AS count FROM question_versions WHERE JSON_UNQUOTE(JSON_EXTRACT(source_snapshot_json,'$.planId'))=?", [planId],
    );
    if (Number(legacy[0].count)) throw new Error("该历史计划已有试题成果，请查看成果；新需求请创建新计划。");
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
    const [settings] = await db.execute<(RowDataPacket & { setting_key: string; setting_value_json: unknown })[]>(
      "SELECT setting_key, setting_value_json FROM system_settings WHERE setting_key IN (?, ?)",
      [qualityStandardConfigs.theory.settingKey, qualityStandardConfigs.skill.settingKey],
    );
    const savedSettings = new Map(settings.map((setting) => [setting.setting_key, setting.setting_value_json]));
    const snapshot: Snapshot = {
      projectId: plan.project_id, requirement: plan.raw_requirement, scope,
      points: quota.points.map((point) => ({ ...point, total: quotaTotal(point) })),
      skillStructure: skillBasis?.structure,
      qualityRequirements: quota.qualityRequirements ?? [],
      qualityStandard: qualityStandardContent(savedSettings.get(qualityStandardConfigs.theory.settingKey), qualityStandardConfigs.theory.defaultContent),
      skillQualityStandard: scope.assessmentMode === "操作技能"
        ? qualityStandardContent(savedSettings.get(qualityStandardConfigs.skill.settingKey), qualityStandardConfigs.skill.defaultContent)
        : undefined,
      sourceVersionIds: sources.map((source) => source.source_version_id),
      nodes: quota.points.map((point) => {
        const node = byCode.get(point.code)!;
        return { id: node.id, code: node.node_code, name: node.name, chapterIds: node.source_ref_json ? json<{ chapterIds?: string[] }>(node.source_ref_json).chapterIds ?? [] : [],
          skillContext: skillBasis ? { point: node.requirement_json ? json(node.requirement_json) : null,
            source: node.source_ref_json ? json(node.source_ref_json) : null } : undefined,
          theoryContext: skillBasis ? undefined : theoryPointContext(node.requirement_json, node.source_ref_json) };
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
  const jobs = await query<(RowDataPacket & { id: string; status: string; target_count: number; termination_summary_json: unknown; stop_summary_json: unknown })[]>(
    "SELECT id,status,target_count,termination_summary_json,stop_summary_json FROM authoring_generation_jobs WHERE plan_id=?", [planId],
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
  const failed = await query<(RowDataPacket & { id: string; point_code: string; question_type: string; error_message: string; remaining: number; attempts: number; retry_state_json: unknown })[]>(
    `SELECT u.id,u.point_code,u.question_type,u.error_message,u.attempts,u.retry_state_json,COUNT(*) AS remaining
       FROM authoring_generation_units u JOIN authoring_generation_slots s ON s.unit_id=u.id
      WHERE u.job_id=? AND u.status IN ('failed','stopped') AND s.question_id IS NULL GROUP BY u.id`, [job.id],
  );
  const generated = batches.reduce((sum, batch) => sum + Number(batch.generated_count), 0);
  const pending = batches.reduce((sum, batch) => sum + Number(batch.pending), 0);
  const status = ["cancelled", "stopped"].includes(job.status) ? job.status : generated === Number(job.target_count) ? "succeeded" : pending ? job.status === "queued" ? "queued" : "running" : "partial";
  return {
    job: {
      id: job.id, status, target: Number(job.target_count), generated,
      retryLimits: { totalAttempts: MAX_TOTAL_ATTEMPTS, targetedAttempts: MAX_TARGETED_ATTEMPTS, consecutiveZeroOutputs: 2 },
      activity: await readGenerationActivity(job.id),
      terminationSummary: job.termination_summary_json ? json(job.termination_summary_json) : null,
      stopSummary: job.stop_summary_json ? json(job.stop_summary_json) : null,
      totalBatches: batches.length,
      completedBatches: batches.filter((batch) => Number(batch.generated_count) === Number(batch.target)).length,
      currentBatch: batches.find((batch) => Number(batch.running))?.ordinal ?? batches.find((batch) => Number(batch.pending))?.ordinal ?? null,
      failedUnits: failed.map((unit) => {
        const state = retryState(unit.retry_state_json);
        return { id: unit.id, code: unit.point_code, type: unit.question_type, remaining: Number(unit.remaining),
          error: unit.error_message ?? (status === "stopped" ? "任务已停止，此缺额不再处理。" : "请求失败。"), attempts: Number(unit.attempts), failures: state.failures,
          stopReason: status === "stopped" ? "已停止，不再处理此缺额。" : state.stopReason, retryable: status !== "stopped" && !retryBlocked(state, Number(unit.attempts), true) };
      }),
      batches: batches.map((batch) => ({
        ordinal: batch.ordinal, target: Number(batch.target), generated: Number(batch.generated_count),
        status: Number(batch.generated_count) === Number(batch.target) ? "succeeded" : status === "stopped" ? "stopped" : Number(batch.pending) ? "running" : "partial",
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
    // Preserve cumulative attempts on recovery so repeated process exits cannot
    // bypass retry limits. Token fencing still rejects late workers.
    const [expired] = await db.execute<(RowDataPacket & { id: string; job_id: string; attempts: number; retry_state_json: unknown })[]>(
      "SELECT id,job_id,attempts,retry_state_json FROM authoring_generation_units WHERE status='running' AND lease_until<UTC_TIMESTAMP(3) FOR UPDATE",
    );
    for (const unit of expired) {
      const state = retryState(unit.retry_state_json);
      const result = completeRetry(state, Number(unit.attempts), 0, 1, [{ code: "lease_expired", message: "请求租约过期，已回收；累计次数保留。" }]);
      await db.execute(`UPDATE authoring_generation_units SET status=?,retry_state_json=?,error_message=?,
        lease_token=NULL,lease_until=NULL,next_attempt_at=UTC_TIMESTAMP(3) WHERE id=?`,
        [result.status, JSON.stringify(result.state), result.state.stopReason ?? "请求租约过期，等待恢复。", unit.id]);
      await refreshJob(db, unit.job_id);
    }
    const [running] = await db.execute<(RowDataPacket & { count: number })[]>(
      "SELECT COUNT(*) AS count FROM authoring_generation_units WHERE status='running'",
    );
    if (Number(running[0].count) >= GENERATION_CONCURRENCY) return null;
    // Never include snapshot JSON in filesort: a single large snapshot can
    // exceed MySQL's sort buffer even with LIMIT 1.
    const [rows] = await db.execute<(RowDataPacket & { id: string; job_id: string })[]>(
      `SELECT u.id,u.job_id FROM authoring_generation_units u
       JOIN authoring_generation_batches b ON b.id=u.batch_id
       JOIN authoring_generation_jobs j ON j.id=u.job_id
       JOIN authoring_plans p ON p.id=j.plan_id AND p.status='confirmed'
       WHERE u.status='queued' AND u.next_attempt_at<=UTC_TIMESTAMP(3) AND j.status IN ('queued','running')
       ORDER BY j.created_at,b.ordinal,u.ordinal LIMIT 1 FOR UPDATE SKIP LOCKED`,
    );
    if (!rows[0]) return null;
    const [units] = await db.execute<Unit[]>(
      `SELECT u.id,u.job_id,u.batch_id,u.point_code,u.question_type,u.attempts,u.retry_state_json,u.error_message,
              j.snapshot_json,j.plan_id,j.created_by
       FROM authoring_generation_units u JOIN authoring_generation_jobs j ON j.id=u.job_id
       WHERE u.id=? AND j.id=? FOR UPDATE`, [rows[0].id, rows[0].job_id],
    );
    const unit = units[0];
    if (!unit) throw new Error("领取的命题请求或关联任务不存在。");
    const state = retryState(unit.retry_state_json);
    if (!unit.retry_state_json && Number(unit.attempts) > 0 && unit.error_message) {
      state.targeted = true;
      state.failures = [validationFailure(unit.error_message)];
    }
    const blocked = retryBlocked(state, Number(unit.attempts));
    if (blocked) {
      state.stopReason = blocked;
      await db.execute("UPDATE authoring_generation_units SET status='failed',error_message=?,retry_state_json=? WHERE id=?",
        [blocked, JSON.stringify(state), unit.id]);
      await refreshJob(db, unit.job_id);
      return null;
    }
    unit.lease_token = createUlid();
    unit.attempts = Number(unit.attempts) + 1;
    if (state.targeted) state.targetedAttempts += 1;
    unit.retry_state_json = state;
    await db.execute("UPDATE authoring_generation_units SET status='running',attempts=?,retry_state_json=?,lease_token=?,lease_until=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 180 SECOND) WHERE id=?",
      [unit.attempts, JSON.stringify(state), unit.lease_token, unit.id]);
    return unit;
  });
}

async function refreshJob(db: PoolConnection, jobId: string) {
  const [counts] = await db.execute<(RowDataPacket & { pending: number; failed: number })[]>(
    "SELECT SUM(status IN ('queued','running')) AS pending,SUM(status='failed') AS failed FROM authoring_generation_units WHERE job_id=?", [jobId],
  );
  await db.execute("UPDATE authoring_generation_jobs SET status=? WHERE id=? AND status NOT IN ('cancelled','stopped')",
    [Number(counts[0].pending) ? "running" : Number(counts[0].failed) ? "partial" : "succeeded", jobId]);
}

async function saveOutput(unit: Unit, output: RequestOutput) {
  const { questions } = output;
  const failures = output.failures.slice();
  const snapshot = json<Snapshot>(unit.snapshot_json);
  return withTransaction(async (db) => {
    // Claiming and saving use the same leading lock; network calls stay outside
    // these short transactions so both model requests still run in parallel.
    await db.execute("SELECT id FROM authoring_generation_capacity WHERE id=1 FOR UPDATE");
    const [jobs] = await db.execute<(RowDataPacket & { status: string })[]>("SELECT status FROM authoring_generation_jobs WHERE id=? FOR UPDATE", [unit.job_id]);
    if (!jobs[0] || ["cancelled", "stopped"].includes(jobs[0].status)) return;
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
      if (duplicates.length) { failures.push({ code: "duplicate", message: "题干与本任务已有题重复。" }); continue; }
      const slot = slots.find((item) => item.question_type === question.questionType);
      if (!slot) { failures.push({ code: "invalid_type", message: "返回题型没有对应缺额槽位。" }); continue; }
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
        retryAngle: output.state.selectedAngle, retryCovered: output.state.covered,
        appliedSkillQualityStandard: unit.appliedSkillQualityStandard,
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
    if (slots.length && !failures.length && !saved) failures.push({ code: "invalid_content", message: "模型未返回可保存的试题。" });
    const result = completeRetry(output.state, unit.attempts, saved, slots.length, failures);
    const details = [...new Set(failures.map((failure) => failure.message))].join("；") || "仅补缺额，下一次按新的知识角度补一道";
    await db.execute(`UPDATE authoring_generation_units SET status=?,error_message=?,retry_state_json=?,lease_token=NULL,lease_until=NULL,
      next_attempt_at=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL ? SECOND) WHERE id=?`,
    [result.status, result.status === "succeeded" ? null : `${details}；本次保存${saved}题，尚缺${slots.length}题${result.state.stopReason ? `；${result.state.stopReason}` : ""}`.slice(0, 2000),
      JSON.stringify(result.state), result.delay, unit.id]);
    await refreshJob(db, unit.job_id);
    if (saved) await audit(db, snapshot.projectId, unit.created_by, unit.plan_id, "authoring.plan.batch_output_saved", { jobId: unit.job_id, batchId: unit.batch_id, unitId: unit.id, saved });
    if (result.status !== "succeeded") {
      await audit(db, snapshot.projectId, unit.created_by, unit.plan_id, "authoring.plan.retry_result", {
        jobId: unit.job_id, unitId: unit.id, missing: slots.length, saved, attempts: unit.attempts, ...result.state,
      });
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

async function requestQuestions(unit: Unit, cancellation: AbortSignal): Promise<RequestOutput> {
  cancellation.throwIfAborted();
  const state = retryState(unit.retry_state_json);
  const snapshot = json<Snapshot>(unit.snapshot_json);
  const connection = await getSavedModelConnection();
  if (!connection || connection.provider !== snapshot.model.provider || connection.baseUrl !== snapshot.model.baseUrl) {
    throw new GenerationFailure("connection_changed", "模型连接已变更，请恢复原连接后处理，或新建计划。");
  }
  const missing = await query<(RowDataPacket & { question_type: QuestionType })[]>(
    "SELECT question_type FROM authoring_generation_slots WHERE unit_id=? AND question_id IS NULL ORDER BY ordinal", [unit.id],
  );
  if (!missing.length) return { questions: [], failures: [], state };
  const requested = state.targeted ? missing.slice(0, 1) : missing;
  const quotas = Object.fromEntries(questionTypes.map((type) => [type, requested.filter((slot) => slot.question_type === type).length]));
  const node = snapshot.nodes.find((item) => item.code === unit.point_code)!;
  const [metadata] = await query<(RowDataPacket & { name: string; requirement_json: unknown; source_ref_json: unknown })[]>(
    "SELECT name,requirement_json,source_ref_json FROM blueprint_nodes WHERE id=?", [node.id],
  );
  if (metadata && isLegalPoint(metadata)) throw new GenerationFailure("insufficient_basis", "法律法规考评点必须通过法规智能体及已核验原文命题，已阻止普通生成。");
  const previous = await query<(RowDataPacket & { stem: string; content: unknown; answer: unknown; analysis: string | null })[]>(
    `SELECT qv.stem,qv.content_json AS content,qv.answer_json AS answer,qv.analysis_text AS analysis
      FROM authoring_generation_slots s JOIN authoring_generation_units u ON u.id=s.unit_id
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
  const reuseAngle = keepSelectedAngle(state);
  if (!reuseAngle) state.selectedAngle = undefined;
  unit.retry_state_json = state;
  if (state.targeted) {
    const context = snapshot.scope.assessmentMode === "操作技能" ? node.skillContext : node.theoryContext;
    const sources = angleSources(context, excerpts);
    if (!sources.length) throw new GenerationFailure("insufficient_basis", "冻结教材和标准未提供可核验原文，不能为补题编造新角度。");
    const analysisPrompt = anglePlanningPrompt(node.code, node.name, requested[0].question_type, previous, sources, state, {
      职业: snapshot.scope.occupation, 等级: snapshot.scope.levelCode, 依据: context,
    });
    if (!reuseAngle) {
      const analysis = await callGenerationModel(snapshot, connection.apiKey, analysisPrompt, cancellation);
      const plan = parseAnglePlan(analysis, previous.length, sources, state.attemptedAngles);
      state.covered = plan.covered;
      state.selectedAngle = plan.selected;
      state.attemptedAngles = [...state.attemptedAngles, plan.selected];
    }
    unit.retry_state_json = state;
    cancellation.throwIfAborted();
    // Lease fencing preserves the plan without allowing a cancelled/old worker
    // to write retry metadata or consume a second model request.
    const persisted = await query<RowDataPacket[]>(
      "SELECT id FROM authoring_generation_units WHERE id=? AND lease_token=? AND status='running'", [unit.id, unit.lease_token],
    );
    if (!persisted.length) throw new GenerationFailure("lease_expired", "补题分析后租约已失效，停止生成。");
    await query("UPDATE authoring_generation_units SET retry_state_json=? WHERE id=? AND lease_token=? AND status='running'",
      [JSON.stringify(state), unit.id, unit.lease_token]);
  }
  let instruction = `你是职业技能理论知识试题编制助手。严格依据冻结考评点、关联标准依据及提供的教材片段编制中文试题草稿，覆盖指定题型和数量。
有教材时只能使用关联教材片段和标准依据；没有教材时以关联标准条目为考核范围，结合适用职业等级的通用专业知识出题。不得编造法律条款、数值标准或机构制度，资料不足不得凑题。遵守输入中的试题质量标准，但不得改变指定题型或数量、越出正式标准范围。
题目不得重复已生成题干，不得仅改写同一题。答案、解析必须明确且符合知识依据。只返回JSON：
{"questions":[{"assessmentPointCode":"指定考评点代码","questionType":"single","stem":"真实中文题干","options":[{"key":"A","content":"真实选项"}],"answers":["A"],"analysis":"答案依据解析"}]}。
严格按照“本次题型配额”分别生成各题型的缺额。mixed仅表示同一请求包含多题型，绝不能作为任何题目的questionType。
每条questionType只能是single（单选）、multiple（多选）或judgement（判断），禁止中文题型值。
先在考评点范围内选择不同的事实、条件、流程步骤或应用情境，每道题考查不同内容，不能复制题干或只换语序、正反问法。排除题干所考查的内容也不得重复。即使只补1题，也必须是新的知识角度。
单选恰好4个不同选项和1个答案；多选至少4个不同选项和至少2个答案；答案键必须对应选项。判断options必须为[]，answers必须为["正确"]或["错误"]，不能写true/false、对/错或A/B。`;
  let prompt = JSON.stringify({
    用户需求: snapshot.requirement, 职业: snapshot.scope.occupation, 等级: snapshot.scope.levelCode,
    考评点: { code: node.code, name: node.name }, 指定题型: state.targeted ? requested[0].question_type : unit.question_type, 本次必须生成数: requested.length,
    本次题型配额: quotas,
    质量要求: snapshot.qualityRequirements, 试题质量标准: snapshot.qualityStandard,
    冻结考评点与标准依据: node.theoryContext,
    教材片段: excerpts, 排除题干: previous.map((item) => item.stem), 补齐次数: unit.attempts,
  });
  if (snapshot.scope.assessmentMode === "操作技能") {
    const standard = await readSkillQualityStandard();
    snapshot.skillQualityStandard = standard.content;
    unit.appliedSkillQualityStandard = standard;
    ({ instruction, prompt } = skillQuestionPrompt(snapshot, node.code, requested.length, previous.map((item) => item.stem)));
    // Record every actual generation attempt, including ones yielding no valid
    // questions. The initial job snapshot remains unchanged for provenance.
    await withTransaction(async (db) => {
      await db.execute("SELECT id FROM authoring_generation_capacity WHERE id=1 FOR UPDATE");
      const [leases] = await db.execute<RowDataPacket[]>(
        "SELECT id FROM authoring_generation_units WHERE id=? AND lease_token=? AND status='running' FOR UPDATE",
        [unit.id, unit.lease_token],
      );
      if (!leases.length) throw new GenerationFailure("lease_expired", "质量标准读取后任务已停止或租约失效，不再生成。");
      await audit(db, snapshot.projectId, unit.created_by, unit.plan_id, "authoring.plan.skill_quality_applied", {
        jobId: unit.job_id, unitId: unit.id, attempts: unit.attempts, standard,
      });
    });
  }
  if (state.selectedAngle) {
    instruction += "\n本次为精准补题，只生成一道指定题型的新题。必须使用补题策略指定的知识角度和原文依据，检查与已有题的实质内容差异，并针对上次具体错误修正，不得忽略质量标准。";
    prompt = JSON.stringify({ ...JSON.parse(prompt), 补题策略: retryQuestionFeedback(state, state.selectedAngle, requested[0].question_type) });
  }
  const content = await callGenerationModel(snapshot, connection.apiKey, { instruction, prompt }, cancellation);
  let parsed: ReturnType<typeof parseQuestions>;
  try { parsed = parseQuestions(content, node.code, snapshot.scope.assessmentMode === "操作技能" ? "practical" : state.targeted ? requested[0].question_type : unit.question_type); }
  catch (error) { throw new GenerationFailure("invalid_json", error instanceof Error ? error.message : "试题 JSON 无效。"); }
  const failures = parsed.invalidReasons.map(validationFailure);
  if (!parsed.valid.length && !failures.length) failures.push({ code: "invalid_content", message: "模型未返回试题，新增有效题为0。" });
  return { questions: state.targeted ? parsed.valid.slice(0, 1) : parsed.valid, failures, state };
}

async function callGenerationModel(snapshot: Snapshot, apiKey: string, input: { instruction: string; prompt: string }, cancellation: AbortSignal) {
  cancellation.throwIfAborted();
  const target = endpoint(snapshot.model);
  const response = await fetch(target.url, {
    method: "POST",
    headers: target.anthropic ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" }
      : { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(target.anthropic
      ? { model: snapshot.model.model, max_tokens: 8192, system: input.instruction, messages: [{ role: "user", content: input.prompt }] }
      : { model: snapshot.model.model, temperature: 0.5, max_tokens: 8192, response_format: { type: "json_object" },
        messages: [{ role: "system", content: input.instruction }, { role: "user", content: input.prompt }] }),
    signal: AbortSignal.any([cancellation, AbortSignal.timeout(90000)]),
  });
  cancellation.throwIfAborted();
  if (!response.ok) {
    if (response.status === 429) {
      await query("UPDATE authoring_generation_capacity SET cooldown_until=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 30 SECOND) WHERE id=1");
      throw new GenerationFailure("rate_limited", "模型限流 HTTP 429，等待冷却后补题。");
    }
    throw new GenerationFailure(response.status >= 500 || response.status === 408 ? "network_error" : "model_error", `模型请求失败 HTTP ${response.status}`);
  }
  let payload: { choices?: Array<{ message?: { content?: string } }>; content?: Array<{ text?: string }> };
  try { payload = await response.json(); }
  catch { throw new GenerationFailure("invalid_json", "模型接口返回的响应不是有效 JSON。"); }
  cancellation.throwIfAborted();
  return target.anthropic ? payload.content?.map((item) => item.text ?? "").join("") ?? "" : payload.choices?.[0]?.message?.content ?? "";
}

export async function runGenerationTick() {
  const unit = await claimUnit();
  if (!unit) return false;
  const request = registerGenerationRequest(unit.id, unit.job_id);
  const heartbeat = setInterval(() => {
    void query<(RowDataPacket & { id: string })[]>("SELECT id FROM authoring_generation_units WHERE id=? AND lease_token=? AND status='running'",
      [unit.id, unit.lease_token]).then(async (rows) => {
        if (!rows.length) request.controller.abort(new Error("命题请求已终止或租约已失效。"));
        else await query("UPDATE authoring_generation_units SET lease_until=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 180 SECOND) WHERE id=? AND lease_token=? AND status='running'",
          [unit.id, unit.lease_token]);
      }).catch(() => undefined);
  }, 30000);
  heartbeat.unref();
  try {
    let output: RequestOutput = { questions: [], failures: [], state: retryState(unit.retry_state_json) };
    try { output = await requestQuestions(unit, request.controller.signal); }
    catch (error) { output = { questions: [], failures: [failureOf(error)], state: retryState(unit.retry_state_json) }; }
    try {
      await saveOutput(unit, output);
    } catch (error) {
      // A permanent write/constraint error must not become an endless lease
      // recovery loop. The transaction already rolled back this response.
      await withTransaction(async (db) => {
        await db.execute("SELECT id FROM authoring_generation_capacity WHERE id=1 FOR UPDATE");
        await db.execute("SELECT id FROM authoring_generation_jobs WHERE id=? FOR UPDATE", [unit.job_id]);
        const failure: RetryFailure = { code: "save_error", message: `试题保存失败：${error instanceof Error ? error.message : "数据库异常"}`.slice(0, 1500) };
        const state = { ...output.state, failures: [failure], stopReason: "数据写入失败，需人工处理。" };
        await db.execute(`UPDATE authoring_generation_units SET status='failed',error_message=?,retry_state_json=?,lease_token=NULL,lease_until=NULL
          WHERE id=? AND lease_token=? AND status='running'`,
          [failure.message, JSON.stringify(state), unit.id, unit.lease_token]);
        await refreshJob(db, unit.job_id);
      });
    }
  } finally {
    clearInterval(heartbeat);
    request.release();
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
