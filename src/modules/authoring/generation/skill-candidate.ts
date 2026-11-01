import { z } from "zod";
import { parseQuestions, type GeneratedQuestion } from "./contracts";
import type { AngleSource } from "./retry-policy";

export function parseModelJson(content: string): unknown {
  const text = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(text); }
  catch {
    const start = text.indexOf("{"), end = text.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("响应不是完整JSON对象，可能已截断；必须重新返回完整对象。");
    return JSON.parse(text.slice(start, end + 1));
  }
}

const text = z.string().trim().min(4).max(4000);
export const skillDesignSchema = z.object({
  scenario: text, materials: z.array(text).min(1).max(20),
  requirements: z.array(text).min(1).max(30), deliverables: z.array(text).min(1).max(20),
  steps: z.array(text).min(1).max(30), observations: z.array(text).min(1).max(30),
  sourceIds: z.array(z.string().trim()).min(1).max(12),
  difference: text,
});
export type SkillTaskDesign = z.infer<typeof skillDesignSchema>;

export function aliasedSources(sources: AngleSource[]) {
  return sources.map((source, index) => ({ ...source, id: `S${index + 1}` }));
}

export function resolveSkillSources(ids: string[], sources: AngleSource[]) {
  const aliases = aliasedSources(sources);
  const resolved = ids.map((id) => {
    const index = aliases.findIndex((source) => source.id === id);
    const source = sources.find((source) => source.id === id) ?? sources[index];
    if (!source) throw new Error(`sourceIds：未知来源编号“${id}”；只允许${aliases.map((item) => item.id).join("、")}，不得猜测映射。`);
    return source.id;
  });
  return [...new Set(resolved)];
}

export function parseSkillDesign(content: string, sources: AngleSource[]) {
  const design = skillDesignSchema.parse(parseModelJson(content));
  return { ...design, sourceIds: resolveSkillSources(design.sourceIds, sources) };
}

const weightedRubricSchema = z.object({
  totalScore: z.literal(100),
  criteria: z.array(z.object({
    item: z.string().trim().min(2).max(1000), standard: text,
    weight: z.number().finite().positive().max(10000),
    rationale: z.string().trim().min(4).max(2000),
  })).min(1).max(30),
});

export function calculateSkillRubric(value: unknown) {
  const weighted = weightedRubricSchema.parse(value);
  const total = weighted.criteria.reduce((sum, item) => sum + item.weight, 0);
  const allocations = weighted.criteria.map((item, index) => {
    const exact = item.weight / total * 10000;
    return { index, units: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  const remainder = 10000 - allocations.reduce((sum, item) => sum + item.units, 0);
  const ranked = [...allocations].sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let index = 0; index < remainder; index++) ranked[index].units++;
  if (allocations.some((item) => item.units <= 0)) throw new Error("weightedRubric.criteria：权重悬殊导致分值为0，请重新论证合理权重，不强行添加分值。");
  const rubric = { totalScore: 100, criteria: weighted.criteria.map((item, index) => ({
    item: item.item, standard: item.standard, score: allocations[index].units / 100,
  })) };
  return { rubric, calculation: { original: weighted, calculated: rubric, rule: "largest_remainder_0.01" as const } };
}

export function parseSkillCandidate(content: string, code: string, occupation: string) {
  const payload = parseModelJson(content) as { questions?: unknown[] };
  if (!Array.isArray(payload.questions) || payload.questions.length !== 1) throw new Error("questions：技能专项流程每次必须返回且仅返回1个候选。");
  const candidate = payload.questions[0];
  if (!candidate || typeof candidate !== "object") throw new Error("questions[0]：候选必须是对象。");
  const raw = candidate as Record<string, unknown>;
  let calculation: GeneratedQuestion["scoringCalculation"];
  let normalized = raw;
  if (raw.weightedRubric !== undefined) {
    try {
      const computed = calculateSkillRubric(raw.weightedRubric);
      calculation = computed.calculation;
      normalized = { ...raw, scoreRubric: computed.rubric };
    } catch (error) { throw new Error(`weightedRubric：${skillCandidateIssues(error).join("；")}`); }
  }
  const parsed = parseQuestions(JSON.stringify({ questions: [normalized] }), code, "practical", occupation);
  if (!parsed.valid.length) throw new Error(parsed.invalidReasons.join("；"));
  const question = parsed.valid[0];
  if (question.scoreRubric?.totalScore !== 100) throw new Error("scoreRubric.totalScore：本流程沿用100分制候选模板，不允许模型改变总分。");
  if (question.analysis.length < 4) throw new Error("analysis：解析至少4字，必须说明考核依据和评分说明，不能填充文字凑长度。");
  return { question: { ...question, scoringCalculation: calculation }, raw };
}

export function skillCandidateIssues(error: unknown) {
  return error instanceof z.ZodError
    ? error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    : [error instanceof Error ? error.message : "未知候选结构错误"];
}

export function skillRepairFields(issues: string[]) {
  const fields = new Set<string>();
  for (const issue of issues) {
    if (/stem|题干/.test(issue)) fields.add("stem");
    if (/answers|参考答案/.test(issue)) fields.add("answers");
    if (/analysis|解析/.test(issue)) fields.add("analysis");
    if (/weightedRubric|scoreRubric|评分|分值|权重/.test(issue)) fields.add("weightedRubric");
    if (/options|选项/.test(issue)) fields.add("options");
    if (/assessmentPointCode|代码/.test(issue)) fields.add("assessmentPointCode");
    if (/questionType|题型/.test(issue)) fields.add("questionType");
  }
  return [...fields];
}

export function applySkillPatch(response: string, patchResponse: string, fields: string[]) {
  const payload = parseModelJson(response) as { questions?: unknown[] };
  if (!Array.isArray(payload.questions) || payload.questions.length !== 1 || !payload.questions[0] || typeof payload.questions[0] !== "object") {
    throw new Error("原始候选不可定位，需修复完整JSON结构。");
  }
  const patch = parseModelJson(patchResponse) as { patch?: unknown };
  if (!patch.patch || typeof patch.patch !== "object" || Array.isArray(patch.patch)) throw new Error("patch：必须是对象。");
  const updates = patch.patch as Record<string, unknown>;
  if (!Object.keys(updates).length || Object.keys(updates).some((field) => !fields.includes(field))) {
    throw new Error(`patch：只能修复指定字段${fields.join("、")}，不得修改其他已正确内容。`);
  }
  return JSON.stringify({ ...payload, questions: [{ ...payload.questions[0], ...updates }] });
}
