import type { RowDataPacket } from "mysql2/promise";
import { query } from "@/shared/database/mysql";

export type GenerationActivity = {
  state: "running" | "queued" | "retry_wait" | "rate_limited" | "recovering" | "disabled" | "idle";
  queued: number;
  running: number;
  globalRunning: number;
  recentErrors: Array<{ code: string; attempts: number; error: string }>;
};

export function activityState(counts: {
  running: number; queued: number; ready: number; expired: number;
}, cooling: boolean, disabled: boolean): GenerationActivity["state"] {
  if (disabled && (counts.running || counts.queued)) return "disabled";
  if (counts.running > counts.expired) return "running";
  if (counts.expired) return "recovering";
  if (counts.queued && cooling) return "rate_limited";
  if (counts.queued && !counts.ready) return "retry_wait";
  return counts.queued ? "queued" : "idle";
}

export async function readGenerationActivity(jobId: string): Promise<GenerationActivity> {
  const [counts] = await query<(RowDataPacket & {
    running: number; queued: number; ready: number; expired: number;
  })[]>(
    `SELECT COALESCE(SUM(status='running'),0) AS running,
      COALESCE(SUM(status='queued'),0) AS queued,
      COALESCE(SUM(status='queued' AND next_attempt_at<=UTC_TIMESTAMP(3)),0) AS ready,
      COALESCE(SUM(status='running' AND lease_until<UTC_TIMESTAMP(3)),0) AS expired
     FROM authoring_generation_units WHERE job_id=?`, [jobId],
  );
  const [global] = await query<(RowDataPacket & { running: number; cooling: number })[]>(
    `SELECT (SELECT COUNT(*) FROM authoring_generation_units WHERE status='running') AS running,
     COALESCE(cooldown_until>UTC_TIMESTAMP(3),0) AS cooling FROM authoring_generation_capacity WHERE id=1`,
  );
  const errors = await query<(RowDataPacket & { point_code: string; attempts: number; error_message: string })[]>(
    `SELECT point_code,attempts,error_message FROM authoring_generation_units
     WHERE job_id=? AND error_message IS NOT NULL AND status IN ('queued','running','failed')
     ORDER BY updated_at DESC,id DESC LIMIT 3`, [jobId],
  );
  const normalized = {
    running: Number(counts.running), queued: Number(counts.queued),
    ready: Number(counts.ready), expired: Number(counts.expired),
  };
  return {
    state: activityState(normalized, Boolean(Number(global?.cooling)), process.env.AUTHORING_GENERATION_WORKER_DISABLED === "1"),
    queued: normalized.queued, running: normalized.running, globalRunning: Number(global?.running ?? 0),
    recentErrors: errors.map((row) => ({ code: row.point_code, attempts: Number(row.attempts), error: row.error_message })),
  };
}
