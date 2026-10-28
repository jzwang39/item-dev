import { createHash } from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getVerifiedSession } from "@/auth";
import { withTransaction } from "@/shared/database/mysql";
import { createUlid } from "@/shared/database/ulid";
import { assertQuestionConfirmed } from "@/modules/authoring/question-confirmation";
import { bulkQuestionConfirmSchema, bulkQuestionReviewSchema } from "@/modules/authoring/bulk-question-review";
import { confirmQuestionBatch } from "@/modules/authoring/bulk-question-confirmation";

const schema = z.object({
  assignmentId: z.string().length(26).nullish(), questionId: z.string().length(26),
  versionId: z.string().length(26), action: z.enum(["review", "confirm", "revise", "store"]),
  decision: z.enum(["approved", "returned"]).default("approved"),
  opinion: z.string().trim().min(1).max(4000),
  stem: z.string().trim().min(1).max(10000).optional(),
  options: z.array(z.object({ key: z.string().trim().min(1), content: z.string().trim().min(1) })).max(8).optional(),
  answers: z.array(z.string().trim().min(1)).min(1).optional(),
  analysis: z.string().trim().min(1).max(20000).optional(),
});
const decode = (value: unknown): Record<string, unknown> => typeof value === "string" ? JSON.parse(value) : value as Record<string, unknown>;

