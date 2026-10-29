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

test("截图明确的劝募员名称优先于模型误返回的宽泛职业或其他职业", () => {
  const occupations = [{ name: "车工" }, { name: "汽车维修工" }, { name: "劝募员" }];
  const requirement = "请为劝募员五级/初级工生成理论知识试题，每个考评点至少4道单选题、2道判断题。";
  for (const aiName of ["工", "员", "车工", "劝募", " 劝募员 "]) {
    assert.equal(findPlanOccupation(occupations, aiName, requirement), occupations[2]);
  }
});

test("长职业名称内嵌短名称不误报多个，单独提及两者仍拦截", () => {
  const occupations = [{ name: "电工" }, { name: "建筑电工" }];
  assert.equal(findPlanOccupation(occupations, "电工", "为建筑电工生成试题"), occupations[1]);
  assert.throws(() => findPlanOccupation(occupations, "建筑电工", "为建筑电工和电工分别生成试题"), /多个职业/);
});

test("同名不同代码必须显式区分，不按顺序选择，并提示候选代码", () => {
  const occupations = [{ name: "劝募员", code: "4-13" }, { name: "劝募员", code: "LOCAL" }];
  assert.throws(() => findPlanOccupation(occupations, "劝募员", "为劝募员生成试题"), /同名职业记录.*4-13.*LOCAL/);
  assert.equal(findPlanOccupation(occupations, "劝募员", "为劝募员生成试题，职业代码：4-13"), occupations[0]);
  assert.equal(findPlanOccupation(occupations, "劝募员", "职业代码: LOCAL，生成试题"), occupations[1]);
  assert.throws(() => findPlanOccupation(occupations, "劝募员", "职业代码: MISSING，生成试题"), /不存在或已停用/);
});

test("职业名称与代码冲突时不允许以代码覆盖明确需求", () => {
  const occupations = [{ name: "劝募员", code: "LEGAL" }, { name: "车工", code: "TURNER" }];
  assert.throws(() => findPlanOccupation(occupations, "车工", "为劝募员命题，职业代码:TURNER"), /不一致/);
});

test("重复提及同一职业不视为多个职业，空模型名称不匹配全部职业", () => {
  const occupations = [{ name: "劝募员" }, { name: "车工" }];
  assert.equal(findPlanOccupation(occupations, "员", "劝募员理论命题，按劝募员标准生成"), occupations[0]);
  assert.equal(findPlanOccupation(occupations, "  "), undefined);
});
