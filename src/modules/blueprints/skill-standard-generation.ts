import { z } from "zod";
import type { StandardScope } from "./skill-standard";
import type { SkillKnowledgeEntry } from "./skill-knowledge-extraction";
import type { ModelCaller } from "./theory-outline-generation/generation-batch";

export type StandardSkillRequirement = {
  id: string; levelCode: string; direction: string;
  functionId?: string; contentId?: string;
  functionCode: string; functionName: string; contentCode: string; contentName: string;
  code: string; name: string; evidence: string;
  blueprintVersionId: string; fileObjectId: string; sourceVersionId: string | null;
};
export type BoundSkillRequirement = StandardSkillRequirement & {
  scopeKey: string; rowName: string; locator: string;
  nodeKind?: "skill_requirement" | "work_content" | "occupational_function";
  contextRequirements?: Array<Pick<StandardSkillRequirement, "id" | "code" | "name" | "evidence" | "contentCode" | "contentName">>;
};
export type StandardSkillBatch = {
  chapterId: null; locator: string; text: string; requirements: BoundSkillRequirement[];
};
export type StandardSkillEntry = SkillKnowledgeEntry & { requirement: BoundSkillRequirement };
const normalize = (text: string) => text.normalize("NFKC").replace(/\s+/g, "");
const pointSchema = z.object({
  requirementId: z.string().min(1),
  name: z.string().trim().min(2).max(500).regex(/[\u4e00-\u9fff]/),
  importance: z.enum(["X", "Y", "Z"]),
});

export function bindStandardSkillRequirements(
  requirements: StandardSkillRequirement[], scopes: StandardScope[], original: string,
): BoundSkillRequirement[] {
  if (!requirements.length) throw new Error("当前标准没有已解析的技能要求条目，请先确认完整职业标准。");
  const source = normalize(original);
  const seen = new Set<string>();
  const bound = requirements.map((item) => {
    const label = `${item.levelCode} / ${item.direction} / ${item.functionName} / ${item.contentName} / ${item.code}`;
    if (seen.has(item.id)) throw new Error(`${label} 技能要求来源重复。`);
    seen.add(item.id);
    if (!item.evidence || !source.includes(normalize(item.evidence))) {
      throw new Error(`${label} 已解析技能要求与标准原文不一致，请重新核对标准解析结果。`);
    }
    const candidates = scopes.filter((scope) => scope.column.levelCode === item.levelCode &&
      (normalize(scope.column.direction) === normalize(item.direction) || item.direction === "通用") &&
      scope.rows.some((row) => normalize(row.name) === normalize(item.functionName)));
    if (candidates.length !== 1) throw new Error(`${label} 无法唯一对应技能等级、方向和职业功能，不生成错归属鉴定点。`);
    const scope = candidates[0], row = scope.rows.find((row) => normalize(row.name) === normalize(item.functionName))!;
    return { ...item, scopeKey: scope.column.key, rowName: row.name,
      locator: `${scope.column.label} / ${item.direction} / ${item.functionName} / ${item.contentName} / ${item.code} ${item.name}` };
  });
  for (const scope of scopes) {
    if (!bound.some((item) => item.scopeKey === scope.column.key)) throw new Error(`${scope.column.label} ${scope.column.direction}缺少技能要求，不发布空等级或方向。`);
  }
  return bound;
}

export function expandStandardSkillHierarchy(requirements: BoundSkillRequirement[]): BoundSkillRequirement[] {
  const functions = new Map<string, BoundSkillRequirement[]>();
  for (const item of requirements) {
    const key = `${item.scopeKey}:${item.functionId ?? item.functionCode}`;
    const group = functions.get(key) ?? [];
    group.push(item);
    functions.set(key, group);
  }
  const result: BoundSkillRequirement[] = [];
  for (const group of functions.values()) {
    const contents = new Map<string, BoundSkillRequirement[]>();
    for (const item of group) {
      const key = item.contentId ?? item.contentCode;
      const children = contents.get(key) ?? [];
      children.push(item);
      contents.set(key, children);
    }
    const composite = (children: BoundSkillRequirement[], kind: "work_content" | "occupational_function"): BoundSkillRequirement => {
      const first = children[0], isContent = kind === "work_content";
      const code = isContent ? first.contentCode : first.functionCode;
      const name = isContent ? first.contentName : first.functionName;
      const contextRequirements = children.map(({ id, code, name, evidence, contentCode, contentName }) =>
        ({ id, code, name, evidence, contentCode, contentName }));
      return {
        ...first, id: (isContent ? first.contentId : first.functionId) ??
          `${kind}:${first.blueprintVersionId}:${first.scopeKey}:${first.functionCode}:${isContent ? first.contentCode : ""}`,
        code, name, nodeKind: kind, contextRequirements,
        contentId: isContent ? first.contentId : undefined,
        contentCode: isContent ? first.contentCode : "", contentName: isContent ? first.contentName : "",
        evidence: `${code} ${name}\n${contextRequirements.map((item) =>
          `${item.contentCode} ${item.contentName}\n${item.evidence}`).join("\n")}`,
        locator: `${first.levelCode} / ${first.direction} / ${first.functionName}${isContent ? ` / ${name}` : ""} / ${isContent ? "二级工作内容综合" : "一级职业功能综合"}`,
      };
    };
    for (const children of contents.values()) {
      result.push(...children.map((item) => ({ ...item, nodeKind: "skill_requirement" as const })));
      result.push(composite(children, "work_content"));
    }
    result.push(composite(group, "occupational_function"));
  }
  if (new Set(result.map((item) => item.id)).size !== result.length) throw new Error("标准层级生成单元来源重复，无法逐项生成。");
  return result;
}

