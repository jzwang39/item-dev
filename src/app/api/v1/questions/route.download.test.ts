import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";

test("理论知识题库下载查询不生成非法逗号，并返回模板化 Excel", async () => {
  const authPath = require.resolve("../../../../auth");
  const dbPath = require.resolve("../../../../shared/database/mysql");
  const previousAuth = require.cache[authPath];
  const previousDb = require.cache[dbPath];
  const sqls: string[] = [];

  require.cache[authPath] = {
    id: authPath,
    filename: authPath,
    loaded: true,
    exports: {
      getVerifiedSession: async () => ({ user: { id: "A".repeat(26), role: "admin" } }),
    },
  } as NonNullable<typeof previousAuth>;

  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
      query: async (sql: string) => {
        sqls.push(sql);
        if (sql.includes("FROM project_occupations")) {
          return [{ project_id: "P".repeat(26), occupation_name: "劝募员", occupation_code: "000001" }];
        }
        if (sql.includes("FROM questions q")) {
          return [{
            question_no: "AI-001",
            question_type: "单项选择题",
            difficulty: null,
            alignment: "aligned",
            stem: "职业道德是从业人员在职业活动中应该遵循的（ ）。",
            content_json: { options: [
              { key: "A", content: "道德规范" },
              { key: "B", content: "行为准则" },
              { key: "C", content: "规章制度" },
              { key: "D", content: "基本要求" },
            ] },
            answer_json: { answers: ["B"] },
            score_rubric_json: null,
            analysis_text: "依据职业道德定义判断。",
            point_code: "A-A-A-001",
          }];
        }
        throw new Error(`unexpected sql: ${sql}`);
      },
      withTransaction: async () => {
        throw new Error("not expected");
      },
    },
  } as NonNullable<typeof previousDb>;

  try {
    const { GET } = await import("./route");
    const response = await GET(new Request(
      `http://localhost/api/v1/questions?view=download&occupationId=${"O".repeat(26)}&levelCode=level_5&assessmentMode=theory&file=question-bank`,
    ));
    assert.equal(response.status, 200);
    const sql = sqls.find((item) => item.includes("FROM questions q"));
    assert.ok(sql);
    assert.doesNotMatch(sql!, /AS point_code,\s+FROM questions q/);

    const workbook = new ExcelJS.Workbook();
    const bytes: any = new Uint8Array(await response.arrayBuffer());
    await workbook.xlsx.load(bytes);
    const sheet = workbook.worksheets[0];
    assert.equal(sheet.getCell("A1").value, "编号");
    assert.equal(sheet.getCell("A2").value, "AI-001");
    assert.equal(sheet.getCell("J2").value, "B");
  } finally {
    if (previousAuth) require.cache[authPath] = previousAuth; else delete require.cache[authPath];
    if (previousDb) require.cache[dbPath] = previousDb; else delete require.cache[dbPath];
  }
});
