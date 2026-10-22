import { NextResponse } from "next/server";
import { z } from "zod";
import type { RowDataPacket } from "mysql2/promise";

import { getVerifiedSession } from "@/auth";
import { withTransaction } from "@/shared/database/mysql";
import { createUlid } from "@/shared/database/ulid";

const schema = z.object({ levelCode: z.enum(["level_5", "level_4", "level_3", "level_2", "level_1"]), opinion: z.string().max(5000) });

class SkillBlueprintReviewError extends Error {}

export async function GET(request: Request, { params }: Readonly<{ params: { occupationId: string } }>) {
  const session = await getVerifiedSession();
  if (!session?.user?.id) return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "登录已失效。" } }, { status: 401 });
  const levelCode = new URL(request.url).searchParams.get("levelCode") ?? "";
  try {
    const data = await withTransaction(async (connection) => {
        const [rows] = await connection.execute<(RowDataPacket & { after_json: string | { opinion?: string } | null; created_at: Date | string; display_name: string | null })[]>(
        `SELECT al.after_json, al.created_at, a.display_name
           FROM audit_logs al
           INNER JOIN blueprints b ON b.current_version_id = al.object_id
           LEFT JOIN accounts a ON a.id = al.actor_id
          WHERE b.occupation_id = ? AND b.level_code = ? AND b.blueprint_kind = 'skill_outline'
            AND b.assessment_mode = 'skill' AND al.action = 'blueprint.skill_outline.approve'
          ORDER BY al.created_at DESC LIMIT 1`,
        [params.occupationId, levelCode]
      );
      const row = rows[0];
      if (!row) return null;
        const after = typeof row.after_json === "string"
          ? JSON.parse(row.after_json) as { opinion?: string }
          : row.after_json ?? {};
        const approvedAt = row.created_at instanceof Date
          ? row.created_at.toISOString()
          : new Date(row.created_at).toISOString();
        return { opinion: after.opinion ?? "", approvedAt, reviewer: row.display_name ?? "管理员" };
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
