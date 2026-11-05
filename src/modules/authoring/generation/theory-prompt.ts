import { questionTypes, type QuestionType, type Snapshot } from "./contracts";
import { generationQualityPolicy } from "./quality-policy";

type PromptEvidence = { id?: string; chapterId?: string; expansion?: unknown };

function partitionEvidence(excerpts: unknown[], hasTextbook: boolean) {
  const textbook: unknown[] = [];
  const standard: unknown[] = [];
  const expansion: unknown[] = [];
  for (const excerpt of excerpts) {
    const item = excerpt as PromptEvidence;
    if (item?.expansion) expansion.push(excerpt);
    else if (typeof item?.id === "string" && item.id.startsWith("standard:")) standard.push(excerpt);
    else if (typeof item?.id === "string" && item.id.startsWith("textbook:")) textbook.push(excerpt);
    else if (typeof item?.chapterId === "string") textbook.push(excerpt);
    else (hasTextbook ? textbook : standard).push(excerpt);
  }
  return { textbook, standard, expansion };
}

export function theoryQuestionPrompt(snapshot: Snapshot, code: string, requested: QuestionType[], previous: unknown[],
  excerpts: unknown[], attempts: number, targeted: boolean) {
  const node = snapshot.nodes.find((item) => item.code === code);
  if (!node) throw new Error("理论任务缺少冻结考评点。");
  const hasTextbook = Array.isArray(node.chapterIds) && node.chapterIds.length > 0;
  const evidence = partitionEvidence(excerpts, hasTextbook);
  const requestedType = requested[0] ?? "single";
  const principleRule = /基本原则/u.test(node.name)
    ? "\n若当前考评点是“基本原则”类，只能考原则判断、适用条件、行为辨析或职责边界；不得仅考术语定义、主体范围、概念列举或分类记忆。"
    : "";
  const example = requestedType === "judgement"
    ? `{"questions":[{"assessmentPointCode":"指定考评点代码","questionType":"judgement","stem":"真实中文判断题干","options":[],"answers":["正确"],"analysis":"答案依据解析"}]}`
    : requestedType === "multiple"
      ? `{"questions":[{"assessmentPointCode":"指定考评点代码","questionType":"multiple","stem":"真实中文题干","options":[{"key":"A","content":"真实选项"}],"answers":["A","B"],"analysis":"答案依据解析"}]}`
      : `{"questions":[{"assessmentPointCode":"指定考评点代码","questionType":"single","stem":"真实中文题干","options":[{"key":"A","content":"真实选项"}],"answers":["A"],"analysis":"答案依据解析"}]}`;
  const evidencePayload = hasTextbook
    ? {
        教材片段: evidence.textbook,
        ...(evidence.standard.length ? { 标准原文片段: evidence.standard } : {}),
        ...(evidence.expansion.length ? { 已核验扩展资料: evidence.expansion } : {}),
      }
    : {
        标准原文片段: evidence.standard,
        ...(evidence.expansion.length ? { 已核验扩展资料: evidence.expansion } : {}),
        ...(evidence.textbook.length ? { 关联教材片段: evidence.textbook } : {}),
      };
  return {
    instruction: `${snapshot.scope.commonGroupId ? "本次仅编制五级、四级、三级共用的基本要求题，三个等级共用同一题及审核版本，不按技术关联等级单独提高或降低考查要求。\n" : ""}你是职业技能理论知识试题编制助手。严格依据冻结考评点、关联标准依据及提供的原文依据编制中文试题草稿，覆盖指定题型和数量。
${hasTextbook ? "有教材时只能使用关联教材片段和标准依据；没有教材时不得把标准标题或模型常识当作正文依据。" : "当前考评点不关联教材，只能使用冻结标准依据、标准原文片段及已独立核验的扩展资料；不得把标准标题或模型常识当作正文依据。"}不得编造法律条款、数值标准或机构制度，资料不足不得凑题。
完整遵守输入中的试题质量标准全部要求；题数按每个考评点、每种题型补齐，不能用总数抵消某种题型缺额。质量执行策略不得覆盖或放宽质量标准中的独立性、多样性或其他要求。
首轮优先不同知识要素；补题优先新知识，仅在完整标准允许时采用同一知识、不同考查任务。不能复制题干、只换词或语序、只换选项顺序或简单正反改写。答案正确、单选唯一解、依据真实、题干完整可答、符合考点与等级等底线不可放宽。
单选题若使用填空式题干，括号必须写成半角(　　)，不能写全角（　　）。题干已出现正确项核心概念或名称时，不得再把该概念名称本身设为空或作为正确项词面回填，必须改考含义、特征、功能归属、职责边界或关键要素。
${principleRule}
仅返回JSON：
${example}。
严格按照本次题型配额生成缺额；mixed仅表示请求含多题型，绝不能作为questionType。
每条questionType只能是single、multiple或judgement，禁止中文题型值。
单选恰好4个不同选项和1个答案；多选选项数量遵循试题质量标准且至少4个不同选项、至少2个答案；答案键对应选项。
判断options必须为[]，answers必须为["正确"]或["错误"]，不能写true/false、对/错或A/B。答案、解析必须明确且符合知识依据。输出前自查质量标准，不符合时修正；无法保证正确性和真实依据时不得凑题。
确保JSON格式完全正确，特别是字符串内的双引号必须转义为\\"。必须包含题干(stem)、选项(options)、答案(answers)和解析(analysis)等完整字段。`,
    prompt: JSON.stringify({
      用户需求: snapshot.requirement, 职业: snapshot.scope.occupation, 等级: snapshot.scope.commonGroupId ? "五级、四级、三级共用基本要求" : snapshot.scope.levelCode,
      考评点: { code: node.code, name: node.name },
      指定题型: requested.every((item) => item === requested[0]) ? requested[0] : "mixed", 本次必须生成数: requested.length,
      本次题型配额: Object.fromEntries(questionTypes.map((type) => [type, requested.filter((item) => item === type).length])),
      质量要求: snapshot.qualityRequirements, 试题质量标准: snapshot.qualityStandard,
      质量执行策略: generationQualityPolicy("theory", targeted),
      冻结考评点与标准依据: node.theoryContext,
      ...evidencePayload,
      已有试题: previous.map((question) => {
        const item = question as { stem?: string; content?: unknown; answer?: unknown; analysis?: string | null };
        return targeted ? { stem: item.stem } : { stem: item.stem, content: item.content, answer: item.answer, analysis: item.analysis };
      }), 补齐次数: attempts,
    }),
  };
}

