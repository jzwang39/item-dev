import type { RowDataPacket } from "mysql2/promise";
import { NextResponse } from "next/server";

import { getVerifiedSession } from "@/auth";
import { query } from "@/shared/database/mysql";

const levels = ["level_5", "level_4", "level_3", "level_2", "level_1"] as const;
const levelLabels: Record<typeof levels[number], string> = {
  level_5: "五级 / 初级工", level_4: "四级 / 中级工", level_3: "三级 / 高级工", level_2: "二级 / 技师", level_1: "一级 / 高级技师"
};

export async function GET(request: Request) {
  const session = await getVerifiedSession();
  if (!session?.user?.id) return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "登录已失效。" } }, { status: 401 });
  if (session.user.role !== "admin") return NextResponse.json({ error: { code: "FORBIDDEN", message: "无权查看全平台统计。" } }, { status: 403 });

  const params = new URL(request.url).searchParams;
  const occupationId = params.get("occupationId") ?? "";
  const levelCode = params.get("levelCode") ?? "";
  const assessmentMode = params.get("assessmentMode") ?? "";
  const status = params.get("status") ?? "";
  const conditions = ["q.archived_at IS NULL", "p.status = 'active'"];
  const values: string[] = [];
  if (occupationId) { conditions.push("q.occupation_id = ?"); values.push(occupationId); }
  if (levels.includes(levelCode as typeof levels[number])) { conditions.push("q.level_code = ?"); values.push(levelCode); }
  if (["theory", "skill"].includes(assessmentMode)) { conditions.push("q.assessment_mode = ?"); values.push(assessmentMode); }
  if (["draft", "pending_review", "returned", "approved"].includes(status)) { conditions.push("q.current_status = ?"); values.push(status); }
  const where = conditions.join(" AND ");
  const fromQuestions = `FROM questions q INNER JOIN projects p ON p.id = q.project_id WHERE ${where}`;

  try {
    const [occupations, summary, byMode, byType, byLevel] = await Promise.all([
      query<(RowDataPacket & { id: string; name: string })[]>(
        "SELECT po.id, po.name FROM project_occupations po INNER JOIN projects p ON p.id = po.project_id WHERE po.status = 'active' AND p.status = 'active' ORDER BY po.name"
      ),
      query<(RowDataPacket & { total: number; theory: number; skill: number; approved: number; types: number })[]>(
        `SELECT COUNT(*) AS total, COALESCE(SUM(q.assessment_mode = 'theory'), 0) AS theory, COALESCE(SUM(q.assessment_mode = 'skill'), 0) AS skill, COALESCE(SUM(q.current_status = 'approved'), 0) AS approved, COUNT(DISTINCT q.question_type) AS types ${fromQuestions}`, values
      ),
      query<(RowDataPacket & { assessment_mode: "theory" | "skill"; total: number })[]>(
        `SELECT q.assessment_mode, COUNT(*) AS total ${fromQuestions} GROUP BY q.assessment_mode`, values
      ),
      query<(RowDataPacket & { question_type: string; total: number })[]>(
        `SELECT q.question_type, COUNT(*) AS total ${fromQuestions} GROUP BY q.question_type`, values
      ),
      query<(RowDataPacket & { level_code: typeof levels[number]; total: number })[]>(
        `SELECT q.level_code, COUNT(*) AS total ${fromQuestions} GROUP BY q.level_code`, values
      )
    ]);
    const base = summary[0] ?? { total: 0, theory: 0, skill: 0, approved: 0, types: 0 };
    return NextResponse.json({ data: {
      occupations,
      summary: Object.fromEntries(Object.entries(base).map(([key, value]) => [key, Number(value)])),
      byMode: byMode.map((row) => ({ mode: row.assessment_mode, total: Number(row.total) })),
      byType: byType.map((row) => ({ type: row.question_type, total: Number(row.total) })),
      byLevel: levels.map((code) => ({ code, label: levelLabels[code], total: Number(byLevel.find((row) => row.level_code === code)?.total ?? 0) }))
    } });
  } catch (error) {
    return NextResponse.json({ error: { code: "DASHBOARD_FAILED", message: error instanceof Error ? error.message : "工作台统计加载失败。" } }, { status: 500 });
  }
}