export function standardSkillBatches(requirements: BoundSkillRequirement[]): StandardSkillBatch[] {
  const batches: StandardSkillBatch[] = [];
  for (const item of requirements) {
    let batch = batches[batches.length - 1];
    if (!batch || batch.requirements.length === 6 || batch.requirements[0].scopeKey !== item.scopeKey ||
      batch.requirements[0].rowName !== item.rowName || batch.requirements[0].nodeKind !== item.nodeKind ||
      batch.text.length + item.evidence.length > 16000) {
      batch = { chapterId: null, locator: `${item.locator}起的标准条目`, text: "", requirements: [] };
      batches.push(batch);
    }
    batch.requirements.push(item);
    batch.text += `${item.evidence}\n`;
  }
  return batches;
}

export function parseStandardSkillEntries(content: string, requirements: BoundSkillRequirement[]): StandardSkillEntry[] {
  const payload = JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  const record = payload.data ?? payload;
  if (record.completed !== true || !Array.isArray(record.points) || record.points.length !== requirements.length) {
    throw new Error(`必须完整返回本批${requirements.length}个标准生成单元对应的鉴定点，不得增减。`);
  }
  const points = record.points.map((point: unknown) => pointSchema.parse(point));
  if (new Set(points.map((point: z.infer<typeof pointSchema>) => point.requirementId)).size !== requirements.length) {
    throw new Error("同一标准生成单元返回了多个鉴定点，或缺少来源条目。");
  }
  if (points.some((point: z.infer<typeof pointSchema>) => !requirements.some((item) => item.id === point.requirementId))) {
    throw new Error("返回了不属于本批标准的生成单元编号。");
  }
  return requirements.map((requirement) => {
    const point = points.find((point: z.infer<typeof pointSchema>) => point.requirementId === requirement.id)!;
    if (/^(?:考评点|鉴定点|知识点|测试|示例)\s*\d*$/u.test(point.name)) throw new Error("返回了占位鉴定点名称。");
    // AI cannot alter the frozen original, level, direction, or parent path.
    return { name: point.name, importance: point.importance, scopeKey: requirement.scopeKey,
      rowName: requirement.rowName, knowledgeName: requirement.name, evidence: requirement.evidence, requirement };
  });
}

export async function generateStandardSkillEntries(batch: StandardSkillBatch, model: ModelCaller) {
  const instruction = `你是国家职业标准操作技能鉴定点编制专家。
输入已由后台逐条核验，是独立的标准生成单元及其技能等级、方向和完整工作要求层级。不要重新从全文提取条目。
每个生成单元只生成一个动宾结构的实操鉴定点名称，并评定重要程度X/Y/Z。
三级“技能要求”：保留原意，生成该条技能的具体实操鉴定点，不拆分或扩充。
二级“工作内容”：结合该工作内容下的全部技能要求，生成一个体现整体工作过程的综合实操鉴定点，不改写成单个子技能。
一级“职业功能”：结合其全部工作内容和技能要求，生成一个体现完整职业功能的综合实操鉴定点，不缩减到某个二级或三级条目。
这里只处理五级、四级、三级技能等级。一二三级工作要求层级不是技能等级。
不增添原文没有要求的工具、数值、制度或任务。不能合并或遗漏生成单元、为了题量扩充、调整技能等级或跨职业功能。不同等级的相同内容仍各自对应其本等级条目。
requirementId必须照抄输入。原文依据与归属由后台保存，无需返回或改写。
只返回JSON：{"completed":true,"points":[{"requirementId":"输入条目ID","name":"实操鉴定点名称","importance":"X"}]}。
必须一次返回本批全部条目，不得遗漏或返回占位名称。`;
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const output = await model(instruction, JSON.stringify({
        来源位置: batch.locator, 必须生成鉴定点数: batch.requirements.length,
        技能要求: batch.requirements.map((item) => ({
          requirementId: item.id, 等级: item.levelCode, 方向: item.direction, 职业功能: item.functionName,
          工作内容: item.contentName, 标准编号: item.code, 技能要求: item.name,
          工作要求层级: item.nodeKind === "occupational_function" ? "一级职业功能综合"
            : item.nodeKind === "work_content" ? "二级工作内容综合" : "三级技能要求",
          原文依据: item.evidence, 下属技能要求: item.contextRequirements,
        })),
        上次校验错误: lastError || undefined,
      }), 0);
      return parseStandardSkillEntries(output, batch.requirements);
    } catch (error) { lastError = error instanceof Error ? error.message : "模型调用失败"; }
  }
  throw new Error(`${batch.locator}鉴定点生成失败：${lastError}`);
}
