import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";

test("理论知识题库下载按考评点和题型导出最近配额内的题目", async () => {
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
          return [
            {
              question_no: "S-001",
              question_type: "单项选择题",
              difficulty: null,
              alignment: "aligned",
              stem: "单选1",
              content_json: { options: [{ key: "A", content: "A1" }, { key: "B", content: "B1" }] },
              answer_json: { answers: ["A"] },
              score_rubric_json: null,
              analysis_text: "解析1",
              point_code: "A-A-B-001",
              stored_at: "2026-01-01T00:00:00.000Z",
            },
            {
              question_no: "S-002",
              question_type: "单项选择题",
              difficulty: null,
              alignment: "aligned",
              stem: "单选2",
              content_json: { options: [{ key: "A", content: "A2" }, { key: "B", content: "B2" }] },
              answer_json: { answers: ["A"] },
              score_rubric_json: null,
              analysis_text: "解析2",
              point_code: "A-A-B-001",
              stored_at: "2026-01-02T00:00:00.000Z",
            },
            {
              question_no: "S-003",
              question_type: "单项选择题",
              difficulty: null,
              alignment: "aligned",
              stem: "单选3",
              content_json: { options: [{ key: "A", content: "A3" }, { key: "B", content: "B3" }] },
              answer_json: { answers: ["A"] },
              score_rubric_json: null,
              analysis_text: "解析3",
              point_code: "A-A-B-001",
              stored_at: "2026-01-03T00:00:00.000Z",
            },
            {
              question_no: "S-004",
              question_type: "单项选择题",
              difficulty: null,
              alignment: "aligned",
              stem: "单选4",
              content_json: { options: [{ key: "A", content: "A4" }, { key: "B", content: "B4" }] },
              answer_json: { answers: ["A"] },
              score_rubric_json: null,
              analysis_text: "解析4",
              point_code: "A-A-B-001",
              stored_at: "2026-01-04T00:00:00.000Z",
            },
            {
              question_no: "S-005",
              question_type: "单项选择题",
              difficulty: null,
              alignment: "aligned",
              stem: "单选5",
              content_json: { options: [{ key: "A", content: "A5" }, { key: "B", content: "B5" }] },
              answer_json: { answers: ["A"] },
              score_rubric_json: null,
              analysis_text: "解析5",
              point_code: "A-A-B-001",
              stored_at: "2026-01-05T00:00:00.000Z",
            },
            {
              question_no: "J-001",
              question_type: "判断题",
              difficulty: null,
              alignment: "aligned",
              stem: "判断1",
              content_json: { options: [] },
              answer_json: { answers: ["正确"] },
              score_rubric_json: null,
              analysis_text: "判断解析1",
              point_code: "A-A-B-001",
              stored_at: "2026-01-01T00:00:00.000Z",
            },
            {
              question_no: "J-002",
              question_type: "判断题",
              difficulty: null,
              alignment: "aligned",
              stem: "判断2",
              content_json: { options: [] },
              answer_json: { answers: ["正确"] },
              score_rubric_json: null,
              analysis_text: "判断解析2",
              point_code: "A-A-B-001",
              stored_at: "2026-01-02T00:00:00.000Z",
            },
            {
              question_no: "J-003",
              question_type: "判断题",
              difficulty: null,
              alignment: "aligned",
              stem: "判断3",
              content_json: { options: [] },
              answer_json: { answers: ["正确"] },
              score_rubric_json: null,
              analysis_text: "判断解析3",
              point_code: "A-A-B-001",
              stored_at: "2026-01-03T00:00:00.000Z",
            },
          ];
        }
        throw new Error(`unexpected sql: ${sql}`);
      },
      withTransaction: async (runner: (db: { execute: (sql: string) => Promise<unknown[]> }) => Promise<unknown>) => {
        const db = {
          execute: async (sql: string) => {
            if (sql.includes("FROM blueprints b INNER JOIN blueprint_nodes bn")) {
              return [[
                {
                  id: "N".repeat(26),
                  code: "A-A-B-001",
                  name: "示例考评点",
                  importance: "critical",
                  requirement: {
                    primaryName: "基本要求",
                    secondaryName: "职业道德",
                    secondaryWeight: 5,
                    tertiaryName: "职业守则",
                    importanceCode: "X",
                  },
                  sourceRef: null,
                  blueprint_version_id: "V".repeat(26),
                },
              ]];
            }
            if (sql.includes("FROM blueprint_version_sources bvs")) {
              return [[]];
            }
            if (sql.includes("DELETE FROM theory_outline_export_mappings")) {
              return [{ affectedRows: 0 }];
            }
            if (sql.includes("INSERT INTO theory_outline_export_mappings")) {
              return [{ affectedRows: 1 }];
            }
            throw new Error(`unexpected tx sql: ${sql}`);
          },
        };
        return runner(db);
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
    assert.match(sql!, /AS stored_at/);

    const workbook = new ExcelJS.Workbook();
    const bytes: any = new Uint8Array(await response.arrayBuffer());
    await workbook.xlsx.load(bytes);
    const sheet = workbook.worksheets[0];
    assert.equal(sheet.getCell("A1").value, "编号");
    assert.equal(sheet.rowCount, 7);
    assert.deepEqual(
      [2, 3, 4, 5, 6, 7].map((index) => [sheet.getCell(`A${index}`).value, sheet.getCell(`D${index}`).value, sheet.getCell(`E${index}`).value]),
      [
        ["A-A-B-001", "判断题", "判断3"],
        ["A-A-B-001", "判断题", "判断2"],
        ["A-A-B-001", "单项选择", "单选5"],
        ["A-A-B-001", "单项选择", "单选4"],
        ["A-A-B-001", "单项选择", "单选3"],
        ["A-A-B-001", "单项选择", "单选2"],
      ],
    );
  } finally {
    if (previousAuth) require.cache[authPath] = previousAuth; else delete require.cache[authPath];
    if (previousDb) require.cache[dbPath] = previousDb; else delete require.cache[dbPath];
  }
});
