import { buildChapterExcerptPool, selectBatchExcerpts, type GenerationChapter } from "./generation-context";
import { parseModelOutput } from "./model-output";

type BatchOptions = {
  occupationName: string;
  levelCode: string;
  mode: "textbook" | "model";
  category: string;
  topic: string;
  weight: number;
  chapters: GenerationChapter[];
  batchIndex: number;
  batchCount: number;
  targetCount: number;
  reservedPointKeys: Set<string>;
  assessmentMode?: "theory" | "skill";
  context?: unknown;
};

export type ModelCaller = (instruction: string, prompt: string, temperature: number) => Promise<string>;

function isPlaceholderPointName(name: string) {
  return /^(?:考评点(?:名称)?|考核点(?:名称)?|知识点|测试|示例)\s*[-_（(]?\s*\d+\s*[）)]?$/u.test(name.trim());
}

export async function generateAssessmentBatch(options: BatchOptions, callModel: ModelCaller) {
  const { topic, targetCount } = options;
  const excerptPool = buildChapterExcerptPool(options.chapters, topic);
  const basis = options.mode === "textbook"
    ? "仅能依据本次给定教材片段生成考评点，名称必须是教材中可追溯的具体术语、操作流程、规范要求或能力对象"
    : "依据给定职业、技能等级及考评范围生成具体术语、操作流程、规范要求或能力对象的考评点";
  const skillInstruction = options.assessmentMode === "skill"
    ? "你是操作技能考评要素细目表编制专家。鉴定点必须是能通过实操考核的具体工作任务，名称采用动宾结构，禁止生成理论定义或知识记忆问题。二级考评范围已经给定，不得新增第三级范围；tertiaryName始终填写给定的二级考评范围。"
    : "你是职业技能理论知识考评要素细目表编制专家。";
  const instruction = `${skillInstruction}${basis}，且能独立考核。每个考评点只考核一个具体对象；把不同条件、操作步骤、凭证字段、责任、异常处理分别编制为独立考评点，不要反复生成宽泛的概念综述。禁止通过改名、加编号或更换三级范围重复已有知识点。禁止占位名称。字段键名使用 points、name、importance、tertiaryName，name 和 tertiaryName 的值必须使用中文。importance 只填写 X、Y、Z 中的一个字母。严格返回本次请求的数量，只返回 JSON，例如：
{"points":[{"name":"真实的具体知识或技能名称","importance":"X","tertiaryName":"真实的三级考评范围"}]}。`;
  const accepted: Array<{
    name: string; importance: "X" | "Y" | "Z"; tertiaryName?: string; sourceChapterIds: string[];
  }> = [];
  const knownPointKeys = new Set(options.reservedPointKeys);
  let lastError = "";
  for (let attempt = 1; attempt <= 6 && accepted.length < targetCount; attempt += 1) {
    const excerpts = selectBatchExcerpts(excerptPool, options.batchIndex, options.batchCount, attempt);
    try {
      const content = await callModel(instruction, JSON.stringify({
        职业: options.occupationName,
        等级: options.levelCode,
        标准及内容结构: options.context,
        一级考评范围: options.category,
        二级考评范围: topic,
        三级权重: options.weight,
        范围总目标数: options.weight * 2,
        当前范围批次: `${options.batchIndex + 1}/${options.batchCount}`,
        本批必须生成考评点数: Math.min(targetCount - accepted.length, attempt > 1 ? 5 : targetCount),
        已生成考评点: Array.from(knownPointKeys).map((key) => {
          const [三级考评范围, 名称] = key.split("\u0000");
          return { 三级考评范围, 名称 };
        }),
        教材章节: excerpts.map((excerpt) => ({
          id: excerpt.chapterId, 标题: excerpt.title, 段落起始位置: excerpt.start, 内容: excerpt.content,
        })),
        重试说明: attempt > 1
          ? `第 ${attempt} 次补充生成。上次问题：${lastError}。本次已切换教材片段，请提取未覆盖的具体知识内容，不要改写已有考评点。`
          : "请重点依据本批教材片段提取新的具体知识内容，不得重复排除列表中的内容。",
      }), attempt > 1 ? 0.5 : 0);
      const result = parseModelOutput(content);
      if (!result.points.length) {
        lastError = result.receivedCount === 0
          ? "模型返回了空考评点数组"
          : `模型返回 ${result.receivedCount} 条，但名称或重要程度字段均不合格`;
        continue;
      }
      let added = 0;
      let containsPlaceholder = false;
      for (const point of result.points) {
        if (accepted.length === targetCount) break;
        if (isPlaceholderPointName(point.name)) {
          containsPlaceholder = true;
          continue;
        }
        const key = [options.assessmentMode === "skill" ? topic : point.tertiaryName || topic, point.name].join("\u0000");
        if (knownPointKeys.has(key)) continue;
        knownPointKeys.add(key);
        accepted.push({ ...point, sourceChapterIds: Array.from(new Set(excerpts.map((excerpt) => excerpt.chapterId))) });
        added += 1;
      }
      lastError = added
        ? `本次新增 ${added} 条，累计 ${accepted.length}/${targetCount} 条，无效记录 ${result.invalidCount} 条`
        : containsPlaceholder ? "返回了占位考评点名称" : "返回了已生成的考评点";
    } catch (error) {
      lastError = error instanceof Error ? error.message : "模型返回无效数据";
    }
  }
  if (accepted.length !== targetCount) {
    throw new Error(`“${topic}”连续 6 次未补齐本批要求的 ${targetCount} 个完整考评点（已补齐 ${accepted.length}/${targetCount} 条；${lastError}）。`);
  }
  return accepted;
}
