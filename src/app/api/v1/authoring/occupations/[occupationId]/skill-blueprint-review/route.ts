import { NextResponse } from "next/server";
import { z } from "zod";
import type { RowDataPacket } from "mysql2/promise";

import { getVerifiedSession } from "@/auth";
import { withTransaction } from "@/shared/database/mysql";
import { createUlid } from "@/shared/database/ulid";
import { assertOutlineConfirmed } from "@/modules/blueprints/point-review";

const schema = z.object({ levelCode: z.enum(["level_5", "level_4", "level_3", "level_2", "level_1"]), opinion: z.string().max(5000) });

class SkillBlueprintReviewError extends Error {}

export async function GET(request: Request, { params }: Readonly<{ params: { occupationId: string } }>) {
  const session = await getVerifiedSession();
  if (!session?.user?.id) return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "登录已失效。" } }, { status: 401 });
  const levelCode = new URL(request.url).searchParams.get("levelCode") ?? "";
  try {
    const data = await withTransaction(async (connection) => {
      const [confirmed] = await connection.execute<(RowDataPacket & { total: number; confirmed: number; approved_at: Date | string | null; reviewer: string | null })[]>(
        `SELECT COUNT(*) AS total,COALESCE(SUM(r.status='confirmed'),0) AS confirmed,
          MAX(r.confirmed_at) AS approved_at,MAX(a.display_name) AS reviewer
         FROM blueprints b JOIN blueprint_nodes n ON n.blueprint_version_id=b.current_version_id AND n.node_kind='assessment_point'
         LEFT JOIN outline_point_reviews r ON r.node_id=n.id LEFT JOIN accounts a ON a.id=r.confirmed_by
         WHERE b.occupation_id=? AND b.level_code=? AND b.blueprint_kind='skill_outline' AND b.assessment_mode='skill'`,
        [params.occupationId, levelCode],
      );
      const state = confirmed[0];
      if (Number(state.total) > 0 && Number(state.total) === Number(state.confirmed) && state.approved_at) {
        return { opinion: "全部考评点已审核并经管理员确认。", approvedAt: new Date(state.approved_at).toISOString(), reviewer: state.reviewer ?? "管理员" };
      }
      // Historical audit-only approval no longer grants permission.
      return null;
    });
    return NextResponse.json({ data });
  } catch {
    return NextResponse.json({ error: { code: "SKILL_BLUEPRINT_REVIEW_READ_FAILED", message: "蓝图审核记录读取失败。" } }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: Readonly<{ params: { occupationId: string } }>) {
  const session = await getVerifiedSession();
  if (!session?.user?.id) return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "登录已失效。" } }, { status: 401 });
  if (session.user.role !== "admin") return NextResponse.json({ error: { code: "FORBIDDEN", message: "仅管理员可登记蓝图审核。" } }, { status: 403 });
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "审核意见格式不正确。" } }, { status: 400 });
  const data = parsed.data;
  const id = createUlid();
  try {
    const result = await withTransaction(async (connection) => {
      const [projects] = await connection.execute<(RowDataPacket & { id: string })[]>(`SELECT p.id FROM projects p INNER JOIN project_occupations po ON po.project_id = p.id WHERE po.id = ? AND po.status = 'active' AND p.status = 'active' LIMIT 1`, [params.occupationId]);
      if (!projects[0]) throw new SkillBlueprintReviewError("职业不存在或已归档。");
      const [outlines] = await connection.execute<(RowDataPacket & { current_version_id: string | null })[]>(`SELECT current_version_id FROM blueprints WHERE project_id = ? AND occupation_id = ? AND level_code = ? AND blueprint_kind = 'skill_outline' AND assessment_mode = 'skill' LIMIT 1`, [projects[0].id, params.occupationId, data.levelCode]);
      const blueprintVersionId = outlines[0]?.current_version_id;
      if (!blueprintVersionId) throw new SkillBlueprintReviewError("当前等级尚未保存操作技能考评点，不能登记蓝图通过。");
      await assertOutlineConfirmed(connection, blueprintVersionId);
      await connection.execute(
        `INSERT INTO audit_logs (id, project_id, actor_id, action, object_type, object_id, after_json, result)
         VALUES (?, ?, ?, 'blueprint.skill_outline.approve', 'blueprint_version', ?, ?, 'success')`,
        [id, projects[0].id, session.user.id, blueprintVersionId, JSON.stringify({ levelCode: data.levelCode, opinion: data.opinion, decision: "approved", objectVersion: "approved" })]
      );
      return { auditId: id, blueprintVersionId };
    });
    return NextResponse.json({ data: result }, { status: 201 });
  } catch (error) {
    if (error instanceof SkillBlueprintReviewError) {
      return NextResponse.json({ error: { code: "SKILL_BLUEPRINT_REVIEW_FAILED", message: error.message } }, { status: 422 });
    }
    return NextResponse.json({ error: { code: "SKILL_BLUEPRINT_REVIEW_ERROR", message: "蓝图审核意见保存失败，请稍后重试。" } }, { status: 500 });
  }
}
