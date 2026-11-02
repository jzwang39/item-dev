import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { basicIdentity, commonQuestionType, decodeCommon, type CommonNode, type CommonQuota } from "./common-question-policy";
import type { CommonBasis } from "./common-questions";
import type { Scope } from "./generation/contracts";
import { stemHash } from "./generation/contracts";

export async function assertCommonGeneration(db: PoolConnection, planId: string, scope: Scope, nodes: CommonNode[]) {
  if (scope.assessmentMode !== "理论知识") return;
  if (scope.commonGroupId) {
    const [groups] = await db.execute<(RowDataPacket & { generation_plan_id: string; basis_json: unknown })[]>(
      "SELECT generation_plan_id,basis_json FROM common_question_groups WHERE id=? AND occupation_id=? FOR UPDATE",
      [scope.commonGroupId, scope.occupationId]);
    if (!groups[0] || groups[0].generation_plan_id !== planId) throw new Error("公共题组配置已更新，请从公共题组重新启动。");
    const basis = decodeCommon<CommonBasis>(groups[0].basis_json);
    const [plans] = await db.execute<(RowDataPacket & { quota_json: unknown })[]>("SELECT quota_json FROM authoring_plans WHERE id=?", [planId]);
    const quota = decodeCommon<{ points?: Array<{ multiple: number }> }>(plans[0]?.quota_json);
    if (quota.points?.some((point) => point.multiple > 0)) throw new Error("公共题组改为单选、判断题，请先终止旧多选任务，再从公共题组生成新任务。");
    if (nodes.some((node) => {
      const identity = basicIdentity(node);
      return !identity || !basis.points.some((point) => point.key === identity.key && point.signature === identity.signature);
    })) throw new Error("公共生成只能使用冻结的基本要求考评点。");
  } else if (nodes.some((node) => basicIdentity(node))) {
    throw new Error("基本要求已改为公共题组统一生成。此旧计划不能再次独立生成基本要求，请保留旧成果并创建新版计划。");
  }
}

export async function prefillCommonSlots(db: PoolConnection, groupId: string, jobId: string) {
  const [rows] = await db.execute<(RowDataPacket & { question_id: string; point_key: string; question_type: string; stem: string; node_code: string })[]>(`
    SELECT m.question_id,m.point_key,q.question_type,v.stem,n.node_code FROM common_question_members m
    JOIN questions q ON q.id=m.question_id AND q.archived_at IS NULL
    JOIN question_versions v ON v.id=q.current_version_id
    JOIN common_question_points p ON p.group_id=m.group_id AND p.point_key=m.point_key AND p.level_code='level_5'
    JOIN blueprint_nodes n ON n.id=p.blueprint_node_id WHERE m.group_id=? AND m.suspended=0 ORDER BY q.id`, [groupId]);
  for (const row of rows) {
    const type = commonQuestionType(row.question_type);
    const [slots] = await db.execute<(RowDataPacket & { id: string })[]>(`SELECT s.id FROM authoring_generation_slots s
      JOIN authoring_generation_units u ON u.id=s.unit_id WHERE s.job_id=? AND u.point_code=? AND s.question_type=?
      AND s.question_id IS NULL ORDER BY s.ordinal LIMIT 1 FOR UPDATE`, [jobId, row.node_code, type]);
    if (!slots[0]) throw new Error("公共题组现有题型数量超过配置，请刷新并核对配额。");
    await db.execute("UPDATE authoring_generation_slots SET question_id=?,stem_hash=? WHERE id=?", [row.question_id, stemHash(row.stem), slots[0].id]);
  }
  await db.execute(`UPDATE authoring_generation_units u SET status='succeeded' WHERE u.job_id=?
    AND NOT EXISTS(SELECT 1 FROM authoring_generation_slots s WHERE s.unit_id=u.id AND s.question_id IS NULL)`, [jobId]);
}

export async function registerCommonGenerated(db: PoolConnection, scope: Scope, questionId: string, node: { theoryContext?: unknown }, planId: string) {
  if (!scope.commonGroupId) return;
  const context = node.theoryContext as { point: unknown; source: unknown };
  const identity = basicIdentity({ name: "", requirement_json: context.point, source_ref_json: context.source });
  if (!identity) throw new Error("公共题缺少基本要求对应关系。");
  await db.execute("INSERT INTO common_question_members(question_id,group_id,point_key,origin_json) VALUES(?,?,?,?)",
    [questionId, scope.commonGroupId, identity.key, JSON.stringify({ kind: "generated", planId })]);
  await db.execute("UPDATE common_question_groups SET row_version=row_version+1 WHERE id=?", [scope.commonGroupId]);
}

export async function assertCommonPlanQuotaUnchanged(db: PoolConnection, planId: string, points: Array<{ code: string; single: number; multiple: number; judgement: number }>) {
  const [links] = await db.execute<(RowDataPacket & { snapshot_json: unknown })[]>("SELECT snapshot_json FROM common_question_plan_links WHERE plan_id=?", [planId]);
  if (!links[0]) return;
  const snapshot = decodeCommon<{ shared: Array<{ code: string; single: number; multiple: number; judgement: number }>; quota: CommonQuota }>(links[0].snapshot_json);
  if (snapshot.shared.some((item) => {
    const point = points.find((row) => row.code === item.code);
    return !point || point.single !== item.single || point.multiple !== item.multiple || point.judgement !== item.judgement;
  })) throw new Error("基本要求配额由公共题组统一配置，不可在等级计划内单独修改。");
}
