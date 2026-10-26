import type { PoolConnection, RowDataPacket } from "mysql2/promise";

export async function assertQuestionConfirmed(db: PoolConnection, versionId: string) {
  const [rows] = await db.execute<RowDataPacket[]>(
    "SELECT question_version_id FROM question_review_confirmations WHERE question_version_id=?", [versionId],
  );
  if (!rows.length) throw new Error("试题尚未经管理员确认，请先在“审核确定”中确认后再入库。");
}
