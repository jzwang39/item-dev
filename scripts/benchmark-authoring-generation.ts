import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { loadEnvConfig } from "@next/env";
import type { RowDataPacket } from "mysql2/promise";

import { query, withTransaction, getPool } from "../src/shared/database/mysql";
import { createUlid } from "../src/shared/database/ulid";
import type { QuotaPoint, Scope } from "../src/modules/authoring/generation/contracts";

async function main() {
  loadEnvConfig(process.cwd());
  const { startGeneration, getGenerationState } = await import("../src/modules/authoring/generation/service");
  const parse = <T>(value: T | string): T => typeof value === "string" ? JSON.parse(value) as T : value;
  const sourcePlanId = process.argv[2];
  assert.ok(sourcePlanId, "Provide the source plan ID.");
  const sources = await query<(RowDataPacket & {
    project_id: string; created_by: string; raw_requirement: string;
    scope_json: Scope | string; quota_json: string;
  })[]>("SELECT project_id,created_by,raw_requirement,scope_json,quota_json FROM authoring_plans WHERE id=?", [sourcePlanId]);
  assert.equal(sources.length, 1);
  const source = sources[0];
  const scope = parse<Scope>(source.scope_json);
  const quota = parse<{ points: QuotaPoint[]; qualityRequirements?: string[] }>(source.quota_json);
  assert.ok(quota.points.length >= 20);
  // Evenly sample the frozen outline instead of taking only its first chapter.
  const points = Array.from({ length: 20 }, (_, index) => ({
    ...quota.points[Math.floor(index * quota.points.length / 20)],
    single: 4, multiple: 0, judgement: 2, total: 6,
  }));
  const planId = createUlid();
  await withTransaction(async (db) => {
    await db.execute(
      `INSERT INTO authoring_plans(id,project_id,name,raw_requirement,scope_json,quota_json,status,created_by)
       VALUES(?,?,?,?,?,?,'confirmed',?)`,
      [planId, source.project_id, "耗时基准试跑：20考评点120题", source.raw_requirement,
        JSON.stringify(scope), JSON.stringify({ ...quota, points, minimumTotal: 120, benchmarkSourcePlanId: sourcePlanId }), source.created_by],
    );
    await db.execute(
      `INSERT INTO audit_logs(id,project_id,actor_id,action,object_type,object_id,after_json,result)
       VALUES(?,?,?,'authoring.benchmark.created','authoring_plan',?,?,'success')`,
      [createUlid(), source.project_id, source.created_by, planId, JSON.stringify({ sourcePlanId, pointCodes: points.map((point) => point.code) })],
    );
  });
  const startedAt = new Date();
  const clock = performance.now();
  const started = await startGeneration(planId, source.created_by);
  console.info(JSON.stringify({ planId, startedAt: startedAt.toISOString(), target: 120, requests: 20, concurrency: 2 }));
  let peakRunning = 0;
  let lastGenerated = -1;
  let state = await getGenerationState(planId);
  while (state.job?.status === "queued" || state.job?.status === "running") {
    const running = await query<(RowDataPacket & { count: number })[]>(
      "SELECT COUNT(*) AS count FROM authoring_generation_units WHERE job_id=? AND status='running'", [started.jobId],
    );
    peakRunning = Math.max(peakRunning, Number(running[0].count));
    if (state.job.generated !== lastGenerated) {
      console.info(JSON.stringify({ elapsedSeconds: Math.round((performance.now() - clock) / 1000), generated: state.job.generated, running: Number(running[0].count) }));
      lastGenerated = state.job.generated;
    }
    if (performance.now() - clock > 60 * 60 * 1000) {
      throw new Error(`Benchmark exceeded one hour. Plan ${planId} remains resumable; no results were deleted.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
    state = await getGenerationState(planId);
  }
  const elapsedSeconds = (performance.now() - clock) / 1000;
  const units = await query<(RowDataPacket & { point_code: string; attempts: number; status: string; error_message: string | null })[]>(
    "SELECT point_code,attempts,status,error_message FROM authoring_generation_units WHERE job_id=? ORDER BY batch_id,ordinal", [started.jobId],
  );
  const actualQuota = await query<(RowDataPacket & { point_code: string; singles: number; judgements: number; count: number })[]>(
    `SELECT u.point_code,COUNT(s.question_id) AS count,
      SUM(s.question_type='single' AND s.question_id IS NOT NULL) AS singles,
      SUM(s.question_type='judgement' AND s.question_id IS NOT NULL) AS judgements
     FROM authoring_generation_units u JOIN authoring_generation_slots s ON s.unit_id=u.id
     WHERE u.job_id=? GROUP BY u.point_code`, [started.jobId],
  );
  const snapshot = await query<(RowDataPacket & { snapshot_json: string })[]>(
    "SELECT snapshot_json FROM authoring_generation_jobs WHERE id=?", [started.jobId],
  );
  const model = parse<{ model: { model: string }; nodes: Array<{ chapterIds: string[] }> }>(snapshot[0].snapshot_json);
  const generated = state.job?.generated ?? 0;
  const quotaPassed = actualQuota.length === 20 && actualQuota.every((row) => Number(row.singles) === 4 && Number(row.judgements) === 2 && Number(row.count) === 6);
  const attempts = units.reduce((sum, unit) => sum + Number(unit.attempts), 0);
  const report = [
    "# 试题生成耗时基准：20个考评点、120道题",
    "",
    `- 任务：\`${planId}\``,
    `- 开始：${startedAt.toISOString()}`,
    `- 结束：${new Date().toISOString()}`,
    `- 模型：${model.model.model}`,
    `- 策略：每点一次请求4道单选+2道判断，数据库全局最多2路并发`,
    `- 抽样：从原计划${quota.points.length}个考评点中等距抽取20个，冻结原教材和细目表版本`,
    `- 有教材章节引用的考评点：${model.nodes.filter((node) => node.chapterIds.length).length}/20`,
    `- 最终状态：${state.job?.status}`,
    `- 保存：${generated}/120道`,
    `- 题型配额校验：${quotaPassed ? "通过：每点4单选+2判断" : "未完整通过"}`,
    `- 总墙钟耗时（含创建执行任务、网络重试、补齐、落库及轮询确认）：${elapsedSeconds.toFixed(1)}秒 / ${(elapsedSeconds / 60).toFixed(2)}分钟`,
    `- 观测并发峰值：${peakRunning}`,
    `- 内容请求尝试：${attempts}次；超过首次的补齐/失败重试：${Math.max(0, attempts - 20)}次`,
    `- 平均产量：${(generated * 60 / elapsedSeconds).toFixed(2)}题/分钟`,
    `- 1200题线性外推：${quotaPassed ? `${(elapsedSeconds * 10 / 60).toFixed(1)}分钟（不是承诺，长任务限流和重试会变化）` : "未完成120题，不能作为完整耗时基准"}`,
    "",
    "## 边界",
    "",
    "使用真实模型与实际业务落库。只做结构、题型配额及题干精确去重，未完成专家审定；语义正确性尚需人工核查。请求尝试按持久化unit.attempts统计，不包含一次内容请求内部的网络传输重试；轮询确认误差最多约5秒。旧任务的82分钟包含开发停顿，不能用于声称实测提升倍数。",
    "",
    "## 请求记录",
    "",
    "|考评点|尝试次数|状态|错误|",
    "|---|---:|---|---|",
    ...units.map((unit) => `|${unit.point_code}|${unit.attempts}|${unit.status}|${(unit.error_message ?? "").replace(/\|/g, "/").replace(/\n/g, " ")}|`),
    "",
  ].join("\n");
  const reportPath = "/Users/jian-zhiwang/1.cases/item-dev/docs/试题生成-120题耗时基准.md";
  await writeFile(reportPath, report, "utf8");
  console.info(JSON.stringify({ planId, generated, quotaPassed, elapsedSeconds, peakRunning, attempts, reportPath }));
  if (!quotaPassed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}).finally(async () => {
  if (globalThis.__authoringGenerationWorker) clearInterval(globalThis.__authoringGenerationWorker.timer);
  await getPool().end();
});
