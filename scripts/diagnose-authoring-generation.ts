import { loadEnvConfig } from "@next/env";
import type { RowDataPacket } from "mysql2/promise";
import { getPool, query } from "../src/shared/database/mysql";

async function main() {
  loadEnvConfig(process.cwd(), false);
  const planId = process.argv[2];
  if (planId && !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(planId)) throw new Error("计划ID格式无效。");
  const clock = await query<RowDataPacket[]>(
    "SELECT @@session.time_zone AS session_timezone,NOW(3) AS database_now,UTC_TIMESTAMP(3) AS utc_now",
  );
  const tasks = await query<RowDataPacket[]>(
    `SELECT j.plan_id,j.status,j.target_count,j.created_at,
      COALESCE(SUM(u.status='queued'),0) AS queued,
      COALESCE(SUM(u.status='running'),0) AS running,
      COALESCE(SUM(u.status='failed'),0) AS failed,
      COALESCE(SUM(u.status='succeeded'),0) AS succeeded,
      COALESCE(SUM(u.status='queued' AND u.next_attempt_at<=UTC_TIMESTAMP(3)),0) AS ready,
      MIN(IF(u.status='queued',u.next_attempt_at,NULL)) AS earliest_next_attempt,
      MAX(u.updated_at) AS latest_unit_update
     FROM authoring_generation_jobs j LEFT JOIN authoring_generation_units u ON u.job_id=j.id
     ${planId ? "WHERE j.plan_id=?" : "WHERE j.status IN ('queued','running','partial')"}
     GROUP BY j.id ORDER BY j.created_at DESC LIMIT 20`, planId ? [planId] : [],
  );
  const units = await query<RowDataPacket[]>(
    `SELECT j.plan_id,u.point_code,u.status,u.attempts,u.next_attempt_at,u.lease_until,u.updated_at,u.error_message,
     TIMESTAMPDIFF(SECOND,UTC_TIMESTAMP(3),u.next_attempt_at) AS wait_seconds,
     TIMESTAMPDIFF(SECOND,UTC_TIMESTAMP(3),u.lease_until) AS lease_seconds_remaining
     FROM authoring_generation_units u JOIN authoring_generation_jobs j ON j.id=u.job_id
     WHERE ${planId ? "j.plan_id=?" : "j.status IN ('queued','running','partial')"}
       AND (u.status='running' OR u.error_message IS NOT NULL OR (u.status='queued' AND u.attempts=0))
     ORDER BY (u.status='running') DESC,(u.error_message IS NOT NULL) DESC,u.updated_at DESC LIMIT 20`,
    planId ? [planId] : [],
  );
  const capacity = await query<RowDataPacket[]>(
    "SELECT cooldown_until,COALESCE(cooldown_until>UTC_TIMESTAMP(3),0) AS cooling FROM authoring_generation_capacity WHERE id=1",
  );
  console.info(JSON.stringify({
    workerDisabled: process.env.AUTHORING_GENERATION_WORKER_DISABLED === "1",
    clock, capacity, tasks, units,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "诊断失败");
  process.exitCode = 1;
}).finally(async () => { if (globalThis.__itembankMysqlPool) await getPool().end(); });
