import assert from "node:assert/strict";
import test from "node:test";
import { extractRawText } from "mammoth";

test("Word下载接口验证登录、管理员权限、参数、缺失试卷、附件内容及留痕", async () => {
  const authPath = require.resolve("../../auth");
  const dbPath = require.resolve("../../shared/database/mysql");
  const previousAuth = require.cache[authPath], previousDb = require.cache[dbPath];
  let role: "admin" | "expert" | null = null;
  let missing = false;
  const audits: unknown[] = [];
  require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: {
    getVerifiedSession: async () => role ? { user: { id: "A".repeat(26), role } } : null,
  } } as NonNullable<typeof previousAuth>;
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
    query: async (sql: string) => sql.includes("FROM papers") ? missing ? [] : [{
      title: "测试试卷", paper_no: "T-1", project_id: "P".repeat(26), occupation_name: "劝募员",
      level_code: "level_4", assessment_mode: "theory", duration_minutes: 120,
    }] : [{
      item_no: 1, section_no: 1, question_type: "判断题", stem_snapshot: "捐赠材料应规范留存。",
      content_snapshot_json: {}, answer_snapshot_json: { answers: ["正确"] }, score_rubric_snapshot_json: null, score: 2,
    }],
    getPool: () => ({ execute: async (_sql: string, params: unknown[]) => { audits.push(params); return []; } }),
  } } as NonNullable<typeof previousDb>;
  try {
    const { GET } = await import("../../app/api/v1/assembly/download/route");
    const request = (kind = "paper") => new Request(`http://localhost/api/v1/assembly/download?paperId=${"I".repeat(26)}&kind=${kind}`);
    assert.equal((await GET(request())).status, 401);
    role = "expert";
    assert.equal((await GET(request())).status, 403);
    role = "admin";
    assert.equal((await GET(request("invalid"))).status, 400);
    missing = true;
    assert.equal((await GET(request())).status, 404);
    missing = false;
    for (const kind of ["paper", "answers"]) {
      const response = await GET(request(kind));
      assert.equal(response.status, 200);
      assert.match(response.headers.get("Content-Type")!, /wordprocessingml/);
      assert.match(response.headers.get("Content-Disposition")!, /attachment.*filename\*=UTF-8''/);
      assert.match(response.headers.get("Cache-Control")!, /no-store/);
      const { value } = await extractRawText({ buffer: Buffer.from(await response.arrayBuffer()) });
      assert.ok(value.includes(kind === "paper" ? "捐赠材料应规范留存" : "参考答案：正确"));
      if (kind === "paper") assert.ok(!value.includes("参考答案"));
    }
    assert.equal(audits.length, 2);
  } finally {
    if (previousAuth) require.cache[authPath] = previousAuth; else delete require.cache[authPath];
    if (previousDb) require.cache[dbPath] = previousDb; else delete require.cache[dbPath];
  }
});
