import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import type { PoolConnection } from "mysql2/promise";
import { buildOutlineWorkbook, exportConfirmedOutline, type ExportPoint } from "./outline-export";

const point: ExportPoint = {
  code: "A-A-A-A-A-A-001", name: "职业道德的含义", importance: "medium",
  requirement: {
    primaryNo: "A", primaryName: "基本要求", primaryWeight: 25,
    secondaryNo: "A-A", secondaryName: "职业道德", secondaryWeight: 5,
    tertiaryNo: "A-A-A", tertiaryName: "职业道德基本知识", tertiaryWeight: 3,
    importanceCode: "X", textbookPage: "1.1.1-20",
  },
};
test("13列表头、样例样式、层级合并与字符串序号可读回", async () => {
  const workbook = buildOutlineWorkbook([point, { ...point, code: "A-A-A-002", name: "第二点" }]);
  const restored = new ExcelJS.Workbook();
  await restored.xlsx.load(await workbook.xlsx.writeBuffer());
  const sheet = restored.worksheets[0];
  assert.equal(sheet.name, "评价要素细目表");
  assert.equal(sheet.columnCount, 13);
  assert.equal(sheet.rowCount, 3);
  assert.equal(sheet.getCell("A1").value, "一级");
  assert.equal(sheet.getCell("M1").value, "页码");
  assert.equal(sheet.getColumn(11).width, 38);
  assert.equal(sheet.getRow(1).height, 26);
  assert.equal(sheet.getRow(2).height, 18);
  assert.equal(sheet.getCell("A1").font.name, "宋体");
  assert.deepEqual(sheet.getCell("A1").fill, { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9E1F2" } });
  assert.equal(sheet.getCell("J2").value, "001");
  assert.equal(sheet.getCell("L2").value, "X");
  assert.equal(sheet.getCell("M2").value, "1.1.1-20");
  for (const column of ["A", "B", "C", "D", "E", "F", "G", "H", "I"]) {
    assert.equal(sheet.getCell(`${column}3`).master.address, `${column}2`);
  }
  assert.equal(sheet.views[0].state, "frozen");
  assert.equal(sheet.pageSetup.printArea, "A1:M3");
});

test("技能使用冻结层级、权重与重要度，不编造三级权重或页码", () => {
  const sheet = buildOutlineWorkbook([{
    code: "D1-A-B-007", name: "完成操作", importance: "critical",
    requirement: JSON.stringify({
      level1Code: "A", level1Name: "职业功能", level1Weight: 0,
      level2Code: "B", level2Name: "工作内容", level2Weight: 20,
      level3Code: "B", level3Name: "工作内容", importanceCode: "Y",
    }),
  }]).worksheets[0];
  assert.equal(sheet.getCell("C2").value, 0);
  assert.equal(sheet.getCell("F2").value, 20);
  assert.equal(sheet.getCell("I2").value, "");
  assert.equal(sheet.getCell("J2").value, "007");
  assert.equal(sheet.getCell("L2").value, "Y");
  assert.equal(sheet.getCell("M2").value, "");
});

test("不同父层级和不连续的同名层级不能跨组合并，空层级不合并", () => {
  const r = point.requirement as Record<string, unknown>;
  const rows = [
    point,
    { ...point, requirement: { ...r, primaryNo: "B" } },
    point,
    { ...point, requirement: {} },
    { ...point, requirement: {} },
  ];
  const sheet = buildOutlineWorkbook(rows).worksheets[0];
  assert.equal(sheet.getCell("D2").isMerged, false);
  assert.equal(sheet.getCell("D3").isMerged, false);
  assert.equal(sheet.getCell("D4").isMerged, false);
  assert.equal(sheet.getCell("A5").isMerged, false);
});

function database(total = 2, confirmed = 2, exists = true) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const db = { execute: async (sql: string, values: unknown[]) => {
    calls.push({ sql, values });
    if (sql.includes("FROM blueprint_versions")) return [exists ? [{
      projectId: "project", occupationName: "劝募员", levelCode: "level_5", assessmentMode: "theory", versionNo: 2,
    }] : [], []];
    if (sql.includes("COUNT(*)")) return [[{ total, confirmed }], []];
    if (sql.includes("FROM blueprint_nodes")) return [[point, { ...point, code: "002" }], []];
    return [[], []];
  } } as unknown as PoolConnection;
  const transaction = async <T>(run: (connection: PoolConnection) => Promise<T>) => run(db);
  return { calls, transaction };
}

test("未确认、部分确认、空版本和失效版本均不能导出或记录成功", async () => {
  for (const config of [[2, 0, true], [2, 1, true], [0, 0, true], [2, 2, false]] as const) {
    const { calls, transaction } = database(config[0], config[1], config[2]);
    await assert.rejects(exportConfirmedOutline("historical-version", "admin", "admin", transaction), /尚未全部|不存在/);
    assert.equal(calls.some((call) => call.sql.includes("INSERT INTO audit_logs")), false);
    assert.equal(calls.some((call) => call.sql.includes("ORDER BY ordinal")), false);
  }
});

test("历史已确认版本可重复导出，始终读指定版本，每次留痕且不修改确认状态", async () => {
  const { calls, transaction } = database();
  for (let index = 0; index < 2; index += 1) {
    const result = await exportConfirmedOutline("historical-version", "admin", "admin", transaction);
    assert.match(result.filename, /劝募员五级-理论知识-V2\.xlsx$/);
    assert.ok(result.bytes.length > 0);
  }
  assert.equal(calls.filter((call) => call.sql.includes("INSERT INTO audit_logs")).length, 2);
  assert.equal(calls.filter((call) => call.sql.includes("FROM blueprint_nodes")).every((call) => call.values[0] === "historical-version"), true);
  assert.equal(calls.some((call) => /UPDATE|current_version_id/.test(call.sql.replace("FOR UPDATE", ""))), false);
});

test("专家无导出权限，查询数据库之前拦截", async () => {
  const { calls, transaction } = database();
  await assert.rejects(exportConfirmedOutline("version", "expert", "expert", transaction), /仅管理员/);
  assert.equal(calls.length, 0);
});
