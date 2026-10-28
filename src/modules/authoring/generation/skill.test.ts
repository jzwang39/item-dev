import assert from "node:assert/strict";
import test from "node:test";
import { buildBatches, parseQuestions, validateQuota, type Snapshot } from "./contracts";
import { practicalQuota } from "./quota";
import { skillQuestionPrompt } from "./skill-prompt";
import { validateSkillStructure } from "../skill-plan";

const point = { code: "D1-A-A-001", name: "募捐宣传资料准备", single: 0, multiple: 0, judgement: 0, practical: 1, total: 1 };
const question = {
  assessmentPointCode: point.code, questionType: "practical",
  stem: "根据提供的模拟募捐活动资料，完成宣传资料的准备工作，提交资料清单及整理后的宣传材料。",
  options: [], answers: ["核对模拟活动资料，确定所需宣传内容。", "整理宣传材料并提交清单。"], analysis: "依据资料准备技能要求，评价资料完整性和适用性。",
  scoreRubric: { totalScore: 100, criteria: [
    { item: "资料核对", score: 40, standard: "资料内容与题设活动一致，关键信息完整。" },
    { item: "材料整理", score: 60, standard: "分类清晰，宣传材料完整，提交成果可使用。" },
  ] },
};
test("操作技能默认每点1题，明确题量覆盖默认，不套用理论题型", () => {
  assert.equal(practicalQuota("生成操作技能试题", { single: 0, multiple: 0, judgement: 0 }).practical, 1);
  assert.equal(practicalQuota("每个考评点至少2道题", { single: 0, multiple: 0, judgement: 0, practical: 6 }).practical, 2);
  assert.equal(practicalQuota("每个鉴定点生成三道实操题", { single: 0, multiple: 0, judgement: 0 }).practical, 3);
  assert.throws(() => practicalQuota("每点1题", { single: 4, multiple: 0, judgement: 2 }), /不套用/);
  assert.throws(() => practicalQuota("每个考评点至少101道题", { single: 0, multiple: 0, judgement: 0 }), /1至100/);
});
test("技能27点共27实操题，超过100题自动分批，槽位完整", () => {
  const points = Array.from({ length: 227 }, (_, index) => ({ ...point, code: `D-${index}` }));
  validateQuota(points, "level_4", "操作技能");
  const batches = buildBatches(points);
  assert.deepEqual(batches.map((batch) => batch.target), [100, 100, 27]);
  assert.ok(batches.flatMap((batch) => batch.units).every((unit) => unit.slotTypes.join(",") === "practical"));
  assert.equal(buildBatches(points.slice(0, 27))[0].target, 27);
  assert.throws(() => validateQuota([point], "level_4"), /理论知识/);
  assert.throws(() => validateQuota([{ ...point, single: 1 }], "level_4", "操作技能"), /实操题/);
  assert.throws(() => validateQuota([point], "level_2", "操作技能"));
});
test("实操题必须具备参考步骤和总分一致的评分标准，不能替换为选择题", () => {
  const parse = (value: unknown) => parseQuestions(JSON.stringify({ questions: [value] }), point.code, "practical");
  assert.equal(parse(question).valid.length, 1);
  assert.deepEqual(parse(question).valid[0].answers, question.answers);
  assert.equal(parse({ ...question, scoreRubric: undefined }).valid.length, 0);
  assert.equal(parse({ ...question, scoreRubric: { ...question.scoreRubric, totalScore: 90 } }).valid.length, 0);
  assert.equal(parse({ ...question, questionType: "single" }).valid.length, 0);
  assert.equal(parse({ ...question, options: [{ key: "A", content: "答案选项" }] }).valid.length, 0);
  assert.equal(parse({ ...question, answers: ["A"] }).valid.length, 0);
});
test("内容结构匹配技能等级、方向和职业功能，不擅自使用其他方向", () => {
  const structure = { standardScopes: [{ column: { levelCode: "level_4", direction: "通用" }, rows: [{ name: "公益慈善宣讲", score: 100 }] }] };
  const node = { name: point.name, requirement_json: { direction: "通用", sourceStandardRequirement: { functionName: "公益慈善宣讲" } } };
  assert.equal(validateSkillStructure(structure, [node], "level_4").length, 1);
  assert.throws(() => validateSkillStructure(structure, [node], "level_3"), /内容结构/);
  assert.throws(() => validateSkillStructure(structure, [{ ...node, requirement_json: { direction: "其他方向" } }], "level_4"), /唯一对应/);
  assert.throws(() => validateSkillStructure({ rows: [{ name: "公益慈善宣讲", score: 20 }] }, [node], "level_4"), /100%/);
});
test("技能提示使用冻结来源和结构，保留综合层级，不虚构待核对时间", () => {
  const snapshot = {
    scope: { occupation: "劝募员", levelCode: "level_4" },
    nodes: [{ code: point.code, name: point.name, skillContext: { nodeKind: "occupational_function", evidence: "真实依据" } }],
    skillStructure: { totalMinutes: null }, qualityRequirements: [], qualityStandard: "通用质量要求",
    skillQualityStandard: "评分项须对应提交成果，每项给出可观察的评分依据。",
  } as unknown as Snapshot;
  const output = skillQuestionPrompt(snapshot, point.code, 1, ["已生成题干"]);
  assert.match(output.instruction, /一级职业功能综合点/);
  assert.match(output.instruction, /待核对/);
  assert.match(output.prompt, /真实依据/);
  assert.match(output.prompt, /已生成题干/);
  assert.equal(JSON.parse(output.prompt).操作技能试题质量标准, snapshot.skillQualityStandard);
  assert.equal(JSON.parse(output.prompt).试题质量标准, "通用质量要求");
  assert.match(output.instruction, /质量标准不得覆盖正式标准依据/);
  assert.equal(JSON.parse(skillQuestionPrompt({ ...snapshot, skillQualityStandard: undefined }, point.code, 1, []).prompt).操作技能试题质量标准, "");
  assert.throws(() => skillQuestionPrompt({ ...snapshot, skillStructure: undefined }, point.code, 1, []), /冻结/);
});

