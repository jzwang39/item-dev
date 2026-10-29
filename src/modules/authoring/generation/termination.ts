import type { RowDataPacket } from "mysql2/promise";
import { withTransaction } from "@/shared/database/mysql";
import { createUlid } from "@/shared/database/ulid";
import { abortGenerationJob } from "./cancellation";

export type TerminationSummary = { deletedQuestions: number; preservedQuestions: number };

export async function terminateGeneration(planId: string, actorId: string) {
  const result = await withTransaction(async (db) => {
    // Same leading lock as claiming and saving: a late result cannot race cleanup.
    await db.execute("SELECT id FROM authoring_generation_capacity WHERE id=1 FOR UPDATE");
    const [plans] = await db.execute<(RowDataPacket & { project_id: string; status: string })[]>(
      "SELECT project_id,status FROM authoring_plans WHERE id=? FOR UPDATE", [planId],
    );
    const plan = plans[0];
    if (!plan) throw new Error("命题计划不存在。");
    const [jobs] = await db.execute<(RowDataPacket & { id: string; status: string; termination_summary_json: TerminationSummary | string | null })[]>(
      "SELECT id,status,termination_summary_json FROM authoring_generation_jobs WHERE plan_id=? FOR UPDATE", [planId],
    );
    const job = jobs[0];
    if (!job) throw new Error("该计划尚未启动生成任务。");
    if (job.status === "cancelled") return {
      jobId: job.id,
      summary: typeof job.termination_summary_json === "string" ? JSON.parse(job.termination_summary_json) as TerminationSummary
        : job.termination_summary_json ?? { deletedQuestions: 0, preservedQuestions: 0 },
    };
    if (!["queued", "running", "partial"].includes(job.status)) throw new Error("已完成任务不能终止清理，请通过试题管理处理。");
    const [questions] = await db.execute<(RowDataPacket & { id: string; current_status: string; current_version_id: string })[]>(
      `SELECT q.id,q.current_status,q.current_version_id FROM questions q
       JOIN authoring_generation_slots s ON s.question_id=q.id WHERE s.job_id=? FOR UPDATE`, [job.id],
    );
    let deletedQuestions = 0;
    for (const question of questions) {
      if (!["draft", "pending_review"].includes(question.current_status)) continue;
      const [versions] = await db.execute<(RowDataPacket & { id: string; version_no: number; source_snapshot_json: unknown })[]>(
        "SELECT id,version_no,source_snapshot_json FROM question_versions WHERE question_id=? FOR UPDATE", [question.id],
      );
      if (versions.length !== 1 || versions[0].id !== question.current_version_id || versions[0].version_no !== 1) continue;
      const source = typeof versions[0].source_snapshot_json === "string" ? JSON.parse(versions[0].source_snapshot_json) : versions[0].source_snapshot_json;
      if (source?.planId !== planId || source?.jobId !== job.id) continue;
      const [references] = await db.execute<(RowDataPacket & { protected: number })[]>(
        `SELECT (
          EXISTS(SELECT 1 FROM review_assignments WHERE question_id=?) OR
          EXISTS(SELECT 1 FROM review_records WHERE question_version_id=?) OR
          EXISTS(SELECT 1 FROM question_review_confirmations WHERE question_version_id=?) OR
          EXISTS(SELECT 1 FROM paper_items WHERE question_id=?) OR
          EXISTS(SELECT 1 FROM question_revision_links WHERE from_question_version_id=? OR to_question_version_id=?)
        ) AS protected`,
        [question.id, versions[0].id, versions[0].id, question.id, versions[0].id, versions[0].id],
      );
      if (references[0].protected) continue;
      // Keep the original draft snapshot in the audit trail, not in the active bank.
      const [original] = await db.execute<RowDataPacket[]>("SELECT * FROM question_versions WHERE id=?", [versions[0].id]);
      await db.execute(
        `INSERT INTO audit_logs(id,project_id,actor_id,action,object_type,object_id,before_json,after_json,result)
         VALUES(?,?,?,'authoring.plan.cancelled_draft_removed','question',?,?,?,'success')`,
        [createUlid(), plan.project_id, actorId, question.id, JSON.stringify(original[0]), JSON.stringify({ planId, jobId: job.id })],
      );
      await db.execute("UPDATE authoring_generation_slots SET question_id=NULL,stem_hash=NULL WHERE question_id=? AND job_id=?", [question.id, job.id]);
      await db.execute("DELETE FROM question_status_events WHERE question_id=?", [question.id]);
      for (const table of ["question_options", "question_assessment_points", "question_source_refs", "question_quality_checks", "question_version_tags"]) {
        await db.execute(`DELETE FROM ${table} WHERE question_version_id=?`, [versions[0].id]);
      }
      await db.execute("DELETE FROM question_versions WHERE id=?", [versions[0].id]);
      await db.execute("DELETE FROM questions WHERE id=?", [question.id]);
      deletedQuestions++;
    }
    const summary = { deletedQuestions, preservedQuestions: questions.length - deletedQuestions };
    await db.execute("DELETE FROM authoring_generation_slots WHERE job_id=?", [job.id]);
    await db.execute("DELETE FROM authoring_generation_units WHERE job_id=?", [job.id]);
    await db.execute("DELETE FROM authoring_generation_batches WHERE job_id=?", [job.id]);
    await db.execute("UPDATE authoring_generation_jobs SET status='cancelled',termination_summary_json=? WHERE id=?", [JSON.stringify(summary), job.id]);
    await db.execute("UPDATE authoring_plans SET status='cancelled',row_version=row_version+1 WHERE id=?", [planId]);
    await db.execute(
      `INSERT INTO audit_logs(id,project_id,actor_id,action,object_type,object_id,after_json,result)
       VALUES(?,?,?,'authoring.plan.terminated','authoring_plan',?,?,'success')`,
      [createUlid(), plan.project_id, actorId, planId, JSON.stringify(summary)],
    );
    return { jobId: job.id, summary };
  });
  abortGenerationJob(result.jobId);
  return result.summary;
}