export async function POST(request: Request) {
  const session = await getVerifiedSession();
  if (!session?.user?.id) return NextResponse.json({ error: { message: "登录已失效。" } }, { status: 401 });
  const body = await request.json();
  if (body?.action === "bulk_confirm") {
    if (session.user.role !== "admin") return NextResponse.json({ error: { message: "仅管理员可批量确认试题。" } }, { status: 403 });
    const confirmation = bulkQuestionConfirmSchema.safeParse(body);
    if (!confirmation.success) return NextResponse.json({ error: { message: confirmation.error.issues[0]?.message ?? "批量确认参数无效。" } }, { status: 400 });
    try {
      const data = await withTransaction((db) => confirmQuestionBatch(
        db, confirmation.data.questions, session.user.id, confirmation.data.opinion,
      ));
      return NextResponse.json({ data });
    } catch (error) {
      return NextResponse.json({ error: { message: error instanceof Error ? error.message : "批量确认失败。" } }, { status: 422 });
    }
  }
  const bulk = body?.action === "bulk_approve";
  if (bulk && session.user.role !== "admin") return NextResponse.json({ error: { message: "仅管理员可批量审核试题。" } }, { status: 403 });
  const batch = bulk ? bulkQuestionReviewSchema.safeParse(body) : null;
  if (batch && !batch.success) return NextResponse.json({ error: { message: batch.error.issues[0]?.message ?? "批量审核参数无效。" } }, { status: 400 });
  const parsed = schema.safeParse(bulk && batch?.success
    ? { ...batch.data.questions[0], action: "review", opinion: batch.data.opinion, decision: "approved" }
    : body);
  if (!parsed.success) return NextResponse.json({ error: { message: "请完整填写题目及审定意见。" } }, { status: 400 });
  const input = parsed.data;
  const expert = session.user.role === "expert";
  if (expert && input.action === "confirm") return NextResponse.json({ error: { message: "仅管理员可确认入库。" } }, { status: 403 });
  if (expert && input.action !== "revise") return NextResponse.json({ error: { message: "请通过专家审核入口提交审定结论。" } }, { status: 403 });
  if (!expert && input.action === "revise") return NextResponse.json({ error: { message: "管理员请使用修订并审定。" } }, { status: 403 });
  const inputs: z.infer<typeof schema>[] = bulk && batch?.success
    ? batch.data.questions.map((question) => ({ ...question, action: "review" as const, decision: "approved" as const, opinion: batch.data.opinion }))
      .sort((a, b) => a.questionId.localeCompare(b.questionId))
    : [input];
  try {
    const data = await withTransaction(async (db) => {
      const results: Array<{ current_version_id: string; current_status: string }> = [];
      for (const originalInput of inputs) {
      let input = originalInput;
      const [rows] = await db.execute<(RowDataPacket & {
        project_id: string; current_status: string; current_version_id: string; question_type: string;
        expert_id: string | null; reviewer_role: string | null; assignment_status: string | null; assignment_id: string | null; stem: string; content_json: unknown;
        answer_json: unknown; analysis_text: string; version_no: number; source_snapshot_json: unknown; score_rubric_json: unknown;
      })[]>(
        `SELECT q.project_id,q.current_status,q.current_version_id,q.question_type,ra.expert_id,ra.id AS assignment_id,reviewer.role AS reviewer_role,ra.status AS assignment_status,
          v.stem,v.content_json,v.answer_json,v.analysis_text,v.version_no,v.source_snapshot_json,v.score_rubric_json
         FROM questions q JOIN question_versions v ON v.id=q.current_version_id
         LEFT JOIN review_assignments ra ON ra.id=(SELECT latest.id FROM review_assignments latest
           WHERE latest.question_id=q.id AND latest.question_version_id=v.id
           ORDER BY (latest.status='assigned') DESC,latest.assigned_at DESC,latest.id DESC LIMIT 1)
         LEFT JOIN accounts reviewer ON reviewer.id=ra.expert_id
         WHERE q.id=? AND q.archived_at IS NULL FOR UPDATE`, [input.questionId],
      );
      const row = rows[0];
      if (!row || row.current_version_id !== input.versionId) throw new Error("试题或审定版本已变化，请刷新后重试。");
      // Bulk approval uses the locked current content, never client-supplied edits.
      if (bulk) {
        input = {
          ...input, stem: row.stem,
          options: (decode(row.content_json).options ?? []) as z.infer<typeof schema>["options"],
          answers: decode(row.answer_json).answers as string[],
          analysis: row.analysis_text,
        };
        const validated = schema.safeParse(input);
        if (!validated.success) throw new Error("所选试题内容不完整，请先编辑修订后再审核。");
        input = validated.data;
      }
      if (expert && (row.expert_id !== session.user.id || row.assignment_id !== input.assignmentId ||
          !["assigned", "submitted"].includes(row.assignment_status ?? ""))) throw new Error("仅能修订本人当前分配的试题。");
      if (input.action === "confirm" || input.action === "store") {
        if (row.current_status !== "approved") throw new Error("仅审核通过的试题可管理员确认。");
        if (input.action === "confirm") {
          const [existing] = await db.execute<RowDataPacket[]>("SELECT question_version_id FROM question_review_confirmations WHERE question_version_id=?", [input.versionId]);
          if (existing.length) throw new Error("该版本已确认，请执行入库操作。");
          await db.execute("INSERT INTO question_review_confirmations(question_version_id,confirmed_by,opinion) VALUES(?,?,?)", [input.versionId, session.user.id, input.opinion]);
          await db.execute("UPDATE questions SET row_version=row_version+1 WHERE id=?", [input.questionId]);
        } else {
          await assertQuestionConfirmed(db, input.versionId);
          await db.execute("UPDATE questions SET current_status='stored',row_version=row_version+1 WHERE id=?", [input.questionId]);
        }
      } else {
        if (!expert && row.reviewer_role === "expert") throw new Error("试题已分配给专家，管理员不能审核或编辑修订，请由任务专家处理。");
        if (!["pending_review", "returned"].includes(row.current_status)) throw new Error("当前试题不能再代审。");
        if (!input.stem || !input.options || !input.answers || !input.analysis) throw new Error("请填写题干、答案与解析。");
        const answers = input.answers;
        const keys = input.options.map((option) => option.key);
        const isSingle = /单.*选/.test(row.question_type), isMultiple = /多.*选/.test(row.question_type);
        if (/判断/.test(row.question_type)) {
          if (input.options.length || answers.length !== 1 || !["正确", "错误"].includes(answers[0])) throw new Error("判断题无选项，答案须为正确或错误。");
        } else if (isSingle || isMultiple) {
          if (new Set(keys).size !== keys.length || new Set(input.options.map((option) => option.content)).size !== keys.length ||
              input.options.length < 4 || (isSingle && (input.options.length !== 4 || answers.length !== 1)) ||
              (isMultiple && answers.length < 2) || new Set(answers).size !== answers.length || answers.some((answer) => !keys.includes(answer))) {
            throw new Error("选项或答案不符合当前题型规则。");
          }
        }
        const content = { ...decode(row.content_json), options: input.options };
        const answer = { ...decode(row.answer_json), answers };
        const edited = input.stem !== row.stem || JSON.stringify(content) !== JSON.stringify(decode(row.content_json)) ||
          JSON.stringify(answer) !== JSON.stringify(decode(row.answer_json)) || input.analysis !== row.analysis_text;
        let versionId = row.current_version_id;
        // Returned versions are re-reviewed as a new revision, preserving their
        // original decision and the assignment/version relationship.
        if (edited || row.assignment_status !== "assigned" || input.action === "revise") {
          versionId = createUlid();
          await db.execute(
            `INSERT INTO question_versions(id,question_id,version_no,parent_version_id,revision_reason,stem,content_json,
              answer_json,analysis_text,source_snapshot_json,score_rubric_json,content_hash,created_by)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [versionId, input.questionId, Number(row.version_no) + 1, row.current_version_id, input.opinion, input.stem,
              JSON.stringify(content), JSON.stringify(answer), input.analysis, JSON.stringify(decode(row.source_snapshot_json)),
              row.score_rubric_json ? JSON.stringify(decode(row.score_rubric_json)) : null,
              createHash("sha256").update(JSON.stringify({ stem: input.stem, content, answer, analysis: input.analysis, versionId })).digest("hex"), session.user.id],
          );
          for (const option of input.options) await db.execute(
            "INSERT INTO question_options(id,question_version_id,option_key,content,is_correct) VALUES(?,?,?,?,?)",
            [createUlid(), versionId, option.key, option.content, answers.includes(option.key) ? 1 : 0],
          );
          await db.execute("INSERT INTO question_assessment_points(question_version_id,blueprint_node_id,coverage_weight) SELECT ?,blueprint_node_id,coverage_weight FROM question_assessment_points WHERE question_version_id=?", [versionId, row.current_version_id]);
          const [refs] = await db.execute<(RowDataPacket & { source_version_id: string; source_segment_id: string; citation: string; quote_excerpt: string | null })[]>(
            "SELECT source_version_id,source_segment_id,citation,quote_excerpt FROM question_source_refs WHERE question_version_id=?", [row.current_version_id],
          );
          for (const ref of refs) await db.execute("INSERT INTO question_source_refs(id,question_version_id,source_version_id,source_segment_id,citation,quote_excerpt) VALUES(?,?,?,?,?,?)",
            [createUlid(), versionId, ref.source_version_id, ref.source_segment_id, ref.citation, ref.quote_excerpt]);
          await db.execute("INSERT INTO question_revision_links(id,from_question_version_id,to_question_version_id,relation_type) VALUES(?,?,?,'manual_revision')",
            [createUlid(), row.current_version_id, versionId]);
          await db.execute("UPDATE questions SET current_version_id=? WHERE id=?", [versionId, input.questionId]);
        }
        const assignmentId = versionId !== row.current_version_id || !row.assignment_id ? createUlid() : row.assignment_id;
        if (assignmentId !== row.assignment_id) {
          if (row.assignment_id) await db.execute("UPDATE review_assignments SET status='cancelled',active_token=NULL WHERE id=? AND status='assigned'", [row.assignment_id]);
          await db.execute("INSERT INTO review_assignments(id,project_id,question_id,question_version_id,expert_id,assigned_by,status,active_token) VALUES(?,?,?,?,?,?,?,?)",
            [assignmentId, row.project_id, input.questionId, versionId, session.user.id, session.user.id,
              input.action === "revise" ? "assigned" : "submitted", input.action === "revise" ? "ACTIVE" : null]);
        } else await db.execute("UPDATE review_assignments SET status='submitted',active_token=NULL,row_version=row_version+1 WHERE id=?", [assignmentId]);
        if (input.action !== "revise") await db.execute(
          `INSERT INTO review_records(id,assignment_id,question_version_id,expert_id,stage,decision,comment,alignment,idempotency_key,submitted_by,acting_role)
           VALUES(?,?,?,?,?,?,?,'aligned',?,?,?)`,
          [createUlid(), assignmentId, versionId, session.user.id, expert ? "expert_revision" : "admin_proxy", input.decision, input.opinion, `${assignmentId}:${expert ? "expert_revision" : "admin_proxy"}`, session.user.id, session.user.role],
        );
        await db.execute("UPDATE questions SET current_status=?,row_version=row_version+1 WHERE id=?", [input.action === "revise" ? "pending_review" : input.decision === "approved" ? "approved" : "returned", input.questionId]);
      }
      const [current] = await db.execute<(RowDataPacket & { current_version_id: string; current_status: string })[]>("SELECT current_version_id,current_status FROM questions WHERE id=?", [input.questionId]);
      if (row.current_status !== current[0].current_status || row.current_version_id !== current[0].current_version_id) await db.execute("INSERT INTO question_status_events(id,question_id,question_version_id,from_status,to_status,reason,actor_id) VALUES(?,?,?,?,?,?,?)",
        [createUlid(), input.questionId, current[0].current_version_id, row.current_status, current[0].current_status, input.opinion, session.user.id]);
      await db.execute("INSERT INTO audit_logs(id,project_id,actor_id,action,object_type,object_id,before_json,after_json,result) VALUES(?,?,?,?,'question',?,?,?,'success')",
        [createUlid(), row.project_id, session.user.id, expert ? "review.expert_revision" : "review.admin_action", input.questionId, JSON.stringify({ versionId: row.current_version_id, status: row.current_status }),
          JSON.stringify({ ...input, actingRole: session.user.role, assignedExpertId: row.expert_id, actualActorId: session.user.id, ...current[0] })]);
      results.push(current[0]);
      }
      return bulk ? { reviewed: results.length, results } : results[0];
    });
    return NextResponse.json({ data });
  } catch (error) {
    return NextResponse.json({ error: { message: error instanceof Error ? error.message : "代审提交失败。" } }, { status: 422 });
  }
}
