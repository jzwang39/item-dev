import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  bindStandardSkillRequirements, expandStandardSkillHierarchy, generateStandardSkillEntries, parseStandardSkillEntries, standardSkillBatches,
  type BoundSkillRequirement, type StandardSkillRequirement,
} from "./skill-standard-generation";
import { parseSkillStandard, type StandardScope } from "./skill-standard";
import { parseDirectionalTheoryWeights, parseStandardRequirements } from "./theory-weights/standard";
import { isSkillGenerationLevel, skillGenerationLevels, skillGenerationRule } from "./skill-generation-policy";

const scopes: StandardScope[] = ["level_5", "level_4"].map((levelCode) => ({
  column: { key: levelCode, levelCode, label: levelCode, direction: "通用" }, totalMinutes: null,
  rows: [{ code: "A", name: "加工", score: 100, minutes: null, selection: null, method: null }],
}));
const source = "1.1.1 能选择刀具\n1.1.2 能检查设备";
const requirements: StandardSkillRequirement[] = ["level_5", "level_4"].flatMap((levelCode) =>
  ["能选择刀具", "能检查设备"].map((name, index) => ({
    id: `${levelCode}-${index}`, levelCode, direction: "通用", functionCode: "1", functionName: "加工",
    contentCode: "1.1", contentName: "作业准备", code: `1.1.${index + 1}`, name,
    evidence: `1.1.${index + 1} ${name}`, blueprintVersionId: "standard", fileObjectId: "file", sourceVersionId: null,
  })),
);
const output = (items: BoundSkillRequirement[]) => JSON.stringify({
  completed: true, points: items.map((item) => ({
    requirementId: item.id, name: item.name.replace(/^能/, ""), importance: "X",
    evidence: "模型改写的假引用", scopeKey: "invalid", rowName: "invalid",
  })).reverse(),
});

test("同名技能要求在不同等级分别生成，逐条保留真实依据和父级", () => {
  const bound = bindStandardSkillRequirements(requirements, scopes, source);
  const points = parseStandardSkillEntries(output(bound), bound);
  assert.equal(points.length, 4);
  assert.deepEqual(points.map((point) => point.requirement.id), requirements.map((item) => item.id));
  assert.deepEqual(points.map((point) => point.scopeKey), ["level_5", "level_5", "level_4", "level_4"]);
  assert.equal(points[0].evidence, requirements[0].evidence);
  assert.equal(points[0].requirement.contentName, "作业准备");
  assert.equal(points[0].rowName, "加工");
});

test("真实原文不匹配、父级范围错位、来源重复及空等级均拒绝", () => {
  assert.throws(() => bindStandardSkillRequirements([{ ...requirements[0], evidence: "不存在的技能" }], scopes, source), /原文/);
  assert.throws(() => bindStandardSkillRequirements([{ ...requirements[0], functionName: "其他职业功能" }], scopes, source), /唯一对应/);
  assert.throws(() => bindStandardSkillRequirements([requirements[0], requirements[0]], scopes, source), /重复/);
  assert.throws(() => bindStandardSkillRequirements(requirements.slice(0, 2), scopes, source), /缺少技能要求/);
});

test("通用条目不能擅自复制到多个职业方向", () => {
  const directions = ["普通车床", "数控车床"].map((direction) => ({
    ...scopes[0], column: { ...scopes[0].column, key: direction, direction },
  }));
  assert.throws(() => bindStandardSkillRequirements(requirements.slice(0, 2), directions, source), /唯一对应/);
});

test("遗漏、重复、虚构编号、占位名称或截断结果都不能凑数发布", () => {
  const bound = bindStandardSkillRequirements(requirements, scopes, source);
  const payload = JSON.parse(output(bound));
  assert.throws(() => parseStandardSkillEntries(JSON.stringify({ ...payload, points: payload.points.slice(1) }), bound), /不得增减/);
  assert.throws(() => parseStandardSkillEntries(JSON.stringify({ ...payload, completed: false }), bound), /完整返回/);
  payload.points[0].requirementId = "fake";
  assert.throws(() => parseStandardSkillEntries(JSON.stringify(payload), bound), /不属于/);
  payload.points[0].requirementId = payload.points[1].requirementId;
  assert.throws(() => parseStandardSkillEntries(JSON.stringify(payload), bound), /多个/);
  const placeholder = JSON.parse(output(bound));
  placeholder.points[0].name = "鉴定点1";
  assert.throws(() => parseStandardSkillEntries(JSON.stringify(placeholder), bound), /占位/);
});

