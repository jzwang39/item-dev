import assert from "node:assert/strict";
import test from "node:test";
import type { PoolConnection } from "mysql2/promise";
import { assertFrozenPlanBasis, theoryPointContext } from "./plan-basis";
import type { Scope } from "./contracts";
import { findPlanOccupation } from "../requirement-parser";

const scope: Scope = {
  occupationId: "occupation", occupation: "劝募员", assessmentMode: "理论知识", levelCode: "level_5",
  blueprintVersions: { outline: { id: "outline", versionNo: 2 }, weights: { id: "weight", versionNo: 3 } },
};
function mock(validOccupation = true, invalidKind = "") {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const db = { execute: async (sql: string, values: unknown[]) => {
    calls.push({ sql, values });
    if (sql.includes("SELECT po.id")) return [validOccupation ? [{ id: "occupation" }] : [], []];
    return [values[4] === invalidKind ? [] : [{ version_no: values[4] === "theory_weight" ? 3 : 2 }], []];
  } } as unknown as PoolConnection;
  return { db, calls };
}
test("冻结版本严格按项目职业模式和等级查询，不随当前版本改变", async () => {
  const { db, calls } = mock();
  await assertFrozenPlanBasis(db, "project", scope);
  assert.deepEqual(calls[1].values, ["outline", "project", "occupation", "theory", "theory_outline", "level_5"]);
  assert.deepEqual(calls[2].values, ["weight", "project", "occupation", "theory", "theory_weight"]);
  assert.ok(calls.every((call) => !call.sql.includes("current_version_id")));
});
test("项目职业停用、跨范围或版本号不符均阻止启动", async () => {
  await assert.rejects(assertFrozenPlanBasis(mock(false).db, "project", scope), /已停用/);
  await assert.rejects(assertFrozenPlanBasis(mock(true, "theory_outline").db, "project", scope), /不一致/);
  await assert.rejects(assertFrozenPlanBasis(mock().db, "project", {
    ...scope, blueprintVersions: { ...scope.blueprintVersions, outline: { id: "outline", versionNo: 99 } },
  }), /不一致/);
});
test("技能冻结结构使用技能模式，缺少结构不允许执行", async () => {
  const skill: Scope = { ...scope, assessmentMode: "操作技能",
    blueprintVersions: { ...scope.blueprintVersions, structure: { id: "structure", versionNo: 2 } } };
  const { db, calls } = mock();
  await assertFrozenPlanBasis(db, "project", skill);
  assert.deepEqual(calls[3].values, ["structure", "project", "occupation", "skill", "skill_structure", "level_5"]);
  await assert.rejects(assertFrozenPlanBasis(mock().db, "project", { ...skill, blueprintVersions: scope.blueprintVersions }), /缺少/);
});
test("理论考评点及标准原文完整保留，不替换为模型编造依据", () => {
  const requirement = { standardSource: { name: "资料归档要求", evidence: "正式标准条目原文" }, sectionKind: "related_knowledge" };
  const source = { chapterIds: ["chapter"], standardBasicSource: { evidence: "公共基本要求原文" } };
  assert.deepEqual(theoryPointContext(JSON.stringify(requirement), JSON.stringify(source)), { point: requirement, source });
  assert.deepEqual(theoryPointContext(null, null), { point: null, source: null });
});
test("职业精确匹配优先，模糊匹配必须唯一，不按列表顺序误选", () => {
  const occupations = [{ name: "车工" }, { name: "汽车维修工" }];
  assert.equal(findPlanOccupation(occupations, "车工"), occupations[0]);
  assert.equal(findPlanOccupation(occupations, "汽车维修"), occupations[1]);
  assert.throws(() => findPlanOccupation(occupations, "工"), /多个职业/);
  assert.equal(findPlanOccupation(occupations, "劝募员"), undefined);
});
