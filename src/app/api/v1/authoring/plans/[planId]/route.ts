import { NextResponse } from "next/server";
import type { RowDataPacket } from "mysql2/promise";
import { z } from "zod";

import { getVerifiedSession } from "@/auth";
import { getGenerationState } from "@/modules/authoring/generation/service";
import { getPlanQuestionRows, resultQualityRelaxations } from "@/modules/authoring/generation/results";
import { quotaPointSchema, quotaTotal, validateQuota, type Scope } from "@/modules/authoring/generation/contracts";
import { isLegalPoint } from "@/modules/authoring/legal-topics";
import { createUlid } from "@/shared/database/ulid";
import { withTransaction } from "@/shared/database/mysql";

const schema = z.object({
  points: z.array(quotaPointSchema).min(1)
});

export async function GET(_: Request, { params }: Readonly<{ params: { planId: string } }>) {
  const session = await getVerifiedSession();
  if (!session?.user?.id) return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "登录已失效。" } }, { status: 401 });
  if (session.user.role !== "admin") return NextResponse.json({ error: { code: "FORBIDDEN", message: "仅管理员可查看命题成果。" } }, { status: 403 });

  try {
    const rows = await getPlanQuestionRows(params.planId);
    const questions = rows.map((row) => {
      const content = typeof row.content_json === "string" ? JSON.parse(row.content_json) as { options?: Array<{ key: string; content: string }> } : row.content_json;
      const answer = typeof row.answer_json === "string" ? JSON.parse(row.answer_json) as { answers?: string[] } : row.answer_json;
      const qualityRelaxations = resultQualityRelaxations(row.quality_relaxations_json);
      return {
        id: row.id,
        questionNo: row.question_no,
        point: row.point_name ?? "未关联考评点",
        questionType: row.question_type,
        stem: row.stem,
        options: content.options ?? [],
        answers: answer.answers ?? [],
        analysis: row.analysis_text ?? "",
        scoreRubric: typeof row.score_rubric_json === "string" ? JSON.parse(row.score_rubric_json) : row.score_rubric_json,
        autoCheck: qualityRelaxations.length ? "需人工复核" as const : "通过基础检查" as const,
        qualityRelaxations,
        status: row.current_status
      };
    });
    return NextResponse.json({ data: { questions, ...await getGenerationState(params.planId) } });
  } catch (error) {
    return NextResponse.json({ error: { code: "PLAN_RESULTS_LOAD_FAILED", message: error instanceof Error ? error.message : "命题成果加载失败。" } }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: Readonly<{ params: { planId: string } }>) {
  const session = await getVerifiedSession();
  if (!session?.user?.id) return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "登录已失效。" } }, { status: 401 });
  if (session.user.role !== "admin") return NextResponse.json({ error: { code: "FORBIDDEN", message: "仅管理员可修改命题计划。" } }, { status: 403 });

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "题量配额数据无效。" } }, { status: 400 });

  try {
    const result = await withTransaction(async (connection) => {
      const [rows] = await connection.execute<(RowDataPacket & { project_id: string; quota_json: string | Record<string, unknown>; scope_json: string | Scope; status: string })[]>(
        "SELECT project_id, quota_json, scope_json, status FROM authoring_plans WHERE id = ? FOR UPDATE",
        [params.planId]
      );
      const plan = rows[0];
      if (!plan || plan.status !== "confirmed") throw new Error("仅可修改已确认且尚未归档的命题计划。");
      const [jobs] = await connection.execute<RowDataPacket[]>("SELECT id FROM authoring_generation_jobs WHERE plan_id=? LIMIT 1", [params.planId]);
      if (jobs.length) throw new Error("计划已开始执行，题量与版本已锁定；调整需求请新建计划。");
      const scope = typeof plan.scope_json === "string" ? JSON.parse(plan.scope_json) as Scope : plan.scope_json;
      validateQuota(parsed.data.points, scope.levelCode, scope.assessmentMode);
      const [allNodes] = await connection.execute<(RowDataPacket & { node_code: string; name: string; requirement_json: unknown; source_ref_json: unknown })[]>(
        "SELECT node_code,name,requirement_json,source_ref_json FROM blueprint_nodes WHERE blueprint_version_id=? AND node_kind='assessment_point'", [scope.blueprintVersions.outline.id]);
      const nodes = allNodes.filter((node) => !isLegalPoint(node));
      if (nodes.length !== parsed.data.points.length || parsed.data.points.some((point) => !nodes.some((node) => node.node_code === point.code))) {
        throw new Error("计划考评点与冻结细目表不一致。");
      }
      const quota = typeof plan.quota_json === "string" ? JSON.parse(plan.quota_json) as Record<string, unknown> : plan.quota_json;
      const points = parsed.data.points.map((point) => ({
        ...point,
        name: nodes.find((node) => node.node_code === point.code)!.name,
        total: quotaTotal(point)
      }));
      const minimumTotal = points.reduce((sum, point) => sum + point.total, 0);
      await connection.execute(
        "UPDATE authoring_plans SET quota_json = ?, row_version = row_version + 1 WHERE id = ?",
        [JSON.stringify({ ...quota, points, minimumTotal }), params.planId]
      );
      await connection.execute(
        `INSERT INTO audit_logs (id, project_id, actor_id, action, object_type, object_id, after_json, result)
         VALUES (?, ?, ?, 'authoring.plan.quota_updated', 'authoring_plan', ?, ?, 'success')`,
        [createUlid(), plan.project_id, session.user.id, params.planId, JSON.stringify({ minimumTotal, points })]
      );
      return { minimumTotal, points };
    });
    return NextResponse.json({ data: result });
  } catch (error) {
    return NextResponse.json({ error: { code: "PLAN_QUOTA_UPDATE_FAILED", message: error instanceof Error ? error.message : "命题计划题量保存失败。" } }, { status: 422 });
  }
}
