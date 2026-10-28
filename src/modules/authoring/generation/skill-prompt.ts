import type { Snapshot } from "./contracts";

export function skillQuestionPrompt(snapshot: Snapshot, code: string, count: number, previous: string[]) {
  const node = snapshot.nodes.find((item) => item.code === code);
  if (!node?.skillContext || !snapshot.skillStructure) throw new Error("技能任务缺少冻结的标准依据或内容结构，不能生成。");
  return {
    instruction: `你是国家职业标准操作技能试题编制专家。依据冻结鉴定点、正式标准条目和内容结构编制中文实操题草稿，不生成单选、多选、判断题。
每题须包含可执行的任务情境、工作要求和可观察的提交成果；参考答案写操作步骤，评分项写可核验的表现及分值，各项之和须等于总分。
三级技能点考查该具体技能；二级工作内容综合点考查其全部下属技能的完整工作过程；一级职业功能综合点考查该职业功能的整体任务，不缩减成单个子技能。不得跨技能等级、方向或父级归属。
可为试题提供明确标注为“模拟题设”的材料，但不得编造国家标准、法律条文、强制工具、时间和阈值。时间、考核方式、选考规则未明确时保留“待核对”，不得声称是正式规定。
评分标准为建议草稿，须人工审定，不是国家标准原文。不要重复排除题干的任务内容。
仅返回JSON：{"questions":[{"assessmentPointCode":"指定代码","questionType":"practical","stem":"完整实操任务、工作要求和提交成果","options":[],"answers":["参考操作步骤"],"analysis":"考核依据和评分说明","scoreRubric":{"totalScore":100,"criteria":[{"item":"评分项目","score":100,"standard":"具体评分标准"}]}}]}。
answers使用完整步骤原文，不能使用选项键。每题必须有scoreRubric，各项分值之和必须等于totalScore。`,
    prompt: JSON.stringify({
      用户需求: snapshot.requirement, 职业: snapshot.scope.occupation, 技能等级: snapshot.scope.levelCode,
      鉴定点: { code: node.code, name: node.name }, 冻结标准与归属: node.skillContext,
      冻结内容结构: snapshot.skillStructure, 本次实操题数: count,
      质量要求: snapshot.qualityRequirements, 试题质量标准: snapshot.qualityStandard, 排除题干: previous,
    }),
  };
}
