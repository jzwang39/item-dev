import { questionTypes, type QuestionType, type Snapshot } from "./contracts";
import { generationQualityPolicy } from "./quality-policy";

export function theoryQuestionPrompt(snapshot: Snapshot, code: string, requested: QuestionType[], previous: unknown[],
  excerpts: unknown[], attempts: number, targeted: boolean) {
  const node = snapshot.nodes.find((item) => item.code === code);
  if (!node) throw new Error("理论任务缺少冻结考评点。");
  return {
    instruction: `你是职业技能理论知识试题编制助手。严格依据冻结考评点、关联标准依据及提供的教材片段编制中文试题草稿，覆盖指定题型和数量。
有教材时只能使用关联教材片段和标准依据；没有教材时以关联标准条目为考核范围，结合适用职业等级的通用专业知识出题。不得编造法律条款、数值标准或机构制度，资料不足不得凑题。
优先满足输入中的试题质量标准全部要求；题数优先按每个考评点、每种题型补齐，不能用总数抵消某种题型缺额。质量执行策略仅在补题时允许适度放宽知识角度独立性及多样性，优先于质量标准中同类多样性要求，其他要求继续遵守。
首轮优先不同知识要素；补题优先新知识，知识已覆盖时允许同一知识、不同考查任务，依据指定的任务区分出题。不能复制题干、只换词或语序、只换选项顺序或简单正反改写。答案正确、单选唯一解、依据真实、题干完整可答、符合考点与等级等底线不可放宽。
仅返回JSON：
{"questions":[{"assessmentPointCode":"指定考评点代码","questionType":"single","stem":"真实中文题干","options":[{"key":"A","content":"真实选项"}],"answers":["A"],"analysis":"答案依据解析"}]}。
严格按照本次题型配额生成缺额；mixed仅表示请求含多题型，绝不能作为questionType。
每条questionType只能是single、multiple或judgement，禁止中文题型值。
单选恰好4个不同选项和1个答案；多选选项数量遵循试题质量标准且至少4个不同选项、至少2个答案；答案键对应选项。
判断options必须为[]，answers必须为["正确"]或["错误"]，不能写true/false、对/错或A/B。答案、解析必须明确且符合知识依据。输出前自查质量标准，不符合时修正；无法保证正确性和真实依据时不得凑题。`,
    prompt: JSON.stringify({
      用户需求: snapshot.requirement, 职业: snapshot.scope.occupation, 等级: snapshot.scope.levelCode,
      考评点: { code: node.code, name: node.name },
      指定题型: targeted ? requested[0] : "mixed", 本次必须生成数: requested.length,
      本次题型配额: Object.fromEntries(questionTypes.map((type) => [type, requested.filter((item) => item === type).length])),
      质量要求: snapshot.qualityRequirements, 试题质量标准: snapshot.qualityStandard,
      质量执行策略: generationQualityPolicy("theory", targeted),
      冻结考评点与标准依据: node.theoryContext, 教材片段: excerpts,
      已有试题: previous, 补齐次数: attempts,
    }),
  };
}
