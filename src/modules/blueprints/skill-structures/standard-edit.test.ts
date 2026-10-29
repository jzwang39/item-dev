import assert from "node:assert/strict";
import test from "node:test";
import type { StandardScope } from "../skill-standard";
import { applyStructureEdit, type StructureEdit } from "./standard-edit";

const scope: StandardScope = {
  column: { key: "level_4:通用", levelCode: "level_4", label: "四级/中级工", direction: "通用" },
  totalMinutes: null,
  assessmentRules: { minimumMinutes: 60, method: "现场操作、模拟操作", timeEvidence: "技能考核时间不少于60min", methodEvidence: null },
  rows: [
    { code: "S-001", name: "公益慈善宣讲", score: 30, minutes: null, selection: null, method: "现场操作、模拟操作" },
    { code: "S-002", name: "款物募集", score: 70, minutes: null, selection: null, method: "现场操作、模拟操作" },
  ],
};
const input: StructureEdit = {
  standardVersionId: "A".repeat(26), structureVersionId: "B".repeat(26), scopeKey: scope.column.key, totalMinutes: 60,
  rows: scope.rows.map((row) => ({ ...row, minutes: 30, selection: "必考", method: row.method! })),
};
test("管理员配置保存为新结构，不修改原始范围、权重或时长下限", () => {
  const edited = applyStructureEdit(scope, input);
  assert.equal(edited.totalMinutes, 60);
  assert.equal(edited.rows[0].selection, "必考");
  assert.equal(edited.assessmentRules?.minimumMinutes, 60);
  assert.equal(scope.rows[0].minutes, null);
  assert.equal(scope.totalMinutes, null);
});
test("拒绝时间低于原文下限、分项合计不符、跨方向及篡改权重", () => {
  assert.throws(() => applyStructureEdit(scope, { ...input, totalMinutes: 40, rows: input.rows.map((row) => ({ ...row, minutes: 20 })) }), /不得少于/);
  assert.throws(() => applyStructureEdit(scope, { ...input, totalMinutes: 90 }), /合计/);
  assert.throws(() => applyStructureEdit(scope, { ...input, scopeKey: "level_3" }), /范围/);
  assert.throws(() => applyStructureEdit(scope, { ...input, rows: input.rows.map((row) => ({ ...row, score: 50 })) }), /权重/);
  assert.throws(() => applyStructureEdit(scope, { ...input, rows: input.rows.slice(1) }), /范围/);
  assert.throws(() => applyStructureEdit(scope, { ...input, rows: input.rows.map((row) => ({ ...row, selection: "" })) } as unknown as StructureEdit));
  assert.throws(() => applyStructureEdit(scope, { ...input, rows: input.rows.map((row) => ({ ...row, minutes: 0 })) }));
});
