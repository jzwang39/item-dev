import assert from "node:assert/strict";
import test from "node:test";
import type { PoolConnection } from "mysql2/promise";
import { assertGenerationHandoffReady } from "./stop";

function db(status: string | null, generated: number, pending = 0, unfinished = 1) {
  return { execute: async (sql: string) => sql.includes("FROM authoring_generation_jobs")
    ? [status ? [{ id: "job", status, target_count: 10 }] : []]
    : [[{ generated_count: generated, pending, unfinished }]],
  } as unknown as PoolConnection;
}
test("已停止有成果可交接，未补齐不再阻塞", async () => {
  await assertGenerationHandoffReady(db("stopped", 8), "plan");
});
test("空成果和仍有活动请求的停止任务不能交接", async () => {
  await assert.rejects(assertGenerationHandoffReady(db("stopped", 0), "plan"), /空成果/);
  await assert.rejects(assertGenerationHandoffReady(db("stopped", 8, 1), "plan"), /未关闭请求/);
});
test("正常任务仍须完整生成，取消任务不允许交接", async () => {
  for (const status of ["queued", "running", "partial", "cancelled"]) {
    await assert.rejects(assertGenerationHandoffReady(db(status, 8), "plan"), /尚未全部生成/);
  }
  await assert.rejects(assertGenerationHandoffReady(db("succeeded", 8, 0, 0), "plan"), /尚未全部生成/);
  await assertGenerationHandoffReady(db("succeeded", 10, 0, 0), "plan");
  await assertGenerationHandoffReady(db(null, 0), "legacy");
});
