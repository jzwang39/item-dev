import { NextResponse } from "next/server";
import type { RowDataPacket } from "mysql2/promise";
import { z } from "zod";

import { getVerifiedSession } from "@/auth";
import { createUlid } from "@/shared/database/ulid";
import { query, withTransaction } from "@/shared/database/mysql";

const schema = z.object({
  points: z.array(z.object({
    code: z.string().min(1).max(200),
    name: z.string().min(1),
    single: z.number().int().min(0).max(100),
    multiple: z.number().int().min(0).max(100),
    judgement: z.number().int().min(0).max(100),
    total: z.number().int().min(0).max(300)
  })).min(1)
});

export async function GET(_: Request, { params }: Readonly<{ params: { planId: string } }>) {
  const session = await getVerifiedSession();
  if (!session?.user?.id) return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "登录已失效。" } }, { status: 401 });
  if (session.user.role !== "admin") return NextResponse.json({ error: { code: "FORBIDDEN", message: "仅管理员可查看命题成果。" } }, { status: 403 });

  try {
    type QuestionRow = RowDataPacket & {
      id: string;
      question_no: string;
      question_type: string;
      stem: string;
      content_json: string | { options?: Array<{ key: string; content: string }> };
      answer_json: string | { answers?: string[] };
      analysis_text: string | null;
      point_name: string | null;
      current_status: string;
    };
    const rows = await query<QuestionRow[]>(
      `SELECT q.id, q.question_no, q.question_type, q.current_status, qv.stem, qv.content_json, qv.answer_json, qv.analysis_text,
              MIN(bn.name) AS point_name
         FROM questions q
         INNER JOIN question_versions qv ON qv.question_id = q.id
         LEFT JOIN question_assessment_points qap ON qap.question_version_id = qv.id
         LEFT JOIN blueprint_nodes bn ON bn.id = qap.blueprint_node_id
        WHERE q.project_id = (SELECT project_id FROM authoring_plans WHERE id = ?)
          AND JSON_UNQUOTE(JSON_EXTRACT(qv.source_snapshot_json, '$.planId')) = ?
        GROUP BY qv.id
        ORDER BY q.question_no`,
      [params.planId, params.planId]
    );
    const questions = rows.map((row) => {
      const content = typeof row.content_json === "string" ? JSON.parse(row.content_json) as { options?: Array<{ key: string; content: string }> } : row.content_json;
      const answer = typeof row.answer_json === "string" ? JSON.parse(row.answer_json) as { answers?: string[] } : row.answer_json;
      return {
        id: row.id,
        questionNo: row.question_no,
        point: row.point_name ?? "未关联考评点",
        questionType: row.question_type,
        stem: row.stem,
        options: content.options ?? [],
        answers: answer.answers ?? [],
        analysis: row.analysis_text ?? "",
        autoCheck: "通过基础检查" as const,
        status: row.current_status
      };
    });
    return NextResponse.json({ data: { questions } });
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
      const [rows] = await connection.execute<(RowDataPacket & { project_id: string; quota_json: string | Record<string, unknown>; status: string })[]>(
        "SELECT project_id, quota_json, status FROM authoring_plans WHERE id = ? FOR UPDATE",
        [params.planId]
      );
      const plan = rows[0];
      if (!plan || plan.status !== "confirmed") throw new Error("仅可修改已确认且尚未归档的命题计划。");
      const quota = typeof plan.quota_json === "string" ? JSON.parse(plan.quota_json) as Record<string, unknown> : plan.quota_json;
      const points = parsed.data.points.map((point) => ({
        ...point,
        total: point.single + point.multiple + point.judgement
      }));
      const minimumTotal = points.reduce((sum, point) => sum + point.total, 0);
      await connection.execute(
        "UPDATE authoring_plans SET quota_json = ?, row_version = row_version + 1 WHERE id = ?",
        [JSON.stringify({ ...quota, points, minimumTotal }), params.planId]
      );
      await connection.execute(
        `INSERT INTO audit_logs (id, project_id, actor_id, action, object_type, object_id, after_json, result)
         VALUES (?, ?, ?, 'authoring.plan.quota_updated', 'authoring_plan', ?, ?, 'success')`,
        [createUlid(), plan.project_id, session.user.id, params.planId, JSON.stringify({ minimumTotal, points }), "success"]
      );
      return { minimumTotal, points };
    });
    return NextResponse.json({ data: result });
  } catch (error) {
    return NextResponse.json({ error: { code: "PLAN_QUOTA_UPDATE_FAILED", message: error instanceof Error ? error.message : "命题计划题量保存失败。" } }, { status: 422 });
  }
}
