import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { createUlid } from "@/shared/database/ulid";
import { assertOutlineConfirmed } from "@/modules/blueprints/point-review";
import { assertFrozenPlanBasis } from "./plan-basis";
import { questionTypes, quotaTotal, type QuestionType, type Snapshot } from "./contracts";
import { MAX_TARGETED_ATTEMPTS, retryState, type RetryState } from "./retry-policy";

export type SupplementSlot = { id: string; unit_id: string; ordinal: number; question_type: QuestionType; question_id: string | null };
export type SupplementUnit = { id: string; batch_id: string; ordinal: number; point_code: string; status: string; attempts: number; retry_state_json: unknown };
export type SupplementSummary = { roundId: string; target: number; preservedQuestions: number; missingQuestions: number; requests: number };

export function supplementManifest(snapshot: Snapshot, units: SupplementUnit[], slots: SupplementSlot[]) {
  const byUnit = new Map(units.map((unit) => [unit.id, unit]));
  const expected = new Map<string, number>(snapshot.points.flatMap((point) => questionTypes.map((type) => [`${point.code}:${type}`, point[type] ?? 0] as const)));
  const actual = new Map<string, number>();
  const missing = new Map<string, { unit: SupplementUnit; slots: SupplementSlot[] }>();
  const ids = new Set<string>();
  const ordinals = new Set<number>();
  for (const slot of slots) {
    const unit = byUnit.get(slot.unit_id);
    if (!unit || ids.has(slot.id) || ordinals.has(slot.ordinal)) throw new Error("题量槽位重复或关联请求缺失，请先核对计划。");
    ids.add(slot.id);
    ordinals.add(slot.ordinal);
    const key = `${unit.point_code}:${slot.question_type}`;
    if (!expected.has(key)) throw new Error("已有槽位超出冻结考评点或题型，不能补题。");
    actual.set(key, (actual.get(key) ?? 0) + 1);
    if (!slot.question_id) {
      if (unit.status !== "stopped") throw new Error("缺额请求尚未关闭，请先停止生成并保留成果。");
      const group = missing.get(unit.id) ?? { unit, slots: [] };
      group.slots.push(slot);
      missing.set(unit.id, group);
    }
  }
  if ([...expected].some(([key, count]) => (actual.get(key) ?? 0) !== count)) {
    throw new Error("逐考评点、逐题型槽位与冻结最低题量不一致，不能补题。");
  }
  const groups = [...missing.values()].flatMap((group) => {
    const sorted = group.slots.sort((a, b) => a.ordinal - b.ordinal);
    // A targeted request produces one question per attempt. Split large gaps
    // so its six-attempt limit cannot itself make the requested quota impossible.
    return Array.from({ length: Math.ceil(sorted.length / MAX_TARGETED_ATTEMPTS) }, (_, index) => ({
      unit: group.unit, slots: sorted.slice(index * MAX_TARGETED_ATTEMPTS, (index + 1) * MAX_TARGETED_ATTEMPTS),
    }));
  });
  const missingQuestions = groups.reduce((sum, group) => sum + group.slots.length, 0);
  if (!missingQuestions) throw new Error("已满足计划最低题量，无需补题。");
  return { groups, target: slots.length, preservedQuestions: slots.length - missingQuestions, missingQuestions };
}

