import assert from "node:assert/strict";
import test from "node:test";
import type { PoolConnection } from "mysql2/promise";
import { bulkQuestionConfirmSchema, canBulkConfirmQuestion } from "./bulk-question-review";
import { confirmQuestionBatch } from "./bulk-question-confirmation";

const id = (index: number) => String(index).padStart(26, "0");
const question = (index: number) => ({ questionId: id(index), versionId: `V${id(index).slice(1)}` });
const row = (index: number) => ({
  id: id(index), project_id: id(90), current_version_id: question(index).versionId,
  current_status: "approved", confirmed_at: null as string | null,
});
const request = { action: "bulk_confirm", confirmed: true, opinion: "管理员确认。", questions: [question(1)] };
function database(rows: ReturnType<typeof row>[]) {
  const writes: Array<{ sql: string; values: unknown[] }> = [];
  const db = { async execute(sql: string, values: unknown[]) {
    if (sql.startsWith("SELECT")) return [rows, []];
    writes.push({ sql, values });
    return [{ affectedRows: 1 }, []];
  } } as unknown as PoolConnection;
  return { db, writes };
}

test("批量确认需要责任确认、意见、有效版本，不接受重复和超限", () => {
  assert.equal(bulkQuestionConfirmSchema.safeParse(request).success, true);
  for (const invalid of [
    { ...request, confirmed: false }, { ...request, opinion: " " }, { ...request, questions: [] },
    { ...request, questions: [question(1), question(1)] },
    { ...request, questions: [{ ...question(1), versionId: "invalid" }] },
    { ...request, questions: Array.from({ length: 51 }, (_, index) => question(index)) },
  ]) assert.equal(bulkQuestionConfirmSchema.safeParse(invalid).success, false);
});

test("只有已通过未确认试题可选，不受原审核专家身份限制", () => {
  assert.equal(canBulkConfirmQuestion({ status: "approved", confirmedAt: null }), true);
  assert.equal(canBulkConfirmQuestion({ status: "approved", confirmedAt: "2026-10-27" }), false);
  for (const status of ["pending_review", "returned", "stored", "draft"]) {
    assert.equal(canBulkConfirmQuestion({ status, confirmedAt: null }), false);
  }
});

test("逐题记录当前版本、意见与管理员身份，不修改审核结论或入库状态", async () => {
  const { db, writes } = database([row(1), row(2)]);
  assert.deepEqual(await confirmQuestionBatch(db, [question(1), question(2)], id(99), "统一确认意见"), { confirmedCount: 2 });
  const confirmations = writes.filter((write) => write.sql.includes("INSERT INTO question_review_confirmations"));
  assert.equal(confirmations.length, 2);
  assert.deepEqual(confirmations[0].values, [question(1).versionId, id(99), "统一确认意见"]);
  const audits = writes.filter((write) => write.sql.includes("audit_logs"));
  assert.equal(audits.length, 2);
  assert.equal(audits[0].values[2], id(99));
  assert.equal(JSON.parse(String(audits[0].values[5])).action, "confirm");
  assert.ok(writes.every((write) => !write.sql.includes("current_status=") && !write.sql.includes("review_records")));
});

test("第二题未通过、已确认或版本变化时整批验证失败，第一题不写入", async () => {
  for (const changed of [
    { ...row(2), current_status: "pending_review" },
    { ...row(2), confirmed_at: "2026-10-27" },
    { ...row(2), current_version_id: id(88) },
  ]) {
    const { db, writes } = database([row(1), changed]);
    await assert.rejects(confirmQuestionBatch(db, [question(1), question(2)], id(99), "确认"));
    assert.equal(writes.length, 0);
  }
});

test("缺失试题与重复输入均拒绝", async () => {
  const { db, writes } = database([row(1)]);
  await assert.rejects(confirmQuestionBatch(db, [question(1), question(2)], id(99), "确认"));
  await assert.rejects(confirmQuestionBatch(db, [question(1), question(1)], id(99), "确认"));
  assert.equal(writes.length, 0);
});
