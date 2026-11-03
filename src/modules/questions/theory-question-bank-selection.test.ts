import assert from "node:assert/strict";
import test from "node:test";
import { limitTheoryQuestionBankRows } from "./theory-question-bank-selection";

test("理论题库导出按考评点和题型保留最近的 4 道单选和 2 道判断", () => {
  const rows = limitTheoryQuestionBankRows([
    { pointCode: "A-A-B-001", questionType: "单项选择题", questionNo: "Q1", storedAt: "2026-01-01T00:00:00.000Z" },
    { pointCode: "A-A-B-001", questionType: "单项选择题", questionNo: "Q2", storedAt: "2026-01-02T00:00:00.000Z" },
    { pointCode: "A-A-B-001", questionType: "单项选择题", questionNo: "Q3", storedAt: "2026-01-03T00:00:00.000Z" },
    { pointCode: "A-A-B-001", questionType: "单项选择题", questionNo: "Q4", storedAt: "2026-01-04T00:00:00.000Z" },
    { pointCode: "A-A-B-001", questionType: "单项选择题", questionNo: "Q5", storedAt: "2026-01-05T00:00:00.000Z" },
    { pointCode: "A-A-B-001", questionType: "判断题", questionNo: "J1", storedAt: "2026-01-01T00:00:00.000Z" },
    { pointCode: "A-A-B-001", questionType: "判断题", questionNo: "J2", storedAt: "2026-01-02T00:00:00.000Z" },
    { pointCode: "A-A-B-001", questionType: "判断题", questionNo: "J3", storedAt: "2026-01-03T00:00:00.000Z" },
    { pointCode: "A-A-B-002", questionType: "单项选择题", questionNo: "Q6", storedAt: "2026-01-01T00:00:00.000Z" },
    { pointCode: "A-A-B-002", questionType: "判断题", questionNo: "J4", storedAt: "2026-01-01T00:00:00.000Z" },
  ]);

  assert.deepEqual(
    rows.map((row) => [row.pointCode, row.questionType, row.questionNo]),
    [
      ["A-A-B-001", "判断题", "J3"],
      ["A-A-B-001", "判断题", "J2"],
      ["A-A-B-001", "单项选择题", "Q5"],
      ["A-A-B-001", "单项选择题", "Q4"],
      ["A-A-B-001", "单项选择题", "Q3"],
      ["A-A-B-001", "单项选择题", "Q2"],
      ["A-A-B-002", "判断题", "J4"],
      ["A-A-B-002", "单项选择题", "Q6"],
    ],
  );
});
