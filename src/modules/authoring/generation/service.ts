import { createHash } from "node:crypto";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";

import { getSavedModelConnection } from "@/modules/model-connection/service";
import { assertOutlineConfirmed } from "@/modules/blueprints/point-review";
import { buildChapterExcerptPool, selectBatchExcerpts } from "@/modules/blueprints/theory-outline-generation/generation-context";
import { query, withTransaction } from "@/shared/database/mysql";
import { createUlid } from "@/shared/database/ulid";
import { isLegalPoint } from "@/modules/authoring/legal-topics";
import { buildBatches, GENERATION_CONCURRENCY, parseQuestions, quotaTotal, stemHash, validateQuota, type QuotaPoint, type Scope, type Snapshot, type QuestionType } from "./contracts";
import { loadSkillPlanBasis } from "../skill-plan";
import { skillQuestionPrompt } from "./skill-prompt";
import { theoryQuestionPrompt } from "./theory-prompt";
import { cleanSkillStem } from "./skill-stem-quality";
import { readGenerationQualityStandard, type AppliedQualityStandard } from "./skill-quality-standard";
import { qualityStandardConfigs, qualityStandardContent } from "../quality-standard";
import { assertFrozenPlanBasis, theoryPointContext } from "./plan-basis";
import { readGenerationActivity } from "./activity";
import { registerGenerationRequest } from "./cancellation";
import { queueSupplementRound } from "./supplement";
import { completeRetry, failureOf, GenerationFailure, MAX_TOTAL_ATTEMPTS, MAX_TARGETED_ATTEMPTS,
  prepareManualRetry, retryBlocked, retryState, validationFailure,
  type RequestOutput, type RetryFailure, type RetryState } from "./retry-policy";
import { buildEvidenceCatalog, type EvidenceChapter } from "./evidence-catalog";
import { ensureTargetedBudget, grantSkillRecovery, recoverExpansionReviewProtocol, recoverCuratedTheoryBasis, recoverNoTextbookTheory, recoverTheoryDuplicate, theoryGenerationLimit, recoverSkillDesignProtocol, recoverPrematureBlocks, markTargetedSaved, MAX_SLOT_GENERATIONS, MAX_SLOT_REPAIRS, MAX_UNIT_MODEL_CALLS, type MissingSlot } from "./targeted-budget";
import { generateTargeted } from "./targeted-generation";
import { recoverTheoryBasisRevision, recoverTheoryEcho } from "./targeted-budget";
import { assertCommonGeneration, prefillCommonSlots, registerCommonGenerated } from "../common-generation";
import { commonPlanProgress } from "../common-questions";

function json<T>(value: T | string): T {
  return typeof value === "string" ? JSON.parse(value) as T : value;
}
type Unit = RowDataPacket & {
  id: string; job_id: string; batch_id: string; point_code: string; question_type: QuestionType | "mixed";
  attempts: number; lease_token: string; snapshot_json: Snapshot | string; plan_id: string; created_by: string | null;
  retry_state_json: RetryState | string | null;
  error_message: string | null;
  appliedQualityStandard?: AppliedQualityStandard;
};

type StandardEvidenceSegment = RowDataPacket & {
  source_version_id: string;
  id: string;
  locator: string | null;
  content_excerpt: string;
};

function object(value: unknown) {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function theoryEvidenceTopic(node: Snapshot["nodes"][number]) {
  const theoryContext = object(node.theoryContext);
  const point = object(theoryContext.point);
  const source = object(theoryContext.source);
  const pointStandard = object(point.standardSource);
  const sourceStandard = object(source.standard);
  const standard = Object.keys(pointStandard).length ? pointStandard : sourceStandard;
  return [
    node.name,
    point.primaryName,
    point.secondaryName,
    point.tertiaryName,
    standard.functionName,
    standard.contentName,
    standard.name,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0).join(" ");
}

export function theoryEvidenceSourceVersionIds(node: Snapshot["nodes"][number]) {
  const theoryContext = object(node.theoryContext);
  const point = object(theoryContext.point);
  const source = object(theoryContext.source);
  const entries = [object(point.standardSource), object(source.standard), object(source.standardBasic)];
  return [...new Set(entries.map((entry) => entry.sourceVersionId)
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0))];
}

