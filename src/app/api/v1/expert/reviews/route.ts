import type { RowDataPacket } from "mysql2/promise";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getVerifiedSession } from "@/auth";
import { createUlid } from "@/shared/database/ulid";
import { query, withTransaction } from "@/shared/database/mysql";

const levels: Record<string, string> = {
  level_5: "五级 / 初级工",
  level_4: "四级 / 中级工",
  level_3: "三级 / 高级工",
  level_2: "二级 / 技师",
  level_1: "一级 / 高级技师",
};
const submitSchema = z.object({
  assignmentId: z.string().length(26),
  stage: z.string().trim().min(1).max(32),
  alignment: z.enum(["aligned", "partially_aligned", "not_aligned"]),
  alignmentScore: z.enum(["1", "2", "3", "4", "5"]),
  decision: z.enum(["approved", "returned", "rejected"]),
  comment: z.string().trim().min(1).max(4000),
  confirmed: z.literal(true),
});

function decode(value: unknown) {
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return {};
  }
}

export async function GET() {
  const session = await getVerifiedSession();
  if (!session?.user?.id)
    return NextResponse.json(
      { error: { code: "UNAUTHENTICATED", message: "登录已失效。" } },
      { status: 401 },
    );
  if (session.user.role !== "expert")
    return NextResponse.json(
      {
        error: { code: "FORBIDDEN", message: "专家账号方可处理个人审定任务。" },
      },
      { status: 403 },
    );
  try {
    const tasks = await query<
      (RowDataPacket & {
        assignment_id: string;
        question_id: string;
        question_version_id: string;
        question_no: string;
        occupation_name: string;
        level_code: string;
        assessment_mode: "theory" | "skill";
        question_type: string;
        stem: string;
        content_json: unknown;
        answer_json: unknown;
        analysis_text: string | null;
        score_rubric_json: unknown;
        point_name: string | null;
        assigned_at: string;
        current_status: string;
      })[]
    >(
      `SELECT ra.id AS assignment_id, q.id AS question_id, qv.id AS question_version_id, q.question_no, po.name AS occupation_name,
              q.level_code, q.assessment_mode, q.question_type, qv.stem, qv.content_json, qv.answer_json, qv.analysis_text, qv.score_rubric_json,
              (SELECT GROUP_CONCAT(DISTINCT bn.name ORDER BY bn.ordinal SEPARATOR '、')
                FROM question_assessment_points qap JOIN blueprint_nodes bn ON bn.id=qap.blueprint_node_id
                WHERE qap.question_version_id=qv.id) AS point_name, ra.assigned_at,q.current_status
         FROM review_assignments ra
         INNER JOIN questions q ON q.id = ra.question_id AND q.current_status IN ('pending_review','returned','approved','stored') AND q.archived_at IS NULL
         INNER JOIN question_versions qv ON qv.id = ra.question_version_id AND qv.id=q.current_version_id
         INNER JOIN project_occupations po ON po.id = q.occupation_id
        WHERE ra.expert_id = ? AND ra.status IN ('assigned','submitted')
          AND ra.id=(SELECT latest.id FROM review_assignments latest WHERE latest.question_version_id=qv.id ORDER BY latest.assigned_at DESC,latest.id DESC LIMIT 1)
        ORDER BY ra.assigned_at ASC`,
      [session.user.id],
    );
    const summary = await query<
      (RowDataPacket & {
        pending: number;
        returned: number;
        approved: number;
      })[]
    >(
      `SELECT COALESCE(SUM(ra.status = 'assigned'), 0) AS pending,
              COALESCE(SUM(rr.decision = 'returned'), 0) AS returned,
              COALESCE(SUM(rr.decision = 'approved'), 0) AS approved
         FROM review_assignments ra LEFT JOIN review_records rr ON rr.assignment_id = ra.id
        WHERE ra.expert_id = ?`,
      [session.user.id],
    );
    return NextResponse.json({
      data: {
        tasks: tasks.map((task) => ({
          assignmentId: task.assignment_id,
          questionId: task.question_id,
          questionVersionId: task.question_version_id,
          questionNo: task.question_no,
          occupationName: task.occupation_name,
          levelLabel: levels[task.level_code] ?? task.level_code,
          assessmentMode: task.assessment_mode,
          questionType: task.question_type,
          stem: task.stem,
          content: decode(task.content_json),
          answer: decode(task.answer_json),
          analysis: task.analysis_text,
          scoreRubric: task.score_rubric_json ? decode(task.score_rubric_json) : null,
          pointName: task.point_name ?? "未关联考评点",
          assignedAt: task.assigned_at,
          status: task.current_status,
        })),
        summary: summary[0] ?? { pending: 0, returned: 0, approved: 0 },
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: {
          code: "EXPERT_REVIEW_LIST_FAILED",
          message:
            error instanceof Error ? error.message : "审定任务加载失败。",
        },
      },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const session = await getVerifiedSession();
  if (!session?.user?.id)
    return NextResponse.json(
      { error: { code: "UNAUTHENTICATED", message: "登录已失效。" } },
      { status: 401 },
    );
  if (session.user.role !== "expert")
    return NextResponse.json(
      { error: { code: "FORBIDDEN", message: "专家账号方可提交审定结果。" } },
      { status: 403 },
    );
  const parsed = submitSchema.safeParse(await request.json());
  if (!parsed.success)
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_FAILED",
          message:
            parsed.error.issues[0]?.message ?? "请完整填写审定意见并据实确认。",
        },
      },
      { status: 400 },
    );
  try {
    const result = await withTransaction(async (connection) => {
      const [rows] = await connection.execute<
        (RowDataPacket & {
          question_id: string;
          question_version_id: string;
          project_id: string;
          current_status: "pending_review";
        })[]
      >(
        `SELECT ra.question_id, ra.question_version_id, ra.project_id, q.current_status FROM review_assignments ra INNER JOIN questions q ON q.id = ra.question_id AND q.current_version_id=ra.question_version_id WHERE ra.id = ? AND ra.expert_id = ? AND ra.status = 'assigned' AND ra.active_token = 'ACTIVE' FOR UPDATE`,
        [parsed.data.assignmentId, session.user.id],
      );
      const assignment = rows[0];
      if (!assignment || assignment.current_status !== "pending_review")
        throw new Error("该审定任务已处理、已撤销或试题状态已变化。");
      const recordId = createUlid();
      const nextStatus =
        parsed.data.decision === "approved" ? "approved" : "returned";
      await connection.execute(
        `INSERT INTO review_records (id, assignment_id, question_version_id, expert_id, stage, decision, comment, alignment, idempotency_key, submitted_by, acting_role) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'expert')`,
        [
          recordId,
          parsed.data.assignmentId,
          assignment.question_version_id,
          session.user.id,
          parsed.data.stage,
          parsed.data.decision,
          parsed.data.comment,
          parsed.data.alignment,
          `${parsed.data.assignmentId}:${parsed.data.stage}`,
          session.user.id,
        ],
      );
      await connection.execute(
        "UPDATE review_assignments SET status = 'submitted', active_token = NULL, row_version = row_version + 1 WHERE id = ?",
        [parsed.data.assignmentId],
      );
      await connection.execute(
        "UPDATE questions SET current_status = ?, row_version = row_version + 1 WHERE id = ?",
        [nextStatus, assignment.question_id],
      );
      await connection.execute(
        "INSERT INTO question_status_events (id, question_id, question_version_id, from_status, to_status, reason, actor_id) VALUES (?, ?, ?, 'pending_review', ?, ?, ?)",
        [
          createUlid(),
          assignment.question_id,
          assignment.question_version_id,
          nextStatus,
          parsed.data.comment.slice(0, 2000),
          session.user.id,
        ],
      );
      await connection.execute(
        "INSERT INTO audit_logs (id, project_id, actor_id, action, object_type, object_id, after_json, result) VALUES (?, ?, ?, 'expert_review.submit', 'review_record', ?, ?, 'success')",
        [
          createUlid(),
          assignment.project_id,
          session.user.id,
          recordId,
          JSON.stringify({
            decision: parsed.data.decision,
            stage: parsed.data.stage,
            alignment: parsed.data.alignment,
            alignmentScore: parsed.data.alignmentScore,
            assignmentId: parsed.data.assignmentId,
          }),
        ],
      );
      return { decision: parsed.data.decision, status: nextStatus };
    });
    return NextResponse.json({ data: result });
  } catch (error) {
    return NextResponse.json(
      {
        error: {
          code: "EXPERT_REVIEW_SUBMIT_FAILED",
          message:
            error instanceof Error ? error.message : "提交审定结果失败。",
        },
      },
      { status: 422 },
    );
  }
}
