import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { withTransaction } from "@/shared/database/mysql";
import { createUlid } from "@/shared/database/ulid";
import { abortGenerationUnits } from "./cancellation";

export type StopSummary = { target: number; preservedQuestions: number; missingQuestions: number; stoppedAt: string };

export async function stopGenerationKeepResults(planId: string, actorId: string) {
  const result = await withTransaction(async (db) => {
    // Shared lock with claim/save/cleanup makes the retained count definitive.
    await db.execute("SELECT id FROM authoring_generation_capacity WHERE id=1 FOR UPDATE");
    const [plans] = await db.execute<(RowDataPacket & { project_id: string; status: string })[]>(
      "SELECT project_id,status FROM authoring_plans WHERE id=? FOR UPDATE", [planId],
    );
    if (!plans[0]) throw new Error("命题计划不存在。");
    const [jobs] = await db.execute<(RowDataPacket & { id: string; status: string; target_count: number; stop_summary_json: StopSummary | string | null })[]>(
      "SELECT id,status,target_count,stop_summary_json FROM authoring_generation_jobs WHERE plan_id=? FOR UPDATE", [planId],
    );
    const job = jobs[0];
    if (!job) throw new Error("该计划尚未启动生成任务。");
    const [units] = await db.execute<(RowDataPacket & { id: string })[]>(
      "SELECT id FROM authoring_generation_units WHERE job_id=? FOR UPDATE", [job.id],
    );
    const unitIds = units.map((unit) => unit.id);
    if (job.status === "stopped") {
      if (!job.stop_summary_json) throw new Error("停止记录缺失，请联系管理员核对。");
      return { jobId: job.id, unitIds, summary: typeof job.stop_summary_json === "string" ? JSON.parse(job.stop_summary_json) as StopSummary : job.stop_summary_json };
    }
    if (plans[0].status !== "confirmed" || !["queued", "running", "partial"].includes(job.status)) {
      throw new Error("仅排队、生成中或部分失败的任务可以停止并保留成果。");
    }
    const [counts] = await db.execute<(RowDataPacket & { generated_count: number })[]>(
      "SELECT COUNT(question_id) AS generated_count FROM authoring_generation_slots WHERE job_id=?", [job.id],
    );
    const summary: StopSummary = {
      target: Number(job.target_count), preservedQuestions: Number(counts[0].generated_count),
      missingQuestions: Math.max(0, Number(job.target_count) - Number(counts[0].generated_count)),
      stoppedAt: new Date().toISOString(),
    };
    // Keep slots, errors and retry history as the original gap manifest.
    await db.execute(`UPDATE authoring_generation_units SET status='stopped',lease_token=NULL,lease_until=NULL
      WHERE job_id=? AND status IN ('queued','running','failed')`, [job.id]);
    await db.execute("UPDATE authoring_generation_jobs SET status='stopped',stop_summary_json=? WHERE id=?", [JSON.stringify(summary), job.id]);
    await db.execute(`INSERT INTO audit_logs(id,project_id,actor_id,action,object_type,object_id,after_json,result)
      VALUES(?,?,?,'authoring.plan.stopped_keep_results','authoring_plan',?,?,'success')`,
      [createUlid(), plans[0].project_id, actorId, planId, JSON.stringify({ jobId: job.id, ...summary })]);
    return { jobId: job.id, unitIds, summary };
  });
  // A new supplement round may start after commit. Abort only the captured
  // request IDs, never its newly registered requests under the same job.
  abortGenerationUnits(result.unitIds);
  return result.summary;
}

export async function assertGenerationHandoffReady(db: PoolConnection, planId: string) {
  const [jobs] = await db.execute<(RowDataPacket & { id: string; status: string; target_count: number })[]>(
    "SELECT id,status,target_count FROM authoring_generation_jobs WHERE plan_id=? FOR UPDATE", [planId],
  );
  if (!jobs[0]) return; // Legacy synchronous plans retain their existing flow.
  const [counts] = await db.execute<(RowDataPacket & { generated_count: number; pending: number; unfinished: number })[]>(
    `SELECT COUNT(question_id) AS generated_count,
      (SELECT COUNT(*) FROM authoring_generation_units WHERE job_id=? AND status IN ('queued','running','failed')) AS pending,
      (SELECT COUNT(*) FROM authoring_generation_units u WHERE job_id=? AND status<>'succeeded'
        AND EXISTS(SELECT 1 FROM authoring_generation_slots s WHERE s.unit_id=u.id AND s.question_id IS NULL)) AS unfinished
     FROM authoring_generation_slots WHERE job_id=?`, [jobs[0].id, jobs[0].id, jobs[0].id],
  );
  if (jobs[0].status === "stopped") {
    if (!Number(counts[0].generated_count)) throw new Error("停止任务没有保留试题，不能交接空成果。");
    if (Number(counts[0].pending)) throw new Error("停止任务仍有未关闭请求，请先核对停止状态。");
    return;
  }
  if (jobs[0].status !== "succeeded" || Number(counts[0].generated_count) !== Number(jobs[0].target_count)
    || Number(counts[0].pending) || Number(counts[0].unfinished)) {
    throw new Error("命题计划尚未全部生成完成，请补齐失败部分，或停止生成并保留成果后再交接专家审定。");
  }
}