export async function startGeneration(planId: string, actorId: string, retryFailed = false, skillRecoveryAuthorized = false) {
  const connection = await getSavedModelConnection();
  const id = await withTransaction(async (db) => {
    await db.execute("SELECT id FROM authoring_generation_capacity WHERE id=1 FOR UPDATE");
    const [plans] = await db.execute<(RowDataPacket & { project_id: string; raw_requirement: string; scope_json: Scope | string; quota_json: string; status: string })[]>(
      "SELECT project_id, raw_requirement, scope_json, quota_json, status FROM authoring_plans WHERE id=? FOR UPDATE", [planId],
    );
    const plan = plans[0];
    if (!plan || plan.status !== "confirmed") throw new Error("计划不存在或未确认。");
    const scope = json<Scope>(plan.scope_json);
    await assertFrozenPlanBasis(db, plan.project_id, scope);
    const [existing] = await db.execute<(RowDataPacket & { id: string; status: string; snapshot_json: Snapshot | string })[]>("SELECT id,status,snapshot_json FROM authoring_generation_jobs WHERE plan_id=?", [planId]);
    if (existing[0]) {
      if (existing[0].status === "stopped") throw new Error("原请求已停止，不能恢复或原样重试；请使用“补题”创建新的缺额请求。");
      if (existing[0].status === "cancelled") throw new Error("任务已终止，不能恢复生成或重试；如需补题请新建计划。");
      if (retryFailed) {
        const old = json<Snapshot>(existing[0].snapshot_json);
        await assertCommonGeneration(db, planId, scope, old.nodes.map((node) => {
          const context = node.theoryContext as { point?: unknown; source?: unknown } | undefined;
          return { id: node.id, name: node.name, node_code: node.code, requirement_json: context?.point, source_ref_json: context?.source };
        }));
        const [active] = await db.execute<RowDataPacket[]>(
          "SELECT id FROM authoring_generation_units WHERE job_id=? AND status IN ('queued','running') LIMIT 1", [existing[0].id],
        );
        if (active.length) throw new Error("任务仍在执行，请待本轮结束后重试失败部分。");
        const [failed] = await db.execute<(RowDataPacket & { id: string; point_code: string; attempts: number; retry_state_json: unknown; error_message: string | null })[]>(
          "SELECT id,point_code,attempts,retry_state_json,error_message FROM authoring_generation_units WHERE job_id=? AND status='failed' FOR UPDATE", [existing[0].id],
        );
        const [missingSlots] = await db.execute<(RowDataPacket & MissingSlot & { unit_id: string })[]>(
          "SELECT id,unit_id,ordinal,question_type FROM authoring_generation_slots WHERE job_id=? AND question_id IS NULL FOR UPDATE", [existing[0].id],
        );
        let retried = 0;
        const upgraded: string[] = [];
        for (const unit of failed) {
          const state = retryState(unit.retry_state_json);
          const missing = missingSlots.filter((slot) => slot.unit_id === unit.id);
          if (!missing.length) continue;
          if (!state.budget) {
            ensureTargetedBudget(state, missing, Number(unit.attempts), unit.error_message);
            upgraded.push(unit.id);
            // A one-time strategy upgrade keeps all legacy cumulative counters
            // and failures in origin; it is not an unlimited counter reset.
            state.failures = [];
          }
          ensureTargetedBudget(state, missing, Number(unit.attempts), unit.error_message);
          if (recoverTheoryBasisRevision(state, old, unit.point_code)) upgraded.push(unit.id);
          if (recoverExpansionReviewProtocol(state, old, unit.point_code)) upgraded.push(unit.id);
          if (recoverCuratedTheoryBasis(state, old, unit.point_code)) upgraded.push(unit.id);
          if (recoverNoTextbookTheory(state, old, unit.point_code)) upgraded.push(unit.id);
          if (scope.assessmentMode === "操作技能" && recoverSkillDesignProtocol(state)) upgraded.push(unit.id);
          if (scope.assessmentMode !== "操作技能" && recoverTheoryDuplicate(state)) upgraded.push(unit.id);
          if (recoverTheoryEcho(state, old, unit.point_code)) upgraded.push(unit.id);
          if (scope.assessmentMode === "操作技能" && skillRecoveryAuthorized && grantSkillRecovery(state, Number(unit.attempts))) upgraded.push(unit.id);
          if (recoverPrematureBlocks(state)) upgraded.push(unit.id);
          if (retryBlocked(state, Number(unit.attempts), true)) continue;
          const next = prepareManualRetry(state, Number(unit.attempts), unit.error_message);
          await db.execute("UPDATE authoring_generation_units SET status='queued',retry_state_json=?,next_attempt_at=UTC_TIMESTAMP(3) WHERE id=?",
            [JSON.stringify(next), unit.id]);
          retried++;
        }
        if (!retried) throw new Error("逐题补题预算已耗尽或需补充依据、人工命题，请查看缺口和查阅记录；不会原样无限重试。");
        await refreshJob(db, existing[0].id);
        await audit(db, plan.project_id, actorId, planId, "authoring.plan.retry_failed", { jobId: existing[0].id, retried, skipped: failed.length - retried,
          upgraded, strategy: "per_slot_v2", workflowVersion: 3, skillRecoveryAuthorized });
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
    const generationPoints = scope.commonReference
      ? quota.points.filter((point) => !scope.commonReference!.codes.includes(point.code)) : quota.points;
    const [nodes] = await db.execute<(RowDataPacket & { id: string; node_code: string; name: string; requirement_json: unknown; source_ref_json: string | { chapterIds?: string[] } })[]>(
      "SELECT id,node_code,name,requirement_json,source_ref_json FROM blueprint_nodes WHERE blueprint_version_id=? AND node_kind='assessment_point'", [scope.blueprintVersions.outline.id],
    );
    const byCode = new Map(nodes.map((node) => [node.node_code, node]));
    if (quota.points.some((point) => !byCode.has(point.code))) throw new Error("计划考评点不属于冻结细目表。");
    if (quota.points.some((point) => isLegalPoint(byCode.get(point.code)!))) throw new Error("此计划包含法律法规考评点，不能通过普通AI命题。请重新生成计划，并在题库检索使用法律法规智能体。");
    await assertCommonGeneration(db, planId, scope, nodes.filter((node) => generationPoints.some((point) => point.code === node.node_code)));
    const [sources] = await db.execute<(RowDataPacket & { source_version_id: string })[]>(
      "SELECT source_version_id FROM blueprint_version_sources WHERE blueprint_version_id=?", [scope.blueprintVersions.outline.id],
    );
    const standardConfig = scope.assessmentMode === "操作技能" ? qualityStandardConfigs.skill : qualityStandardConfigs.theory;
    const [settings] = await db.execute<(RowDataPacket & { setting_value_json: unknown })[]>(
      "SELECT setting_value_json FROM system_settings WHERE setting_key = ?",
      [standardConfig.settingKey],
    );
    const standardContent = qualityStandardContent(settings[0]?.setting_value_json, standardConfig.defaultContent);
    const snapshot: Snapshot = {
      projectId: plan.project_id, requirement: plan.raw_requirement, scope,
      points: generationPoints.map((point) => ({ ...point, total: quotaTotal(point) })),
      skillStructure: skillBasis?.structure,
      qualityRequirements: quota.qualityRequirements ?? [],
      qualityStandard: scope.assessmentMode === "操作技能" ? "" : standardContent,
      skillQualityStandard: scope.assessmentMode === "操作技能" ? standardContent : undefined,
      sourceVersionIds: sources.map((source) => source.source_version_id),
      nodes: generationPoints.map((point) => {
        const node = byCode.get(point.code)!;
        return { id: node.id, code: node.node_code, name: node.name, chapterIds: node.source_ref_json ? json<{ chapterIds?: string[] }>(node.source_ref_json).chapterIds ?? [] : [],
          skillContext: skillBasis ? { point: node.requirement_json ? json(node.requirement_json) : null,
            source: node.source_ref_json ? json(node.source_ref_json) : null } : undefined,
          theoryContext: skillBasis ? undefined : theoryPointContext(node.requirement_json, node.source_ref_json) };
      }),
      model: { provider: connection.provider, baseUrl: connection.baseUrl, model: connection.model },
    };
    // Public basic questions never mix single-choice and judgement output in
    // one model request. Their formats differ materially and share one review
    // path poorly, especially during a retry.
    const batches = buildBatches(snapshot.points, Boolean(scope.commonGroupId));
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
    if (scope.commonGroupId) await prefillCommonSlots(db, scope.commonGroupId, jobId);
    await refreshJob(db, jobId);
    await audit(db, plan.project_id, actorId, planId, "authoring.plan.generation_started", { jobId, total: batches.reduce((sum, batch) => sum + batch.target, 0), batches: batches.length });
    return jobId;
  });
  ensureGenerationWorker();
  return { jobId: id, ...await getGenerationState(planId) };
}

export async function startSupplementGeneration(planId: string, actorId: string) {
  const connection = await getSavedModelConnection();
  if (!connection) throw new Error("未配置可用模型连接，请先保存模型设置。");
  const result = await withTransaction((db) => queueSupplementRound(db, planId, actorId, connection));
  ensureGenerationWorker();
  return { ...result, ...await getGenerationState(planId) };
}

export async function getGenerationState(planId: string) {
  const common = await commonPlanProgress(planId);
  const jobs = await query<(RowDataPacket & { id: string; status: string; target_count: number; snapshot_json: Snapshot | string; termination_summary_json: unknown; stop_summary_json: unknown })[]>(
    "SELECT id,status,target_count,snapshot_json,termination_summary_json,stop_summary_json FROM authoring_generation_jobs WHERE plan_id=?", [planId],
  );
  if (!jobs[0]) return { job: null, common };
  const job = jobs[0];
  const snapshot = json<Snapshot>(job.snapshot_json);
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
  const snapshotUsesCommonGroup = Boolean(snapshot.scope.commonGroupId);
  const batchGenerated = batches.reduce((sum, batch) => sum + Number(batch.generated_count), 0);
  const pending = batches.reduce((sum, batch) => sum + Number(batch.pending), 0);
  const target = snapshotUsesCommonGroup && common ? common.target : Number(job.target_count);
  const generated = snapshotUsesCommonGroup && common ? common.available : batchGenerated;
  const status = ["cancelled", "stopped"].includes(job.status) ? job.status : generated === target ? "succeeded" : pending ? job.status === "queued" ? "queued" : "running" : "partial";
  return {
    common,
    job: {
      id: job.id, status, target, generated,
      retryLimits: { strategy: "per_slot_v2", perSlotGenerations: MAX_SLOT_GENERATIONS, perSlotRepairs: MAX_SLOT_REPAIRS,
        modelCallsPerUnit: MAX_UNIT_MODEL_CALLS,
        legacy: { totalAttempts: MAX_TOTAL_ATTEMPTS, targetedAttempts: MAX_TARGETED_ATTEMPTS, consecutiveZeroOutputs: 2 } },
      activity: await readGenerationActivity(job.id),
      terminationSummary: job.termination_summary_json ? json(job.termination_summary_json) : null,
      stopSummary: job.stop_summary_json ? json(job.stop_summary_json) : null,
      totalBatches: batches.length,
      completedBatches: batches.filter((batch) => Number(batch.generated_count) === Number(batch.target)).length,
      currentBatch: batches.find((batch) => Number(batch.running))?.ordinal ?? batches.find((batch) => Number(batch.pending))?.ordinal ?? null,
      failedUnits: failed.map((unit) => {
        const state = retryState(unit.retry_state_json);
        const recovery = retryState(JSON.stringify(state));
        const theoryBasisUpgrade = recoverTheoryBasisRevision(recovery, snapshot, unit.point_code);
        const expansionProtocolUpgrade = recoverExpansionReviewProtocol(recovery, snapshot, unit.point_code);
        const expansionUpgrade = expansionProtocolUpgrade || recoverCuratedTheoryBasis(recovery, snapshot, unit.point_code)
          || recoverNoTextbookTheory(recovery, snapshot, unit.point_code);
        const protocolUpgrade = recoverSkillDesignProtocol(recovery);
        const theoryUpgrade = recoverTheoryDuplicate(recovery);
        const theoryEchoUpgrade = recoverTheoryEcho(recovery, snapshot, unit.point_code);
        const skillUpgrade = grantSkillRecovery(recovery, Number(unit.attempts));
        const flowUpgrade = recoverPrematureBlocks(recovery) && !retryBlocked(recovery, Number(unit.attempts), true);
        const skillRecoveryAvailable = skillUpgrade && !retryBlocked(recovery, Number(unit.attempts), true);
        return { id: unit.id, code: unit.point_code, type: unit.question_type, remaining: Number(unit.remaining),
          error: unit.error_message ?? (status === "stopped" ? "任务已停止，此缺额不再处理。" : "请求失败。"), attempts: Number(unit.attempts), failures: state.failures,
          stopReason: status === "stopped" ? "已停止，不再处理此缺额。" : state.stopReason,
          retryable: !["stopped", "cancelled"].includes(status) && (!state.budget || skillRecoveryAvailable || flowUpgrade
            || ((protocolUpgrade || theoryUpgrade || theoryEchoUpgrade || theoryBasisUpgrade || expansionUpgrade) && !retryBlocked(recovery, Number(unit.attempts), true)) || !retryBlocked(state, Number(unit.attempts), true)),
          theoryBasisRecoveryAvailable: !["stopped", "cancelled"].includes(status) && theoryBasisUpgrade && !retryBlocked(recovery, Number(unit.attempts), true),
          theoryEchoRecoveryAvailable: !["stopped", "cancelled"].includes(status) && theoryEchoUpgrade && !retryBlocked(recovery, Number(unit.attempts), true),
          theoryRedesignAvailable: !["stopped", "cancelled"].includes(status) && theoryUpgrade && !retryBlocked(recovery, Number(unit.attempts), true),
          theoryExpansionAvailable: !["stopped", "cancelled"].includes(status) && expansionUpgrade && !retryBlocked(recovery, Number(unit.attempts), true),
          expansionProtocolRecoveryAvailable: !["stopped", "cancelled"].includes(status) && expansionProtocolUpgrade && !retryBlocked(recovery, Number(unit.attempts), true),
          expansionDocuments: state.budget?.theoryExpansion?.documents.filter((document) => !state.budget?.theoryExpansion?.basisRevision
            || document.retainedSource?.id === state.budget.theoryExpansion.basisRevision.toId).map((document) => ({
            id: document.id, title: document.suggestedTitle, url: document.url, text: document.text,
            retrievedAt: document.retrievedAt, publication: document.retainedSource?.publication,
            locator: document.retainedSource?.locator, acquisition: document.retainedSource?.acquisition,
          })),
          designProtocolRecoveryAvailable: !["stopped", "cancelled"].includes(status) && protocolUpgrade && !retryBlocked(recovery, Number(unit.attempts), true),
          strategyUpgradeAvailable: !state.budget || flowUpgrade || expansionUpgrade,
          skillRecoveryAvailable: !["stopped", "cancelled"].includes(status) && skillRecoveryAvailable,
          skillRecovery: state.budget?.skillRecovery,
          reviewContext: state.budget?.reviewContext,
          modelCalls: state.budget ? { used: state.budget.calls, limit: state.budget.maxCalls } : undefined,
          missingSlots: state.budget ? Object.entries(state.budget.slots).filter(([, slot]) => !slot.done).map(([id, slot]) => ({
            id, ordinal: slot.ordinal, type: slot.type, generations: slot.generations, repairs: slot.repairs,
            generationLimit: theoryGenerationLimit(slot),
            expansionRecovered: Boolean(slot.expansionRecovery),
            theoryEchoRecovered: Boolean(slot.theoryEchoRecovery),
            theoryBasisRecovered: Boolean(slot.theoryBasisRecovery),
            searched: state.budget!.catalogIds ? slot.searchedSourceIds.filter((id) => state.budget!.catalogIds!.includes(id)).length : slot.searchedSourceIds.length,
            totalSources: state.budget!.sourceCount ?? 0, reason: slot.blocked?.message,
            skill: slot.skill ? { generations: slot.generations - slot.skill.generationBase, repairs: slot.repairs - slot.skill.repairBase,
              designAttempts: slot.skill.designAttempts, designAttemptCredits: slot.skill.designProtocolRecovery?.designAttemptCredits ?? 0,
              designChecklistFailures: slot.skill.designChecklistFailures ?? 0 } : undefined,
            reviewRecord: { 原文依据: slot.evidenceSources ?? (slot.angle ? [{ id: slot.angle.sourceId, content: slot.angle.quote }] : []),
              分析记录: slot.searchReasons, 待核验候选响应: slot.pendingResponse, 修订记录: slot.candidateRepairs,
              核验响应: slot.reviewResponses, 历史候选: slot.rejectedCandidates, 原关闭原因: slot.recoveredBlock, 技能专项记录: slot.skill,
              无教材扩展依据: state.budget!.theoryExpansion, 扩展流程恢复: slot.expansionRecovery, 旧题复述恢复: slot.theoryEchoRecovery,
              指标资料修订恢复: slot.theoryBasisRecovery },
          })) : [] };
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
    if (state.supplement) unit.created_by = state.supplement.actorId;
    if (!unit.retry_state_json && Number(unit.attempts) > 0 && unit.error_message) {
      state.targeted = true;
      state.failures = [validationFailure(unit.error_message)];
    }
    if (state.targeted) {
      const [missing] = await db.execute<(RowDataPacket & MissingSlot)[]>(
        "SELECT id,ordinal,question_type FROM authoring_generation_slots WHERE unit_id=? AND question_id IS NULL ORDER BY ordinal FOR UPDATE", [unit.id],
      );
      ensureTargetedBudget(state, missing, Number(unit.attempts));
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
      if (output.targetedFlow && !question.standardReview && !question.lowBasisDraft) {
        failures.push({ code: "quality_rejected", message: "补题候选未经完整质量标准核验，不计入成果。" });
        continue;
      }
      if (question.targetSlotId && !slots.some((slot) => slot.id === question.targetSlotId)) continue;
      if (question.questionType === "practical") {
        const cleaned = cleanSkillStem(question.stem, snapshot.scope.occupation);
        if (cleaned !== question.stem) {
          question.originalStem ??= question.stem;
          question.stem = cleaned;
        }
      }
      const hash = stemHash(question.stem);
      const [duplicates] = await db.execute<RowDataPacket[]>("SELECT id FROM authoring_generation_slots WHERE job_id=? AND stem_hash=? LIMIT 1", [unit.job_id, hash]);
      if (duplicates.length) { failures.push({ code: "duplicate", message: "题干与本任务已有题重复。" }); continue; }
      const slot = slots.find((item) => item.question_type === question.questionType && (!question.targetSlotId || item.id === question.targetSlotId));
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
        supplement: output.state.supplement,
        stemCleanup: question.originalStem ? { originalStem: question.originalStem, cleanedStem: question.stem, rule: "remove_identity_intro" } : undefined,
        formatRepairs: question.formatRepairs,
        candidateRepairs: question.candidateRepairs, standardReview: question.standardReview,
        scoringCalculation: question.scoringCalculation,
        skillTaskDesign: skill ? output.state.budget?.slots[slot.id]?.skill : undefined,
        targetedEvidence: output.state.budget?.slots[slot.id]?.evidenceSources,
        theoryExpansionEvidence: !skill ? output.state.budget?.theoryExpansion : undefined,
        targetedSlotId: question.targetSlotId, targetedHistory: output.state.budget?.history,
        appliedQualityStandard: unit.appliedQualityStandard,
        appliedSkillQualityStandard: skill ? unit.appliedQualityStandard : undefined,
        qualityRelaxations: output.state.selectedAngle?.reusesKnowledge
          ? output.state.qualityRelaxations?.filter((entry) => entry.knowledge === output.state.selectedAngle?.angle
            && entry.task === output.state.selectedAngle?.task && entry.questionType === question.questionType) : [],
        lowBasisDraft: question.lowBasisDraft,
      };
      await db.execute(`INSERT INTO questions(id,project_id,question_no,occupation_id,level_code,assessment_mode,question_type,current_version_id,current_status)
        VALUES(?,?,?,?,?,?,?,?,?)`, [questionId, snapshot.projectId, `AI-${unit.plan_id}-${String(slot.ordinal).padStart(4, "0")}`,
        snapshot.scope.occupationId, snapshot.scope.commonGroupId ? null : snapshot.scope.levelCode, skill ? "skill" : "theory", type, versionId, status]);
      await db.execute(`INSERT INTO question_versions(id,question_id,version_no,stem,content_json,answer_json,analysis_text,score_rubric_json,source_snapshot_json,content_hash,created_by)
        VALUES(?,?,1,?,?,?,?,?,?,?,?)`, [versionId, questionId, question.stem, JSON.stringify({ options: question.options }),
        JSON.stringify({ answers: question.answers }), question.analysis, question.scoreRubric ? JSON.stringify(question.scoreRubric) : null, JSON.stringify(source),
        createHash("sha256").update(JSON.stringify(question)).digest("hex"), unit.created_by]);
      for (const option of question.options) {
        await db.execute("INSERT INTO question_options(id,question_version_id,option_key,content,is_correct) VALUES(?,?,?,?,?)",
          [createUlid(), versionId, option.key, option.content, question.answers.includes(option.key) ? 1 : 0]);
      }
      await db.execute("INSERT INTO question_assessment_points(question_version_id,blueprint_node_id) VALUES(?,?)", [versionId, node.id]);
      await registerCommonGenerated(db, snapshot.scope, questionId, node, unit.plan_id);
      await db.execute(`INSERT INTO question_quality_checks(id,question_version_id,check_round,check_code,severity,result,detail_json)
        VALUES(?,?,'rule','authoring.basic_structure','info','pass',?)`, [createUlid(), versionId, JSON.stringify({ planId: unit.plan_id, unitId: unit.id, optionsValid: true })]);
      if (question.standardReview) {
        await db.execute(`INSERT INTO question_quality_checks(id,question_version_id,check_round,check_code,severity,result,detail_json)
          VALUES(?,?,'independent_review','authoring.full_standard','info','pass',?)`,
        [createUlid(), versionId, JSON.stringify({ review: question.standardReview, standard: unit.appliedQualityStandard, angle: output.state.selectedAngle })]);
      }
      if (source.qualityRelaxations?.length) {
        await db.execute(`INSERT INTO question_quality_checks(id,question_version_id,check_round,check_code,severity,result,detail_json)
          VALUES(?,?,'rule','authoring.knowledge_variant','warning','manual_required',?)`,
        [createUlid(), versionId, JSON.stringify({
          message: "为满足缺额采用同一知识、不同考查任务，仅放宽知识独立性；请人工核查任务差异、答案和依据。",
          relaxations: source.qualityRelaxations, standard: unit.appliedQualityStandard,
        })]);
      }
      if (source.lowBasisDraft) {
        await db.execute(`INSERT INTO question_quality_checks(id,question_version_id,check_round,check_code,severity,result,detail_json)
          VALUES(?,?,'rule','authoring.low_basis_draft','warning','manual_required',?)`,
        [createUlid(), versionId, JSON.stringify({
          message: "当前题目仅依据标题范围起草，需在人工审核时补充来源摘录后方可确认和入库。",
          lowBasisDraft: source.lowBasisDraft,
        })]);
      }
      await db.execute(`INSERT INTO question_status_events(id,question_id,question_version_id,from_status,to_status,reason,actor_id)
        VALUES(?,?,?,NULL,?,'分批AI生成，等待人工核查',?)`, [createUlid(), questionId, versionId, status, unit.created_by]);
      await db.execute("UPDATE authoring_generation_slots SET question_id=?,stem_hash=? WHERE id=?", [questionId, hash, slot.id]);
      slots.splice(slots.indexOf(slot), 1);
      markTargetedSaved(output.state, slot.id);
      saved += 1;
    }
    if (slots.length && !failures.length && !saved) failures.push({ code: "invalid_content", message: "模型未返回可保存的试题。" });
    const result = completeRetry(output.state, unit.attempts, saved, slots.length, failures, output.preparationFailure);
    const details = [...new Set(failures.map((failure) => failure.message))].join("；") || "仅补缺额，下一次按对应质量标准和不同考查任务补一道";
    await db.execute(`UPDATE authoring_generation_units SET status=?,error_message=?,retry_state_json=?,lease_token=NULL,lease_until=NULL,
      next_attempt_at=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL ? SECOND) WHERE id=?`,
    [result.status, result.status === "succeeded" ? null : `${details}；本次保存${saved}题，尚缺${slots.length}题${result.state.stopReason ? `；${result.state.stopReason}` : ""}`.slice(0, 2000),
      JSON.stringify(result.state), result.delay, unit.id]);
    await refreshJob(db, unit.job_id);
    if (saved) await audit(db, snapshot.projectId, unit.created_by, unit.plan_id, "authoring.plan.batch_output_saved", {
      jobId: unit.job_id, batchId: unit.batch_id, unitId: unit.id, saved,
      qualityRelaxations: output.state.qualityRelaxations, standard: unit.appliedQualityStandard,
    });
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
  const missing = await query<(RowDataPacket & MissingSlot)[]>(
    "SELECT id,ordinal,question_type FROM authoring_generation_slots WHERE unit_id=? AND question_id IS NULL ORDER BY ordinal", [unit.id],
  );
  if (!missing.length) return { questions: [], failures: [], state };
  // Public basic questions share their frozen public blueprint, but thinning
  // source text still makes a full batch collide on stems. Retries therefore
  // reuse the same angle analysis as ordinary plans; external expansion stays
  // disabled for them in the targeted workflow itself.
  const useTargetedFlow = state.targeted;
  const requested = useTargetedFlow ? missing.slice(0, 1) : missing;
  const node = snapshot.nodes.find((item) => item.code === unit.point_code)!;
  const [metadata] = await query<(RowDataPacket & { name: string; requirement_json: unknown; source_ref_json: unknown })[]>(
    "SELECT name,requirement_json,source_ref_json FROM blueprint_nodes WHERE id=?", [node.id],
  );
  if (metadata && isLegalPoint(metadata)) throw new GenerationFailure("restricted_scope", "法律法规考评点必须通过法规智能体及已核验原文命题，已阻止普通生成。");
  const previous = await query<(RowDataPacket & { stem: string; content: unknown; answer: unknown; analysis: string | null })[]>(
    `SELECT qv.stem,qv.content_json AS content,qv.answer_json AS answer,qv.analysis_text AS analysis
      FROM authoring_generation_slots s JOIN authoring_generation_units u ON u.id=s.unit_id
      JOIN questions q ON q.id=s.question_id JOIN question_versions qv ON qv.id=q.current_version_id
     WHERE s.job_id=? AND u.point_code=? ORDER BY s.ordinal`, [unit.job_id, unit.point_code],
  );
  let excerpts: Array<{ title: string; content: string; start: number }> = [];
  let evidenceChapters: EvidenceChapter[] = [];
  if (node.chapterIds.length) {
    let chapters = snapshot.sourceVersionIds.length
      ? await query<(RowDataPacket & { id: string; ordinal: number; chapter_title: string; section_title: string | null; content_text: string })[]>(
        `SELECT id,ordinal,chapter_title,section_title,content_text FROM textbook_chapters
         WHERE id IN (${node.chapterIds.map(() => "?").join(",")}) AND source_version_id IN (${snapshot.sourceVersionIds.map(() => "?").join(",")}) ORDER BY ordinal`,
        [...node.chapterIds, ...snapshot.sourceVersionIds],
      )
      : [];
    if (!chapters.length) {
      // Chapter ids are frozen in the snapshot itself. Public-group retries can
      // lose or drift source_version_ids, but we still prefer the exact frozen
      // chapter rows over incorrectly reporting "无可核验原文".
      chapters = await query<(RowDataPacket & { id: string; ordinal: number; chapter_title: string; section_title: string | null; content_text: string })[]>(
        `SELECT id,ordinal,chapter_title,section_title,content_text FROM textbook_chapters
         WHERE id IN (${node.chapterIds.map(() => "?").join(",")}) ORDER BY ordinal`,
        node.chapterIds,
      );
    }
    evidenceChapters = chapters.map((chapter) => ({ ...chapter, source_type: "textbook" as const }));
    const pool = buildChapterExcerptPool(chapters.map((chapter) => ({
      id: chapter.id, ordinal: chapter.ordinal, chapterTitle: chapter.chapter_title, sectionTitle: chapter.section_title, content: chapter.content_text,
    })), node.name);
    excerpts = selectBatchExcerpts(pool, previous.length, Math.max(1, previous.length + missing.length), unit.attempts);
  } else if (snapshot.scope.assessmentMode === "理论知识") {
    const sourceVersionIds = theoryEvidenceSourceVersionIds(node);
    if (sourceVersionIds.length) {
      const standardSegments = await query<StandardEvidenceSegment[]>(
        `SELECT source_version_id,id,locator,content_excerpt FROM source_segments
         WHERE source_version_id IN (${sourceVersionIds.map(() => "?").join(",")})
         ORDER BY source_version_id, ordinal`,
        sourceVersionIds,
      );
      evidenceChapters = standardSegments.map((segment, index) => ({
        id: segment.id,
        chapter_title: segment.locator || `职业标准原文片段${index + 1}`,
        section_title: null,
        content_text: segment.content_excerpt,
        source_type: "standard",
      }));
    }
  }
  const kind = snapshot.scope.assessmentMode === "操作技能" ? "skill" : "theory";
  const standard = await readGenerationQualityStandard(kind);
  unit.appliedQualityStandard = standard;
  if (kind === "skill") {
    snapshot.qualityStandard = "";
    snapshot.skillQualityStandard = standard.content;
  } else {
    snapshot.qualityStandard = standard.content;
    snapshot.skillQualityStandard = undefined;
  }
  // Record the exact standard before analysis as well as generation, without
  // permitting a stopped task or an old lease to consume another model call.
  await withTransaction(async (db) => {
    await db.execute("SELECT id FROM authoring_generation_capacity WHERE id=1 FOR UPDATE");
    const [leases] = await db.execute<RowDataPacket[]>(
      "SELECT id FROM authoring_generation_units WHERE id=? AND lease_token=? AND status='running' FOR UPDATE",
      [unit.id, unit.lease_token],
    );
    if (!leases.length) throw new GenerationFailure("lease_expired", "质量标准读取后任务已停止或租约失效，不再生成。");
    await audit(db, snapshot.projectId, unit.created_by, unit.plan_id,
      kind === "skill" ? "authoring.plan.skill_quality_applied" : "authoring.plan.theory_quality_applied", {
        jobId: unit.job_id, unitId: unit.id, attempts: unit.attempts, standard,
      });
  });
  unit.retry_state_json = state;
  // Automatic expansion is reserved for ordinary chapterless points; public
  // basic questions reach the targeted flow only through an explicit retry.
  if (useTargetedFlow || (kind === "theory" && !node.chapterIds.length && !snapshot.scope.commonGroupId)) {
    state.targeted = true;
    const context = snapshot.scope.assessmentMode === "操作技能" ? node.skillContext : node.theoryContext;
    const sources = buildEvidenceCatalog(context, evidenceChapters, kind === "theory" ? theoryEvidenceTopic(node) : node.name);
    ensureTargetedBudget(state, missing, unit.attempts - 1);
    const result = await generateTargeted({ snapshot, code: node.code, previous, sources, state }, {
      signal: cancellation,
      call: (input) => callGenerationModel(snapshot, connection.apiKey, input, cancellation),
      persist: async () => {
        cancellation.throwIfAborted();
        // Check the lease on every phase, not only after analysis. A stopped
        // request cannot consume repair/review calls or save late responses.
        const persisted = await query<RowDataPacket[]>(
          "SELECT id FROM authoring_generation_units WHERE id=? AND lease_token=? AND status='running'", [unit.id, unit.lease_token],
        );
        if (!persisted.length) throw new GenerationFailure("lease_expired", "补题租约已失效，不再生成、修复或核验。");
        await query("UPDATE authoring_generation_units SET retry_state_json=? WHERE id=? AND lease_token=? AND status='running'",
          [JSON.stringify(state), unit.id, unit.lease_token]);
      },
    });
    return { ...result, targetedFlow: true };
  }
  const { instruction, prompt } = kind === "skill"
    ? skillQuestionPrompt(snapshot, node.code, requested.length, previous.map((item) => item.stem))
    : theoryQuestionPrompt(snapshot, node.code, requested.map((slot) => slot.question_type), previous, excerpts, unit.attempts, state.targeted);
  const content = await callGenerationModel(snapshot, connection.apiKey, { instruction, prompt }, cancellation);
  let parsed: ReturnType<typeof parseQuestions>;
  try { parsed = parseQuestions(content, node.code, snapshot.scope.assessmentMode === "操作技能" ? "practical" : useTargetedFlow ? requested[0].question_type : unit.question_type,
    snapshot.scope.occupation, { judgement: kind === "theory" }); }
  catch (error) { throw new GenerationFailure("invalid_json", error instanceof Error ? error.message : "试题 JSON 无效。"); }
  const failures = parsed.invalidReasons.map(validationFailure);
  if (!parsed.valid.length && !failures.length) failures.push({ code: "invalid_content", message: "模型未返回试题，新增有效题为0。" });
  return { questions: useTargetedFlow ? parsed.valid.slice(0, 1) : parsed.valid, failures, state };
}

async function callGenerationModel(snapshot: Snapshot, apiKey: string, input: { instruction: string; prompt: string }, cancellation: AbortSignal) {
  cancellation.throwIfAborted();
  const target = endpoint(snapshot.model);
  const response = await fetch(target.url, {
    method: "POST",
    headers: target.anthropic ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" }
      : { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(target.anthropic
      ? { model: snapshot.model.model, max_tokens: 65536, system: input.instruction, messages: [{ role: "user", content: input.prompt }] }
      : { model: snapshot.model.model, temperature: 0.5, max_tokens: 65536, response_format: { type: "json_object" },
        messages: [{ role: "system", content: input.instruction }, { role: "user", content: input.prompt }] }),
      signal: AbortSignal.any([cancellation, AbortSignal.timeout(600000)]),
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
    catch (error) { output = { questions: [], failures: [failureOf(error)], state: retryState(unit.retry_state_json), preparationFailure: true }; }
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