test("真实标准与模型：三级技能、二级综合、一级综合各生成一题，仅验证不入库", {
  skip: process.env.RUN_SKILL_QUESTION_REAL_MODEL !== "1",
}, async () => {
  const { loadEnvConfig } = await import("@next/env");
  loadEnvConfig(process.cwd());
  const { readFile } = await import("node:fs/promises");
  const { extractPdfText } = await import("@/modules/documents/extraction/service");
  const { parseSkillStandard } = await import("@/modules/blueprints/skill-standard");
  const { parseDirectionalTheoryWeights, parseStandardRequirements } = await import("@/modules/blueprints/theory-weights/standard");
  const { bindStandardSkillRequirements, expandStandardSkillHierarchy } = await import("@/modules/blueprints/skill-standard-generation");
  const { callModel } = await import("@/modules/blueprints/theory-outline-generation/service");
  const { getPool } = await import("@/shared/database/mysql");
  try {
    const { text } = await extractPdfText(await readFile("docs/测试真实数据/劝募员-标准（技能水平和理论知识&一级到五级）.pdf"));
    const standard = parseSkillStandard(text);
    const parsed = parseStandardRequirements(text, parseDirectionalTheoryWeights(text, { name: "劝募员", code: "3-01-01-05", directions: [] }));
    const scope = parsed.find((item) => item.levelCode === "level_4")!;
    const requirements = scope.functions.flatMap((fn) => fn.contents.flatMap((content) => content.requirements
      .filter((item) => item.kind === "skill_requirement").map((item) => ({
        id: `${fn.code}:${content.code}:${item.code}`, levelCode: scope.levelCode, direction: scope.directionName,
        functionCode: fn.code, functionName: fn.name, contentCode: content.code, contentName: content.name,
        code: item.code, name: item.name, evidence: item.evidence,
        blueprintVersionId: "verified-standard", fileObjectId: "verified-file", sourceVersionId: null,
      }))));
    const hierarchy = expandStandardSkillHierarchy(bindStandardSkillRequirements(requirements, standard.scopes.filter((item) => item.column.levelCode === "level_4"), text));
    for (const kind of ["skill_requirement", "work_content", "occupational_function"]) {
      const source = hierarchy.find((item) => item.nodeKind === kind)!;
      const snapshot = {
        requirement: "每个鉴定点1道实操题", scope: { occupation: "劝募员", levelCode: "level_4" },
        nodes: [{ code: source.id, name: source.name, skillContext: { sourceStandardRequirement: source } }],
        skillStructure: { standardScopes: standard.scopes.filter((item) => item.column.levelCode === "level_4") },
        qualityRequirements: ["答案准确", "评分可核验"], qualityStandard: "",
      } as unknown as Snapshot;
      const prompt = skillQuestionPrompt(snapshot, source.id, 1, []);
      const result = parseQuestions(await callModel(prompt.instruction, prompt.prompt, 0), source.id, "practical");
      assert.equal(result.valid.length, 1, result.invalidReasons.join("; "));
      assert.equal(result.valid[0].scoreRubric!.criteria.reduce((sum, item) => sum + item.score, 0), result.valid[0].scoreRubric!.totalScore);
      console.info(`真实技能试题模型验证通过：${kind}，参考步骤与评分标准完整，未写入业务数据。`);
    }
  } finally { await getPool().end(); }
});