// Call only inside the shared capacity/plan transaction. Old requests stay
// stopped; new request IDs take ownership of empty slots without copying them.
export async function queueSupplementRound(db: PoolConnection, planId: string, actorId: string, model: Snapshot["model"]) {
  await db.execute("SELECT id FROM authoring_generation_capacity WHERE id=1 FOR UPDATE");
  const [plans] = await db.execute<(RowDataPacket & { project_id: string; status: string })[]>(
    "SELECT project_id,status FROM authoring_plans WHERE id=? FOR UPDATE", [planId],
  );
  const plan = plans[0];
  if (!plan || plan.status !== "confirmed") throw new Error("计划不存在或未确认，不能补题。");
  const [jobs] = await db.execute<(RowDataPacket & { id: string; status: string; target_count: number; snapshot_json: Snapshot | string; stop_summary_json: unknown })[]>(
    "SELECT id,status,target_count,snapshot_json,stop_summary_json FROM authoring_generation_jobs WHERE plan_id=? FOR UPDATE", [planId],
  );
  const job = jobs[0];
  if (!job || job.status !== "stopped" || !job.stop_summary_json) throw new Error("仅停止生成并保留成果后的计划可以补题。");
  const snapshot = typeof job.snapshot_json === "string" ? JSON.parse(job.snapshot_json) as Snapshot : job.snapshot_json;
  if (snapshot.projectId !== plan.project_id || Number(job.target_count) !== snapshot.points.reduce((sum, point) => sum + quotaTotal(point), 0)) {
    throw new Error("冻结计划与任务题量不一致，不能补题。");
  }
  if (model.provider !== snapshot.model.provider || model.baseUrl !== snapshot.model.baseUrl) {
    throw new Error("模型连接已变更，请恢复原连接后再补题。");
  }
  await assertFrozenPlanBasis(db, plan.project_id, snapshot.scope);
  await assertOutlineConfirmed(db, snapshot.scope.blueprintVersions.outline.id);
  const [units] = await db.execute<(RowDataPacket & SupplementUnit)[]>(
    "SELECT id,batch_id,ordinal,point_code,status,attempts,retry_state_json FROM authoring_generation_units WHERE job_id=? FOR UPDATE", [job.id],
  );
  if (units.some((unit) => ["queued", "running", "failed"].includes(unit.status))) {
    throw new Error("停止任务仍有未关闭请求，不能重复发起补题。");
  }
  const [slots] = await db.execute<(RowDataPacket & SupplementSlot)[]>(
    "SELECT id,unit_id,ordinal,question_type,question_id FROM authoring_generation_slots WHERE job_id=? FOR UPDATE", [job.id],
  );
  const manifest = supplementManifest(snapshot, units, slots);
  const roundId = createUlid();
  const summary: SupplementSummary = { roundId, target: manifest.target, preservedQuestions: manifest.preservedQuestions,
    missingQuestions: manifest.missingQuestions, requests: manifest.groups.length };
  const nextOrdinals = new Map<string, number>();
  for (const unit of units) nextOrdinals.set(unit.batch_id, Math.max(nextOrdinals.get(unit.batch_id) ?? 0, Number(unit.ordinal)));
  const replacements = [];
  for (const group of manifest.groups) {
    const unitId = createUlid();
    const ordinal = (nextOrdinals.get(group.unit.batch_id) ?? 0) + 1;
    nextOrdinals.set(group.unit.batch_id, ordinal);
    const state: RetryState = {
      ...retryState(null), targeted: true,
      supplement: { roundId, previousUnitId: group.unit.id, previousAttempts: Number(group.unit.attempts), actorId },
    };
    const type = new Set(group.slots.map((slot) => slot.question_type)).size === 1 ? group.slots[0].question_type : "mixed";
    await db.execute(`INSERT INTO authoring_generation_units(id,job_id,batch_id,ordinal,point_code,question_type,retry_state_json,next_attempt_at)
      VALUES(?,?,?,?,?,?,?,UTC_TIMESTAMP(3))`, [unitId, job.id, group.unit.batch_id, ordinal, group.unit.point_code, type, JSON.stringify(state)]);
    const slotIds = group.slots.map((slot) => slot.id);
    await db.execute(`UPDATE authoring_generation_slots SET unit_id=?
      WHERE job_id=? AND unit_id=? AND question_id IS NULL AND id IN (${slotIds.map(() => "?").join(",")})`,
    [unitId, job.id, group.unit.id, ...slotIds]);
    replacements.push({ previousUnit: group.unit, newUnitId: unitId, slots: group.slots });
  }
  await db.execute("UPDATE authoring_generation_jobs SET status='queued' WHERE id=? AND status='stopped'", [job.id]);
  await db.execute("UPDATE authoring_plans SET updated_at=UTC_TIMESTAMP(3) WHERE id=?", [planId]);
  await db.execute(`INSERT INTO audit_logs(id,project_id,actor_id,action,object_type,object_id,before_json,after_json,result)
    VALUES(?,?,?,'authoring.plan.supplement_started','authoring_plan',?,?,?,'success')`,
  [createUlid(), plan.project_id, actorId, planId, JSON.stringify({ jobId: job.id, stopSummary: job.stop_summary_json }),
    JSON.stringify({ jobId: job.id, ...summary, replacements })]);
  return { jobId: job.id, summary };
}
