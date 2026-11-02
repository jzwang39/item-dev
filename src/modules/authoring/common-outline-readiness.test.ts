import assert from "node:assert/strict";
import test from "node:test";
import type { PoolConnection } from "mysql2/promise";
import { assertCommonOutlinesConfirmed } from "./common-outline-readiness";

const outlines = [
  { id: "five", levelCode: "level_5", versionNo: 4 },
  { id: "four", levelCode: "level_4", versionNo: 8 },
  { id: "three", levelCode: "level_3", versionNo: 3 },
];
function connection(rows: unknown[]) {
  return { execute: async (sql: string, values: unknown[]) => {
    assert.match(sql, /COALESCE\(r.status,'pending'\)/);
    assert.match(sql, /GROUP BY n.blueprint_version_id/);
    assert.deepEqual(values, ["five", "four", "three"]);
    return [rows];
  } } as unknown as PoolConnection;
}
test("一次反馈五四三级具体版本和待审核、待确认数量，不误称已审核等于已确认", async () => {
  await assert.rejects(assertCommonOutlinesConfirmed(connection([
    { version_id: "five", total: 152, confirmed: 0, pending: 152, returned: 0, awaiting_confirmation: 0 },
    { version_id: "four", total: 154, confirmed: 0, pending: 154, returned: 0, awaiting_confirmation: 0 },
    { version_id: "three", total: 150, confirmed: 0, pending: 0, returned: 0, awaiting_confirmation: 150 },
  ]), outlines), (error: Error) => {
    assert.match(error.message, /五级 V4：共152个考评点，已确认0个；待审核152个/);
    assert.match(error.message, /四级 V8：共154个考评点，已确认0个；待审核154个/);
    assert.match(error.message, /三级 V3：共150个考评点，已确认0个；已审核通过、待管理员确认150个/);
    assert.match(error.message, /专家审定 → 细目表审核任务/);
    return true;
  });
});
test("全部确认后通过，基础审核门槛不变", async () => {
  await assertCommonOutlinesConfirmed(connection(outlines.map((outline) => ({
    version_id: outline.id, total: 10, confirmed: 10, pending: 0, returned: 0, awaiting_confirmation: 0,
  }))), outlines);
});
test("空细目表和退回考评点都阻止创建，不把缺失记录视为审核通过", async () => {
  await assert.rejects(assertCommonOutlinesConfirmed(connection([
    { version_id: "three", total: 2, confirmed: 1, returned: 1, pending: 0, awaiting_confirmation: 0 },
  ]), outlines), (error: Error) => {
    assert.match(error.message, /五级 V4：没有可审核考评点/);
    assert.match(error.message, /四级 V8：没有可审核考评点/);
    assert.match(error.message, /已退回待修订1个/);
    return true;
  });
});
