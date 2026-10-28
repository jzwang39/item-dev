import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { createUlid } from "@/shared/database/ulid";

export async function confirmQuestionBatch(
  db: PoolConnection,
  questions: Array<{ questionId: string; versionId: string }>,
  actorId: string,
  opinion: string,
) {
  if (!questions.length || new Set(questions.map((question) => question.questionId)).size !== questions.length) {
    throw new Error("请选择不重复的待确认试题。");
  }
  const [rows] = await db.execute<(RowDataPacket & {
    id: string; project_id: string; current_version_id: string; current_status: string;
    confirmed_at: string | null;
  })[]>(
    `SELECT q.id,q.project_id,q.current_version_id,q.current_status,qrc.confirmed_at
     FROM questions q
     INNER JOIN projects p ON p.id=q.project_id AND p.status='active'
     LEFT JOIN question_review_confirmations qrc ON qrc.question_version_id=q.current_version_id
     WHERE q.id IN (${questions.map(() => "?").join(",")}) AND q.archived_at IS NULL
     ORDER BY q.id FOR UPDATE`,
    questions.map((question) => question.questionId),
  );
  if (rows.length !== questions.length) throw new Error("所选试题不存在或已归档，请刷新后重试。");
  for (const row of rows) {
    if (row.current_version_id !== questions.find((question) => question.questionId === row.id)!.versionId) {
      throw new Error("试题版本已变化，请刷新后重试。");
    }
    if (row.current_status !== "approved") throw new Error("仅审核通过的试题可管理员确认。");
    if (row.confirmed_at) throw new Error("所选试题已确认，请刷新后重新选择。");
  }
  // The caller runs this entire batch in a transaction, preserving per-version confirmation.
  for (const row of rows) {
    await db.execute(
      "INSERT INTO question_review_confirmations(question_version_id,confirmed_by,opinion) VALUES(?,?,?)",
      [row.current_version_id, actorId, opinion],
    );
    await db.execute("UPDATE questions SET row_version=row_version+1 WHERE id=?", [row.id]);
    await db.execute(
      "INSERT INTO audit_logs(id,project_id,actor_id,action,object_type,object_id,before_json,after_json,result) VALUES(?,?,?,'review.admin_action','question',?,?,?,'success')",
      [createUlid(), row.project_id, actorId, row.id,
        JSON.stringify({ versionId: row.current_version_id, status: row.current_status }),
        JSON.stringify({ action: "confirm", batch: true, actingRole: "admin", actualActorId: actorId,
          versionId: row.current_version_id, status: row.current_status, opinion, confirmed: true })],
    );
  }
  return { confirmedCount: rows.length };
}
