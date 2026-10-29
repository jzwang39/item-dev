import { NextResponse } from "next/server";
import { z } from "zod";
import type { RowDataPacket } from "mysql2/promise";

import { getVerifiedSession } from "@/auth";
import { createUlid } from "@/shared/database/ulid";
import { withTransaction } from "@/shared/database/mysql";
import { assertGenerationHandoffReady } from "@/modules/authoring/generation/stop";

const schema = z.object({
  manualChecks: z
    .array(
      z.object({
        questionId: z.string().length(26),
        status: z.enum(["人工通过", "需修订"]),
      }),
    )
    .min(1),
});

export async function POST(
  request: Request,
  { params }: Readonly<{ params: { planId: string } }>,
) {
  const session = await getVerifiedSession();
  if (!session?.user?.id)
    return NextResponse.json(
      { error: { code: "UNAUTHENTICATED", message: "登录已失效。" } },
      { status: 401 },
    );
  if (session.user.role !== "admin")
    return NextResponse.json(
      {
        error: {
          code: "FORBIDDEN",
          message: "仅管理员可保存专家审定交接记录。",
        },
      },
      { status: 403 },
    );

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success)
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "人工核查记录无效。" } },
      { status: 400 },
    );

  try {
    const result = await withTransaction(async (connection) => {
      const [plans] = await connection.execute<
        (RowDataPacket & { project_id: string })[]
      >(
        "SELECT project_id FROM authoring_plans WHERE id = ? AND status = 'confirmed' LIMIT 1 FOR UPDATE",
        [params.planId],
      );
      if (!plans[0]) throw new Error("待交接的命题计划不存在或未确认。");
      await assertGenerationHandoffReady(connection, params.planId);
      const approvedQuestionIds = parsed.data.manualChecks
        .filter((item) => item.status === "人工通过")
        .map((item) => item.questionId);
      if (!approvedQuestionIds.length)
        throw new Error("至少需要一题通过人工核查后才能交接专家审定。");
      const placeholders = approvedQuestionIds.map(() => "?").join(", ");
      const [questions] = await connection.execute<
        (RowDataPacket & {
          id: string;
          current_version_id: string | null;
          current_status: string;
          assessment_mode: string;
        })[]
      >(
        `SELECT q.id, q.current_version_id, q.current_status, q.assessment_mode
           FROM questions q
           INNER JOIN question_versions qv ON qv.id = q.current_version_id
          WHERE q.project_id = ? AND q.id IN (${placeholders})
            AND JSON_UNQUOTE(JSON_EXTRACT(qv.source_snapshot_json,'$.planId')) = ? FOR UPDATE`,
        [plans[0].project_id, ...approvedQuestionIds, params.planId],
      );
      if (questions.length !== approvedQuestionIds.length)
        throw new Error("人工核查的试题不属于当前命题计划或已被更新。");
      for (const question of questions) {
        if (!question.current_version_id || !(question.current_status === "draft" || question.current_status === "pending_review" && question.assessment_mode === "skill"))
          throw new Error("仅可交接当前计划下处于草稿状态的试题。");
        // Skill generation already stores pending_review drafts. Their manual
        // handoff is audited without manufacturing a second status transition.
        if (question.current_status === "pending_review") continue;
        await connection.execute(
          "UPDATE questions SET current_status = 'pending_review', row_version = row_version + 1 WHERE id = ?",
          [question.id],
        );
        await connection.execute(
          `INSERT INTO question_status_events (id, question_id, question_version_id, from_status, to_status, reason, actor_id)
           VALUES (?, ?, ?, 'draft', 'pending_review', '管理员人工核查通过，交由专家审定', ?)`,
          [
            createUlid(),
            question.id,
            question.current_version_id,
            session.user.id,
          ],
        );
      }
      await connection.execute(
        `INSERT INTO audit_logs (
          id, project_id, actor_id, action, object_type, object_id, after_json, result
        ) VALUES (?, ?, ?, 'authoring.plan.expert_handoff_saved', 'authoring_plan', ?, ?, 'success')`,
        [
          createUlid(),
          plans[0].project_id,
          session.user.id,
          params.planId,
          JSON.stringify({
            reviewState: "awaiting_expert",
            manualChecks: parsed.data.manualChecks,
            questionIds: approvedQuestionIds,
          }),
        ],
      );
      return {
        questionIds: approvedQuestionIds,
        transitioned: questions.length,
      };
    });
    return NextResponse.json(
      { data: { saved: true, reviewState: "awaiting_expert", ...result } },
      { status: 201 },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: {
          code: "HANDOFF_SAVE_FAILED",
          message:
            error instanceof Error ? error.message : "交接记录保存失败。",
        },
      },
      { status: 422 },
    );
  }
}
