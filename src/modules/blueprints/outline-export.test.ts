import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import type { PoolConnection } from "mysql2/promise";
import { buildOutlineWorkbook, buildOutlineWorkbookPackage, exportConfirmedOutline, type ExportPoint } from "./outline-export";

const point: ExportPoint = {
  id: "N".repeat(26),
  code: "A-A-A-A-A-A-001", name: "职业道德的含义", importance: "medium",
  requirement: {
    primaryNo: "A", primaryName: "基本要求", primaryWeight: 25,
    secondaryNo: "A-A", secondaryName: "职业道德", secondaryWeight: 5,
    tertiaryNo: "A-A-A", tertiaryName: "职业道德基本知识", tertiaryWeight: 3,
    importanceCode: "X", textbookPage: "1.1.1-20",
  },
};
test("12列表头、样例样式、层级合并与字符串序号可读回", async () => {
  const workbook = buildOutlineWorkbook([point, { ...point, code: "A-A-A-002", name: "第二点" }]);
  const restored = new ExcelJS.Workbook();
  await restored.xlsx.load(await workbook.xlsx.writeBuffer());
  const sheet = restored.worksheets[0];
  assert.equal(sheet.name, "评价要素细目表");
  assert.equal(sheet.columnCount, 12);
  assert.equal(sheet.rowCount, 3);
  assert.equal(sheet.getCell("A1").value, "一级");
  assert.equal(sheet.getCell("L1").value, "重要程度");
  assert.equal(sheet.getColumn(11).width, 38);
  assert.equal(sheet.getRow(1).height, 26);
  assert.equal(sheet.getRow(2).height, 18);
  assert.equal(sheet.getCell("A1").font.name, "宋体");
  assert.deepEqual(sheet.getCell("A1").fill, { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9E1F2" } });
  assert.equal(sheet.getCell("J2").value, "001");
  assert.equal(sheet.getCell("L2").value, "X");
  for (const column of ["A", "B", "C", "D", "E", "F", "G", "H", "I"]) {
    assert.equal(sheet.getCell(`${column}3`).master.address, `${column}2`);
  }
  assert.equal(sheet.views[0].state, "frozen");
  assert.equal(sheet.pageSetup.printArea, "A1:L3");
});

test("理论知识导出按模板重建相关知识层级并去掉名称编号前缀", async () => {
  const workbook = buildOutlineWorkbook([
    {
      code: "RAW-001",
      name: "募捐工作的含义",
      importance: "critical",
      requirement: {
        primaryNo: "B",
        primaryName: "相关知识要求 · 公益慈善宣讲",
        primaryWeight: 20,
        secondaryNo: "C",
        secondaryName: "理念宣传",
        tertiaryNo: "Z",
        tertiaryName: "1.1.1 募捐工作基本内容",
        importanceCode: "X",
        sectionKind: "related_knowledge",
        standardSource: { functionName: "公益慈善宣讲", contentName: "理念宣传" },
      },
    },
    {
      code: "RAW-002",
      name: "职业道德的特殊性",
      importance: "high",
      requirement: {
        primaryNo: "A",
        primaryName: "基本要求",
        secondaryNo: "A",
        secondaryName: "职业道德",
        secondaryWeight: 5,
        tertiaryNo: "A",
        tertiaryName: "31. 职业道德基本知识",
        importanceCode: "Y",
      },
    },
  ], { normalizeTheoryHierarchy: true });
  const restored = new ExcelJS.Workbook();
  await restored.xlsx.load(await workbook.xlsx.writeBuffer());
  const sheet = restored.worksheets[0];
  const row2 = Array.from(sheet.getRow(2).values as unknown[]).slice(1, 13);
  const row3 = Array.from(sheet.getRow(3).values as unknown[]).slice(1, 13);
  assert.equal(sheet.getColumn(11).width, 49);
  assert.deepEqual(row2, ["A", "相关知识要求", 20, "A", "公益慈善宣讲", "", "A", "理念宣传", "", "001", "募捐工作的含义", "X"]);
  assert.deepEqual(row3, ["B", "基本要求", "", "A", "职业道德", 5, "A", "职业道德基本知识", "", "001", "职业道德的特殊性", "Y"]);
});

test("理论知识二级三级编号按父级从A重新开始，相关知识一级名称跨权重合并", async () => {
  const workbook = buildOutlineWorkbook([
    {
      code: "R-001",
      name: "考评点1",
      importance: "critical",
      requirement: {
        primaryName: "基本要求",
        secondaryName: "基础知识",
        secondaryWeight: 20,
        tertiaryName: "31. 慈善文化与事业发展概况",
        importanceCode: "X",
      },
    },
    {
      code: "R-002",
      name: "考评点2",
      importance: "critical",
      requirement: {
        primaryName: "基本要求",
        secondaryName: "基础知识",
        secondaryWeight: 20,
        tertiaryName: "32. 慈善组织管理基本知识",
        importanceCode: "X",
      },
    },
    {
      code: "R-003",
      name: "考评点3",
      importance: "critical",
      requirement: {
        primaryName: "相关知识要求 · 公益慈善宣讲",
        primaryWeight: 20,
        secondaryName: "理念宣传",
        tertiaryName: "1.1.1 募捐工作基本内容",
        sectionKind: "related_knowledge",
        standardSource: { functionName: "公益慈善宣讲", contentName: "理念宣传" },
        importanceCode: "X",
      },
    },
    {
      code: "R-004",
      name: "考评点4",
      importance: "critical",
      requirement: {
        primaryName: "相关知识要求 · 款物募集",
        primaryWeight: 30,
        secondaryName: "方案策划",
        tertiaryName: "2.2.1 募捐活动策划基础",
        sectionKind: "related_knowledge",
        standardSource: { functionName: "款物募集", contentName: "方案策划" },
        importanceCode: "X",
      },
    },
  ], { normalizeTheoryHierarchy: true });
  const restored = new ExcelJS.Workbook();
  await restored.xlsx.load(await workbook.xlsx.writeBuffer());
  const sheet = restored.worksheets[0];
  assert.equal(sheet.getCell("D2").value, "A");
  assert.equal(sheet.getCell("G2").value, "A");
  assert.equal(sheet.getCell("G3").value, "B");
  assert.equal(sheet.getCell("D4").value, "A");
  assert.equal(sheet.getCell("G4").value, "A");
  assert.equal(sheet.getCell("B5").master.address, "B4");
  assert.equal(sheet.getCell("A5").master.address, "A4");
  assert.equal(sheet.getCell("C4").isMerged, false);
  assert.equal(sheet.getCell("C5").isMerged, false);
  assert.equal(sheet.getCell("F5").isMerged, false);
});

test("权重列空值也随层级合并，避免模板格式断开", async () => {
  const workbook = buildOutlineWorkbook([
    {
      code: "P-001",
      name: "点1",
      importance: "critical",
      requirement: {
        primaryName: "基本要求",
        secondaryName: "职业道德",
        secondaryWeight: 5,
        tertiaryName: "职业道德基本知识",
        importanceCode: "X",
      },
    },
    {
      code: "P-002",
      name: "点2",
      importance: "critical",
      requirement: {
        primaryName: "基本要求",
        secondaryName: "职业道德",
        secondaryWeight: 5,
        tertiaryName: "职业守则",
        importanceCode: "X",
      },
    },
    {
      code: "P-003",
      name: "点3",
      importance: "critical",
      requirement: {
        primaryName: "相关知识要求 · 公益慈善宣讲",
        primaryWeight: 20,
        secondaryName: "理念宣传",
        tertiaryName: "募捐工作基本内容",
        sectionKind: "related_knowledge",
        standardSource: { functionName: "公益慈善宣讲", contentName: "理念宣传" },
        importanceCode: "X",
      },
    },
    {
      code: "P-004",
      name: "点4",
      importance: "critical",
      requirement: {
        primaryName: "相关知识要求 · 公益慈善宣讲",
        primaryWeight: 20,
        secondaryName: "理念宣传",
        tertiaryName: "募捐沟通要点",
        sectionKind: "related_knowledge",
        standardSource: { functionName: "公益慈善宣讲", contentName: "理念宣传" },
        importanceCode: "X",
      },
    },
  ], { normalizeTheoryHierarchy: true });
  const restored = new ExcelJS.Workbook();
  await restored.xlsx.load(await workbook.xlsx.writeBuffer());
  const sheet = restored.worksheets[0];
  assert.equal(sheet.getCell("C3").master.address, "C2");
  assert.equal(sheet.getCell("F3").master.address, "F2");
  assert.equal(sheet.getCell("F5").master.address, "F4");
  assert.equal(sheet.getCell("I5").master.address, "I4");
  assert.equal(sheet.getCell("C4").value, 20);
  assert.equal(sheet.getCell("F4").value, "");
});

test("理论知识考评点序号按导出后的展示三级范围连续编号", async () => {
  const workbook = buildOutlineWorkbook([
    {
      code: "B-C-Z-001",
      name: "公益慈善政策法规宣讲要点的含义",
      importance: "critical",
      requirement: {
        primaryName: "相关知识要求 · 公益慈善宣讲",
        primaryWeight: 20,
        secondaryName: "政策宣讲",
        tertiaryName: "2.1.1 公益慈善政策法规宣讲要点",
        sectionKind: "related_knowledge",
        standardSource: { functionName: "公益慈善宣讲", contentName: "政策宣讲" },
        importanceCode: "X",
      },
    },
    {
      code: "B-C-AA-001",
      name: "公益慈善政策法规宣讲要点的构成要素",
      importance: "high",
      requirement: {
        primaryName: "相关知识要求 · 公益慈善宣讲",
        primaryWeight: 20,
        secondaryName: "政策宣讲",
        tertiaryName: "2.1.2 公益慈善政策法规宣讲实施",
        sectionKind: "related_knowledge",
        standardSource: { functionName: "公益慈善宣讲", contentName: "政策宣讲" },
        importanceCode: "Y",
      },
    },
    {
      code: "B-C-AB-001",
      name: "公益慈善政策法规宣讲要点的确定原则",
      importance: "critical",
      requirement: {
        primaryName: "相关知识要求 · 公益慈善宣讲",
        primaryWeight: 20,
        secondaryName: "政策宣讲",
        tertiaryName: "2.1.3 公益慈善政策法规宣讲方法",
        sectionKind: "related_knowledge",
        standardSource: { functionName: "公益慈善宣讲", contentName: "政策宣讲" },
        importanceCode: "X",
      },
    },
  ], { normalizeTheoryHierarchy: true });
  const restored = new ExcelJS.Workbook();
  await restored.xlsx.load(await workbook.xlsx.writeBuffer());
  const sheet = restored.worksheets[0];
  assert.equal(sheet.getCell("H2").value, "政策宣讲");
  assert.equal(sheet.getCell("H3").master.address, "H2");
  assert.equal(sheet.getCell("H4").master.address, "H2");
  assert.equal(sheet.getCell("J2").value, "001");
  assert.equal(sheet.getCell("J3").value, "002");
  assert.equal(sheet.getCell("J4").value, "003");
});

test("理论知识导出同时生成按版本保存所需的编码映射", () => {
  const exported = buildOutlineWorkbookPackage([
    {
      id: "A".repeat(26),
      code: "SRC-001",
      name: "职业道德的特殊性",
      importance: "critical",
      requirement: {
        primaryName: "基本要求",
        secondaryName: "职业道德",
        secondaryWeight: 5,
        tertiaryName: "31. 职业道德基本知识",
        importanceCode: "X",
      },
    },
    {
      id: "B".repeat(26),
      code: "SRC-002",
      name: "社会主义职业道德的强制性与自觉性",
      importance: "high",
      requirement: {
        primaryName: "基本要求",
        secondaryName: "职业道德",
        secondaryWeight: 5,
        tertiaryName: "31. 职业道德基本知识",
        importanceCode: "Y",
      },
    },
  ], { normalizeTheoryHierarchy: true });
  assert.deepEqual(exported.mappings, [
    {
      blueprintNodeId: "A".repeat(26),
      sourcePointCode: "SRC-001",
      exportPointCode: "A-A-A-001",
      pointName: "职业道德的特殊性",
    },
    {
      blueprintNodeId: "B".repeat(26),
      sourcePointCode: "SRC-002",
      exportPointCode: "A-A-A-002",
      pointName: "社会主义职业道德的强制性与自觉性",
    },
  ]);
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
    if (sql.includes("FROM blueprint_nodes")) return [[point, { ...point, id: "M".repeat(26), code: "002" }], []];
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
  assert.equal(calls.filter((call) => call.sql.includes("DELETE FROM theory_outline_export_mappings")).length, 2);
  assert.equal(calls.filter((call) => call.sql.includes("INSERT INTO theory_outline_export_mappings")).length, 2);
  assert.equal(calls.filter((call) => call.sql.includes("FROM blueprint_nodes")).every((call) => call.values[0] === "historical-version"), true);
  assert.equal(calls.some((call) => /UPDATE|current_version_id/.test(call.sql.replace("FOR UPDATE", ""))), false);
});

test("专家无导出权限，查询数据库之前拦截", async () => {
  const { calls, transaction } = database();
  await assert.rejects(exportConfirmedOutline("version", "expert", "expert", transaction), /仅管理员/);
  assert.equal(calls.length, 0);
});
