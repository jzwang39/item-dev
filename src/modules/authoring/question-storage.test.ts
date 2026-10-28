import assert from "node:assert/strict";
import test from "node:test";
import type { PoolConnection } from "mysql2/promise";
import { BULK_STORAGE_LIMIT, bulkStorageSchema, canStoreQuestion } from "./question-storage-policy";
import { storeQuestions } from "./question-storage";

const id = (index: number) => String(index).padStart(26, "0");
const input = (index: number) => ({ questionId: id(index), versionId: `V${id(index).slice(1)}` });
const request = { action: "bulk_store", confirmed: true, opinion: "管理员批量终审入库。", questions: [input(1)] };
type Row = { id: string; project_id: string; current_version_id: string | null; current_status: string };
const row = (index: number): Row => ({ id: id(index), project_id: id(100), current_version_id: input(index).versionId, current_status: "approved" });

function database(rows: Row[], confirmed = rows.map((item) => item.current_version_id)) {
  const writes: Array<{ sql: string; values: unknown[] }> = [];
  const connection = {
    async execute(sql: string, values: unknown[]) {
      if (sql.startsWith("SELECT q.id")) return [rows, []];
      if (sql.startsWith("SELECT question_version_id")) {
        return [confirmed.includes(String(values[0])) ? [{ question_version_id: values[0] }] : [], []];
      }
      writes.push({ sql, values });
      return [{ affectedRows: 1 }, []];
    },
  } as unknown as PoolConnection;
  return { connection, writes };
}

test("批量入库需要确认、意见和有效版本，不能重复或超过50道", () => {
  assert.equal(bulkStorageSchema.safeParse(request).success, true);
  for (const invalid of [
    { ...request, confirmed: false }, { ...request, opinion: " " }, { ...request, questions: [] },
    { ...request, questions: [input(1), input(1)] },
    { ...request, questions: [{ ...input(1), versionId: "invalid" }] },
    { ...request, questions: Array.from({ length: BULK_STORAGE_LIMIT + 1 }, (_, index) => input(index)) },
  ]) assert.equal(bulkStorageSchema.safeParse(invalid).success, false);
  assert.equal(bulkStorageSchema.safeParse({
    ...request, questions: Array.from({ length: BULK_STORAGE_LIMIT }, (_, index) => input(index)),
  }).success, true);
});

test("仅已审定且当前版本已确认的试题可选", () => {
  assert.equal(canStoreQuestion({ status: "approved", confirmed: true, versionId: id(1) }), true);
  assert.equal(canStoreQuestion({ status: "approved", confirmed: false, versionId: id(1) }), false);
  assert.equal(canStoreQuestion({ status: "approved", confirmed: true, versionId: null }), false);
  for (const status of ["draft", "pending_review", "returned", "stored", "archived"]) {
    assert.equal(canStoreQuestion({ status, confirmed: true, versionId: id(1) }), false);
  }
});

test("成功批量入库逐题记录状态事件、版本和实际操作者", async () => {
  const db = database([row(1), row(2)]);
  const result = await storeQuestions(db.connection, [input(1), input(2)], id(99), "统一入库意见");
  assert.deepEqual(result, { stored: true, storedCount: 2 });
  assert.equal(db.writes.filter((write) => write.sql.startsWith("UPDATE")).length, 2);
  const events = db.writes.filter((write) => write.sql.includes("question_status_events"));
  const audits = db.writes.filter((write) => write.sql.includes("audit_logs"));
  assert.equal(events.length, 2);
  assert.equal(audits.length, 2);
  assert.ok(events.every((event) => event.values[4] === id(99) && event.values[3] === "统一入库意见"));
  assert.ok(audits.every((audit) => audit.values[2] === id(99)));
  assert.equal(JSON.parse(String(audits[0].values[5])).questionVersionId, input(1).versionId);
});

test("版本变化时拒绝整批且没有任何写入", async () => {
  const db = database([row(1), row(2)]);
  await assert.rejects(storeQuestions(db.connection, [input(1), { ...input(2), versionId: id(3) }], id(99)), /版本已变化/);
  assert.equal(db.writes.length, 0);
});

test("第二题未管理员确认时也不会先入库第一题", async () => {
  const db = database([row(1), row(2)], [input(1).versionId]);
  await assert.rejects(storeQuestions(db.connection, [input(1), input(2)], id(99)), /尚未经管理员确认/);
  assert.equal(db.writes.length, 0);
});

test("已入库、缺失版本、缺失试题和重复输入均不能入库", async () => {
  for (const invalidRows of [[{ ...row(1), current_status: "stored" }], [{ ...row(1), current_version_id: null }], []]) {
    const db = database(invalidRows);
    await assert.rejects(storeQuestions(db.connection, [input(1)], id(99)));
    assert.equal(db.writes.length, 0);
  }
  const db = database([row(1)]);
  await assert.rejects(storeQuestions(db.connection, [input(1), input(1)], id(99)));
  assert.equal(db.writes.length, 0);
});

test("单题入库保持原请求兼容并校验管理员确认", async () => {
  const db = database([row(1)]);
  assert.deepEqual(await storeQuestions(db.connection, [{ questionId: id(1) }], id(99)), { stored: true, storedCount: 1 });
});