export function lowBasisTheoryDraftPrompt(snapshot: Snapshot, code: string, requested: QuestionType[], previous: unknown[],
  attempts: number, titleContext: string) {
  const node = snapshot.nodes.find((item) => item.code === code);
  if (!node) throw new Error("理论任务缺少冻结考评点。");
  const requestedType = requested[0] ?? "single";
  const example = requestedType === "judgement"
    ? `{"questions":[{"assessmentPointCode":"指定考评点代码","questionType":"judgement","stem":"真实中文判断题干","options":[],"answers":["正确"],"analysis":"[标题相关草稿] 仅依据标题范围起草，待人工补充来源摘录后再审定。"}]}`
    : `{"questions":[{"assessmentPointCode":"指定考评点代码","questionType":"single","stem":"真实中文题干","options":[{"key":"A","content":"真实选项"}],"answers":["A"],"analysis":"[标题相关草稿] 仅依据标题范围起草，待人工补充来源摘录后再审定。"}]}`;
  return {
    instruction: `你是职业技能理论知识试题起草助手。本次处于“标题相关草稿模式”，只能依据冻结考评点标题及模块上下文起草待人工核查的中文草稿，不得冒充已有可核验正文，不得编造法律条款、数值标准、主体资格排他结论或具体制度细节。
本模式生成的题目仅供人工补充依据和修订，必须在解析开头明确标注“[标题相关草稿]”。若题干需要精确事实、数值、主体边界或正式定义，但标题上下文不足以支持，请返回questions=[]，不要强行凑题。
只允许生成single或judgement，不生成multiple、填空变体或任何需要多个明确事实共同支撑的题。单选题若使用填空式题干，括号必须写成半角(　　)，不能写全角（　　）。题干已出现正确项核心概念或名称时，不得再把该概念名称本身设为空或作为正确项词面回填。
仅返回JSON：
${example}。`,
    prompt: JSON.stringify({
      用户需求: snapshot.requirement,
      职业: snapshot.scope.occupation,
      等级: snapshot.scope.commonGroupId ? "五级、四级、三级共用基本要求" : snapshot.scope.levelCode,
      考评点: { code: node.code, name: node.name },
      指定题型: requested.every((item) => item === requested[0]) ? requested[0] : "mixed",
      本次必须生成数: requested.length,
      本次题型配额: Object.fromEntries(questionTypes.map((type) => [type, requested.filter((item) => item === type).length])),
      标题相关草稿模式: {
        已启用: true,
        标题范围: titleContext,
        要求: "仅依据标题和模块上下文起草，解析必须标注[标题相关草稿]，待人工补充来源摘录。",
      },
      冻结考评点与标准依据: node.theoryContext,
      质量要求: snapshot.qualityRequirements,
      已有试题: previous.map((question) => {
        const item = question as { stem?: string; content?: unknown; answer?: unknown; analysis?: string | null };
        return { stem: item.stem, content: item.content, answer: item.answer, analysis: item.analysis };
      }),
      补齐次数: attempts,
    }),
  };
}