test("分批不切断条目、不混等级，每批最多6条且覆盖全部来源", () => {
  const bound = bindStandardSkillRequirements(requirements, scopes, source);
  const batches = standardSkillBatches([...bound, ...bound.map((item) => ({ ...item, id: `${item.id}-2` }))]);
  assert.ok(batches.every((batch) => batch.requirements.length <= 6 &&
    new Set(batch.requirements.map((item) => item.scopeKey)).size === 1));
  assert.equal(batches.flatMap((batch) => batch.requirements).length, 8);
});

test("每个二级和一级各增加一个综合点，保留三级，综合依据不跨父级或技能等级", () => {
  const bound = bindStandardSkillRequirements(requirements.map((item, index) => index % 2
    ? { ...item, contentCode: "1.2", contentName: "设备检查" } : item), scopes, source);
  const hierarchy = expandStandardSkillHierarchy(bound);
  assert.equal(hierarchy.length, 10);
  assert.equal(hierarchy.filter((item) => item.nodeKind === "skill_requirement").length, 4);
  assert.equal(hierarchy.filter((item) => item.nodeKind === "work_content").length, 4);
  assert.equal(hierarchy.filter((item) => item.nodeKind === "occupational_function").length, 2);
  const work = hierarchy.find((item) => item.levelCode === "level_5" && item.nodeKind === "work_content" && item.contentCode === "1.2")!;
  assert.equal(work.name, "设备检查");
  assert.deepEqual(work.contextRequirements?.map((item) => item.id), ["level_5-1"]);
  const fn = hierarchy.find((item) => item.levelCode === "level_5" && item.nodeKind === "occupational_function")!;
  assert.equal(fn.name, "加工");
  assert.equal(fn.contentName, "");
  assert.deepEqual(fn.contextRequirements?.map((item) => item.contentCode), ["1.1", "1.2"]);
  assert.ok(fn.contextRequirements?.every((item) => item.id.startsWith("level_5")));
  assert.equal(new Set(hierarchy.map((item) => item.id)).size, 10);
  assert.deepEqual(parseStandardSkillEntries(output(hierarchy), hierarchy).map((item) => item.requirement.nodeKind), hierarchy.map((item) => item.nodeKind));
});

test("不同职业功能的综合依据不能混合，合批仍保留独立生成单元", () => {
  const bound = bindStandardSkillRequirements(requirements, scopes, source);
  const second = bound.map((item) => ({
    ...item, id: `${item.id}-fn2`, functionCode: "2", functionName: "维护", rowName: "维护",
    contentCode: "2.1", contentName: "维护准备",
  }));
  const expanded = expandStandardSkillHierarchy([...bound, ...second]);
  const functions = expanded.filter((item) => item.nodeKind === "occupational_function");
  assert.equal(functions.length, 4);
  assert.ok(functions.every((fn) => fn.contextRequirements?.every((item) =>
    item.contentCode.startsWith(`${fn.functionCode}.`))));
  const batches = standardSkillBatches(expanded);
  assert.ok(batches.every((batch) => new Set(batch.requirements.map((item) => item.nodeKind)).size === 1));
  assert.equal(batches.flatMap((batch) => batch.requirements).length, expanded.length);
});

test("技能等级只生成五四三级，两种模式均使用新的三级范围规则", () => {
  assert.deepEqual(skillGenerationLevels, ["level_5", "level_4", "level_3"]);
  assert.equal(isSkillGenerationLevel("level_2"), false);
  assert.equal(isSkillGenerationLevel("level_1"), false);
  assert.equal(skillGenerationRule("model"), "standard_hierarchy_1to1");
  assert.equal(skillGenerationRule("textbook"), "knowledge_1to1_three_levels");
});

