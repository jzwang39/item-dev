import type { RowDataPacket } from "mysql2/promise";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getVerifiedSession } from "@/auth";
import { createUlid } from "@/shared/database/ulid";
import { query, withTransaction } from "@/shared/database/mysql";

const assignmentSchema = z.object({
  expertId: z.string().length(26),
  questionIds: z.array(z.string().length(26)).min(1).max(300),
});

const levelLabels: Record<string, string> = {
  level_5: "五级 / 初级工",
  level_4: "四级 / 中级工",
  level_3: "三级 / 高级工",
  level_2: "二级 / 技师",
  level_1: "一级 / 高级技师",
};

function decode(value: unknown) {
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return {};
  }
}

function rejectNonAdmin(
  session: Awaited<ReturnType<typeof getVerifiedSession>>,
) {
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: { code: "UNAUTHENTICATED", message: "登录已失效。" } },
      { status: 401 },
    );
  }
  if (session.user.role !== "admin") {
    return NextResponse.json(
      { error: { code: "FORBIDDEN", message: "仅管理员可分配专家审定任务。" } },
      { status: 403 },
    );
  }
  return null;
}

export async function GET() {
  const session = await getVerifiedSession();
  const rejection = rejectNonAdmin(session);
  if (rejection) return rejection;

  try {
    const [experts, questions, summaryRows] = await Promise.all([
      query<
        (RowDataPacket & {
          id: string;
          display_name: string;
          username: string;
          phone: string | null;
          email: string | null;
        })[]
      >(
        `SELECT id, display_name, username, phone, email
           FROM accounts
          WHERE role = 'expert' AND status = 'active'
          ORDER BY display_name, username`,
      ),
      query<
        (RowDataPacket & {
          id: string;
          project_id: string;
          question_no: string;
          occupation_name: string;
          level_code: string;
          assessment_mode: "theory" | "skill";
          question_type: string;
          stem: string;
          assigned_expert_name: string | null;
          assignment_id: string | null;
          assigned_at: string | null;
          content_json: unknown;
          answer_json: unknown;
          analysis_text: string | null;
        })[]
      >(
        `SELECT q.id, q.project_id, q.question_no, po.name AS occupation_name, q.level_code, q.assessment_mode, q.question_type,
                qv.stem, qv.content_json, qv.answer_json, qv.analysis_text, ra.id AS assignment_id, ra.assigned_at,
                assigned.display_name AS assigned_expert_name
           FROM questions q
           INNER JOIN projects p ON p.id = q.project_id AND p.status = 'active'
           INNER JOIN project_occupations po ON po.id = q.occupation_id AND po.status = 'active'
           INNER JOIN question_versions qv ON qv.id = q.current_version_id
           LEFT JOIN review_assignments ra ON ra.question_version_id = qv.id AND ra.status = 'assigned' AND ra.active_token = 'ACTIVE'
           LEFT JOIN accounts assigned ON assigned.id = ra.expert_id
          WHERE q.current_status = 'pending_review' AND q.archived_at IS NULL
          ORDER BY po.name, q.level_code, q.created_at DESC
          LIMIT 300`,
      ),
      query<
        (RowDataPacket & {
          pending: number;
          returned: number;
          approved: number;
          expert_count: number;
        })[]
      >(
        `SELECT COALESCE(SUM(ra.status = 'assigned'), 0) AS pending,
                  COALESCE(SUM(rr.decision = 'returned'), 0) AS returned,
                  COALESCE(SUM(rr.decision = 'approved'), 0) AS approved,
                  COUNT(DISTINCT ra.expert_id) AS expert_count
             FROM review_assignments ra
             INNER JOIN projects p ON p.id = ra.project_id AND p.status = 'active'
             LEFT JOIN review_records rr ON rr.assignment_id = ra.id`,
      ),
    ]);
    const summary = summaryRows[0] ?? {
      pending: 0,
      returned: 0,
      approved: 0,
      expert_count: 0,
    };
    return NextResponse.json({
      data: {
        experts: experts.map((expert) => ({
          id: expert.id,
          name: expert.display_name,
          username: expert.username,
          contact: expert.phone || expert.email || "未填写",
        })),
        questions: questions.map((question) => ({
          id: question.id,
          projectId: question.project_id,
          questionNo: question.question_no,
          occupationName: question.occupation_name,
          levelLabel: levelLabels[question.level_code] ?? question.level_code,
          assessmentMode: question.assessment_mode,
          questionType: question.question_type,
          stem: question.stem,
          assignedExpertName: question.assigned_expert_name,
        })),
        reviewTasks: questions
          .filter((question) => question.assigned_expert_name)
          .map((question) => ({
            id: question.id,
            questionNo: question.question_no,
            occupationName: question.occupation_name,
            levelLabel: levelLabels[question.level_code] ?? question.level_code,
            assessmentMode: question.assessment_mode,
            questionType: question.question_type,
            stem: question.stem,
            expertName: question.assigned_expert_name,
            assignedAt: question.assigned_at,
            assignmentId: question.assignment_id,
            content: decode(question.content_json),
            answer: decode(question.answer_json),
            analysis: question.analysis_text,
          })),
        summary: {
          pending: Number(summary.pending),
          returned: Number(summary.returned),
          approved: Number(summary.approved),
          expertCount: Number(summary.expert_count),
        },
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: {
          code: "REVIEW_ASSIGNMENT_LIST_FAILED",
          message:
            error instanceof Error ? error.message : "待分配任务加载失败。",
        },
      },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const session = await getVerifiedSession();
  const rejection = rejectNonAdmin(session);
  if (rejection) return rejection;
  const parsed = assignmentSchema.safeParse(await request.json());
  if (!parsed.success)
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_FAILED",
          message:
            parsed.error.issues[0]?.message ?? "请选择专家和待分配试题。",
        },
      },
      { status: 400 },
    );

  try {
    const data = await withTransaction(async (connection) => {
      const [experts] = await connection.execute<
        (RowDataPacket & { id: string })[]
      >(
        "SELECT id FROM accounts WHERE id = ? AND role = 'expert' AND status = 'active' FOR UPDATE",
        [parsed.data.expertId],
      );
      if (!experts[0]) throw new Error("所选专家不存在或已停用。");
      const placeholders = parsed.data.questionIds.map(() => "?").join(", ");
      const [questions] = await connection.execute<
        (RowDataPacket & {
          id: string;
          project_id: string;
          current_version_id: string | null;
        })[]
      >(
        `SELECT q.id, q.project_id, q.current_version_id
           FROM questions q
           INNER JOIN projects p ON p.id = q.project_id AND p.status = 'active'
           LEFT JOIN review_assignments ra ON ra.question_version_id = q.current_version_id AND ra.status = 'assigned' AND ra.active_token = 'ACTIVE'
          WHERE q.id IN (${placeholders}) AND q.current_status = 'pending_review' AND q.archived_at IS NULL AND ra.id IS NULL
          FOR UPDATE`,
        parsed.data.questionIds,
      );
      if (questions.length !== parsed.data.questionIds.length)
        throw new Error(
          "所选试题中包含已分配、已处理或非待审定的试题，请刷新后重试。",
        );
      for (const question of questions) {
        if (!question.current_version_id)
          throw new Error("试题当前版本不存在，无法分配。");
        await connection.execute(
          `INSERT INTO project_members (id, project_id, account_id, status)
           VALUES (?, ?, ?, 'active')
           ON DUPLICATE KEY UPDATE status = 'active', row_version = row_version + 1`,
          [createUlid(), question.project_id, parsed.data.expertId],
        );
        await connection.execute(
          `INSERT INTO review_assignments (id, project_id, question_id, question_version_id, expert_id, assigned_by, status, active_token)
           VALUES (?, ?, ?, ?, ?, ?, 'assigned', 'ACTIVE')`,
          [
            createUlid(),
            question.project_id,
            question.id,
            question.current_version_id,
            parsed.data.expertId,
            session!.user.id,
          ],
        );
      }
      await connection.execute(
        `INSERT INTO audit_logs (id, actor_id, action, object_type, object_id, after_json, result)
         VALUES (?, ?, 'expert_review.assign', 'review_assignment_batch', ?, ?, 'success')`,
        [
          createUlid(),
          session!.user.id,
          parsed.data.expertId,
          JSON.stringify({ questionIds: parsed.data.questionIds }),
        ],
      );
      return { assigned: questions.length };
    });
    return NextResponse.json({ data }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      {
        error: {
          code: "REVIEW_ASSIGNMENT_CREATE_FAILED",
          message:
            error instanceof Error ? error.message : "审核任务分配失败。",
        },
      },
      { status: 422 },
    );
  }
}
