import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import type { Scope } from "./contracts";

// Use the plan's immutable versions, not the latest versions from the workspace.
export async function assertFrozenPlanBasis(db: PoolConnection, projectId: string, scope: Scope) {
  const [occupations] = await db.execute<RowDataPacket[]>(
    `SELECT po.id FROM project_occupations po JOIN projects p ON p.id=po.project_id
     WHERE po.id=? AND po.project_id=? AND po.status='active' AND p.status='active'
     AND p.code<>'SYSTEM-GENERIC-LEGAL' FOR UPDATE`, [scope.occupationId, projectId],
  );
  if (occupations.length !== 1) throw new Error("计划关联的业务项目或职业已停用，不能启动命题。");
  const mode = scope.assessmentMode === "操作技能" ? "skill" : "theory";
  for (const [kind, version] of [
    [mode === "skill" ? "skill_outline" : "theory_outline", scope.blueprintVersions.outline],
    ["theory_weight", scope.blueprintVersions.weights],
    ...(mode === "skill" ? [["skill_structure", scope.blueprintVersions.structure] as const] : []),
  ] as const) {
    if (!version) throw new Error("计划缺少冻结蓝图版本，请重新生成计划。");
    const [versions] = await db.execute<(RowDataPacket & { version_no: number })[]>(
      `SELECT v.version_no FROM blueprint_versions v JOIN blueprints b ON b.id=v.blueprint_id
       WHERE v.id=? AND b.project_id=? AND b.occupation_id=? AND b.assessment_mode=?
       AND b.blueprint_kind=? ${kind === "theory_weight" ? "" : "AND b.level_code=?"}
       AND v.status<>'archived' FOR UPDATE`,
      [version.id, projectId, scope.occupationId, mode, kind, ...(kind === "theory_weight" ? [] : [scope.levelCode])],
    );
    if (versions.length !== 1 || Number(versions[0].version_no) !== version.versionNo) {
      throw new Error("计划冻结版本与项目、职业、等级或考核方式不一致，不能启动命题。");
    }
  }
}

export function theoryPointContext(requirement: unknown, source: unknown) {
  const decode = (value: unknown) => typeof value === "string" ? JSON.parse(value) : value;
  return { point: decode(requirement) ?? null, source: decode(source) ?? null };
}