test("模型只转换名称和重要程度，校验失败重试时带入具体错误", async () => {
  const batches = standardSkillBatches(bindStandardSkillRequirements(requirements, scopes, source));
  let calls = 0;
  const generated = await generateStandardSkillEntries(batches[0], async (instruction, input) => {
    calls++;
    assert.match(instruction, /不要重新从全文提取/);
    const payload = JSON.parse(input);
    assert.equal(payload.技能要求.length, 2);
    if (calls === 2) assert.match(payload.上次校验错误, /不得增减/);
    return calls === 1 ? '{"completed":true,"points":[]}' : output(batches[0].requirements);
  });
  assert.equal(calls, 2);
  assert.equal(generated.length, 2);
  assert.equal(generated[0].evidence, requirements[0].evidence);
});

test("真实劝募员标准88条技能要求全部可核验，分别保留五个等级完整归属", async () => {
  const { extractPdfText } = await import("@/modules/documents/extraction/service");
  const { text } = await extractPdfText(await readFile("docs/测试真实数据/劝募员-标准（技能水平和理论知识&一级到五级）.pdf"));
  const skill = parseSkillStandard(text);
  const theory = parseDirectionalTheoryWeights(text, { name: "劝募员", code: "3-01-01-05", directions: [] });
  const parsed = parseStandardRequirements(text, theory);
  const items: StandardSkillRequirement[] = parsed.flatMap((scope) => scope.functions.flatMap((fn) =>
    fn.contents.flatMap((content) => content.requirements.filter((item) => item.kind === "skill_requirement").map((item) => ({
      id: `${scope.levelCode}:${fn.code}:${content.code}:${item.code}`, levelCode: scope.levelCode,
      direction: scope.directionName, functionCode: fn.code, functionName: fn.name,
      contentCode: content.code, contentName: content.name, code: item.code, name: item.name, evidence: item.evidence,
      blueprintVersionId: "real-standard", fileObjectId: "real-file", sourceVersionId: null,
    })))));
  const bound = bindStandardSkillRequirements(items, skill.scopes, text);
  assert.equal(bound.length, 88);
  assert.deepEqual(skill.scopes.map((scope) => bound.filter((item) => item.scopeKey === scope.column.key).length), [17, 17, 17, 18, 19]);
  for (const batch of standardSkillBatches(bound)) {
    assert.equal(parseStandardSkillEntries(output(batch.requirements), batch.requirements).length, batch.requirements.length);
  }
  const selected = bound.filter((item) => isSkillGenerationLevel(item.levelCode));
  const hierarchy = expandStandardSkillHierarchy(selected);
  const selectedScopes = parsed.filter((scope) => isSkillGenerationLevel(scope.levelCode));
  const expected = selected.length + selectedScopes.reduce((total, scope) =>
    total + scope.functions.length + scope.functions.reduce((sum, fn) => sum + fn.contents.length, 0), 0);
  assert.equal(selected.length, 51);
  assert.equal(hierarchy.length, expected);
  assert.ok(hierarchy.every((item) => isSkillGenerationLevel(item.levelCode)));
  console.log("真实标准三级层次生成数量：", skillGenerationLevels.map((level) => ({
    level, skills: hierarchy.filter((item) => item.levelCode === level && item.nodeKind === "skill_requirement").length,
    workContents: hierarchy.filter((item) => item.levelCode === level && item.nodeKind === "work_content").length,
    functions: hierarchy.filter((item) => item.levelCode === level && item.nodeKind === "occupational_function").length,
    total: hierarchy.filter((item) => item.levelCode === level).length,
  })));
  if (process.env.RUN_SKILL_STANDARD_REAL_MODEL === "1") {
    const { loadEnvConfig } = await import("@next/env");
    loadEnvConfig(process.cwd());
    const { callModel } = await import("./theory-outline-generation/service");
    const { getPool } = await import("@/shared/database/mysql");
    try {
      for (const kind of ["skill_requirement", "work_content", "occupational_function"]) {
        const batch = standardSkillBatches(hierarchy).find((batch) => batch.requirements[0].nodeKind === kind)!;
        const generated = await generateStandardSkillEntries(batch, callModel);
        assert.equal(generated.length, batch.requirements.length);
        assert.deepEqual(generated.map((point) => point.evidence), batch.requirements.map((item) => item.evidence));
        console.log(`真实模型验证通过：${kind} ${generated.length}个鉴定点；未写入业务数据库。`);
      }
    } finally { await getPool().end(); }
  }
});
