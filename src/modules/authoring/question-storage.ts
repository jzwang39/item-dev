import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { createUlid } from "@/shared/database/ulid";
import { assertQuestionConfirmed } from "./question-confirmation";

export async function storeQuestions(
  connection: PoolConnection,
  questions: Array<{ questionId: string; versionId?: string }>,
  actorId: string,
  opinion = "管理员终审入库",
) {
  if (!questions.length || new Set(questions.map((question) => question.questionId)).size !== questions.length) {
    throw new Error("请选择不重复的待入库试题。");
  }
  const [rows] = await connection.execute<(RowDataPacket & {
    id: string; project_id: string; current_version_id: string | null; current_status: string;
  })[]>(
    `SELECT q.id, q.project_id, q.current_version_id, q.current_status FROM questions q
     INNER JOIN projects p ON p.id=q.project_id AND p.status='active'
     WHERE q.id IN (${questions.map(() => "?").join(",")}) AND q.archived_at IS NULL
     ORDER BY q.id FOR UPDATE`,
    questions.map((question) => question.questionId),
  );
  if (rows.length !== questions.length) throw new Error("所选试题不存在或已归档，请刷新后重试。");
  // Validate the entire batch before writing; the caller keeps all writes in one transaction.
  for (const row of rows) {
    if (!row.current_version_id || row.current_status !== "approved") {
      throw new Error("仅已审定状态的试题可以终审入库，请刷新后重试。");
    }
    const expected = questions.find((question) => question.questionId === row.id)!;
    if (expected.versionId && expected.versionId !== row.current_version_id) {
      throw new Error("试题版本已变化，请刷新后重新选择。");
    }
    await assertQuestionConfirmed(connection, row.current_version_id);
  }
  for (const row of rows) {
    await connection.execute(
      "UPDATE questions SET current_status='stored',row_version=row_version+1 WHERE id=?", [row.id],
    );
    await connection.execute(
      "INSERT INTO question_status_events(id,question_id,question_version_id,from_status,to_status,reason,actor_id) VALUES(?,?,?,'approved','stored',?,?)",
      [createUlid(), row.id, row.current_version_id, opinion, actorId],
    );
    await connection.execute(
      "INSERT INTO audit_logs(id,project_id,actor_id,action,object_type,object_id,before_json,after_json,result) VALUES(?,?,?,'question.final_store','question',?,?,?,'success')",
      [createUlid(), row.project_id, actorId, row.id,
        JSON.stringify({ status: "approved", questionVersionId: row.current_version_id }),
        JSON.stringify({ status: "stored", questionVersionId: row.current_version_id, opinion })],
    );
  }
  return { stored: true, storedCount: rows.length };
}
