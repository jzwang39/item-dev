import { NextResponse } from "next/server";
import { z } from "zod";
import type { RowDataPacket } from "mysql2/promise";

import { getVerifiedSession } from "@/auth";
import { assertOutlineConfirmed } from "@/modules/blueprints/point-review";
import { quotaPointSchema, quotaTotal, validateQuota } from "@/modules/authoring/generation/contracts";
import { loadSkillPlanBasis } from "@/modules/authoring/skill-plan";
import { isLegalPoint } from "@/modules/authoring/legal-topics";
import { getActiveProjectIdForUpdate } from "@/modules/authoring/occupations/service";
import { assertPlanVersions, readCurrentTheoryVersion } from "@/modules/blueprints/current-theory-version";
import { createUlid } from "@/shared/database/ulid";
import { withTransaction } from "@/shared/database/mysql";

const schema = z.object({
  requirement: z.string().trim().min(1).max(12000),
  occupation: z.string().trim().min(1),
  levelCode: z.enum(["level_5", "level_4", "level_3", "level_2", "level_1"]),
  assessmentMode: z.enum(["理论知识", "操作技能"]),
  minimumTotal: z.number().int().nonnegative(),
  blueprintVersions: z.object({
    outline: z.object({ id: z.string().length(26), versionNo: z.number().int().positive() }),
    weights: z.object({ id: z.string().length(26), versionNo: z.number().int().positive() }),
    structure: z.object({ id: z.string().length(26), versionNo: z.number().int().positive() }).optional()
  }),
  temporaryMinimums: z.object({
    single: z.number().int().nonnegative(),
    multiple: z.number().int().nonnegative(),
    judgement: z.number().int().nonnegative(),
    practical: z.number().int().min(0).max(100).optional()
  }),
  qualityRequirements: z.array(z.string().min(1).max(200)).max(10),
  validations: z.array(z.object({
    name: z.string().min(1).max(100),
    status: z.enum(["passed", "blocked"]),
    detail: z.string().min(1).max(500)
  })).min(1),
  points: z.array(quotaPointSchema).min(1)
});

export async function POST(request: Request) {
  const session = await getVerifiedSession();
  if (!session?.user?.id) return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "登录已失效。" } }, { status: 401 });
  if (session.user.role !== "admin") return NextResponse.json({ error: { code: "FORBIDDEN", message: "仅管理员可启动命题任务。" } }, { status: 403 });

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "命题计划数据不完整，无法确认。" } }, { status: 400 });

  try {
    const data = parsed.data;
    if (data.validations.some((item) => item.status !== "passed")) {
      throw new Error("仅能确认通过校验的命题计划。");
    }
    validateQuota(data.points, data.levelCode, data.assessmentMode);
    const result = await withTransaction(async (connection) => {
      const projectId = await getActiveProjectIdForUpdate(connection);
      if (!projectId) throw new Error("当前没有启用的业务项目，无法启动命题任务。");
      const [occupations] = await connection.execute<(RowDataPacket & { id: string; name: string })[]>(
        "SELECT id, name FROM project_occupations WHERE project_id = ? AND name = ? AND status = 'active' LIMIT 1 FOR UPDATE",
        [projectId, data.occupation]
      );
      if (!occupations[0]) throw new Error("计划中的职业不存在或已归档，请重新生成计划。");
      const skillBasis = data.assessmentMode === "操作技能"
        ? await loadSkillPlanBasis(connection, occupations[0].id, data.levelCode) : null;
      const selection = { projectId, occupationId: occupations[0].id };
      const current = skillBasis?.versions ?? {
        outline: await readCurrentTheoryVersion(connection, {
          ...selection, kind: "theory_outline", levelCode: data.levelCode,
        }),
        weights: await readCurrentTheoryVersion(connection, { ...selection, kind: "theory_weight" }),
      };
      assertPlanVersions(current, data.blueprintVersions);
      const outlineVersionId = current.outline!.id;
      const weightVersionId = current.weights!.id;
      if (skillBasis && skillBasis.versions.structure.id !== data.blueprintVersions.structure?.id) {
        throw new Error("操作技能内容结构表已更新，请重新生成计划。");
      }
      await assertOutlineConfirmed(connection, outlineVersionId);
      const [allNodes] = await connection.execute<(RowDataPacket & { node_code: string; name: string; requirement_json: unknown; source_ref_json: unknown })[]>(
        "SELECT node_code,name,requirement_json,source_ref_json FROM blueprint_nodes WHERE blueprint_version_id=? AND node_kind='assessment_point'", [outlineVersionId]
      );
      const nodes = allNodes.filter((node) => !isLegalPoint(node));
      if (nodes.length !== data.points.length || data.points.some((point) => !nodes.some((node) => node.node_code === point.code))) {
        throw new Error("计划考评点与当前细目表不一致，请重新生成计划。");
      }
      const points = data.points.map((point) => ({
        ...point, name: nodes.find((node) => node.node_code === point.code)!.name,
        total: quotaTotal(point)
      }));

      const planId = createUlid();
      const scope = {
        occupationId: occupations[0].id,
        occupation: occupations[0].name,
        levelCode: data.levelCode,
        assessmentMode: data.assessmentMode,
        blueprintVersions: skillBasis?.versions ?? {
          outline: { id: outlineVersionId, versionNo: Number("version_no" in current.outline! ? current.outline.version_no : current.outline!.versionNo) },
          weights: { id: weightVersionId, versionNo: Number("version_no" in current.weights! ? current.weights.version_no : current.weights!.versionNo) },
        },
      };
      const quota = {
        minimumTotal: points.reduce((sum, point) => sum + point.total, 0),
        points,
        temporaryMinimums: data.temporaryMinimums,
        qualityRequirements: data.qualityRequirements,
        validations: data.validations
      };

      await connection.execute(
        `INSERT INTO authoring_plans (
          id, project_id, name, raw_requirement, scope_json, quota_json, status, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, 'confirmed', ?)`,
        [
          planId,
          projectId,
          data.requirement.slice(0, 300),
          data.requirement,
          JSON.stringify(scope),
          JSON.stringify(quota),
          session.user.id
        ]
      );
      for (const id of [outlineVersionId, weightVersionId, ...(skillBasis ? [skillBasis.versions.structure.id] : [])]) {
        await connection.execute("INSERT INTO authoring_plan_blueprints (plan_id, blueprint_version_id) VALUES (?, ?)", [planId, id]);
      }
      await connection.execute(
        `INSERT INTO audit_logs (
          id, project_id, actor_id, action, object_type, object_id, after_json, result
        ) VALUES (?, ?, ?, 'authoring.plan.confirm', 'authoring_plan', ?, ?, 'success')`,
        [
          createUlid(),
          projectId,
          session.user.id,
          planId,
          JSON.stringify({ scope, quota, reviewState: "awaiting_expert", planSnapshot: "frozen" })
        ]
      );
      return { planId, reviewState: "awaiting_expert" };
    });
    return NextResponse.json({ data: result }, { status: 201 });
  } catch (error) {
    return NextResponse.json({
      error: { code: "PLAN_CONFIRMATION_FAILED", message: error instanceof Error ? error.message : "命题计划确认失败。" }
    }, { status: 422 });
  }
}
