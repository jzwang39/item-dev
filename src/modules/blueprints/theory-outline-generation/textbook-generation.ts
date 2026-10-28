import type { GenerationChapter } from "./generation-context";
import type { ModelCaller } from "./generation-batch";
import { parseModelOutput } from "./model-output";
import type { StandardBasicSource } from "./standard-basic";
import { planTextbookQuotas, planStandardQuotas, type TextbookWeight, type TextbookQuotaPlan } from "./textbook-quota";

export type StandardKnowledge = {
  id: string;
  levelCode: string;
  functionCode: string;
  functionName: string;
  contentCode: string;
  contentName: string;
  code: string;
  name: string;
  evidence: string;
  blueprintVersionId: string;
  fileObjectId: string;
  sourceVersionId: string | null;
};

export type TextbookPoint = {
  primaryName: string;
  secondaryName: string;
  tertiaryName: string;
  primaryWeight: number | null;
  secondaryWeight: number | null;
  tertiaryWeight: number | null;
  name: string;
  importanceCode: "X" | "Y" | "Z";
  sourceChapterIds: string[];
  sectionKind: "basic" | "related_knowledge";
  sharedPointKey?: string;
  standardSource?: StandardKnowledge;
  standardBasicSource?: StandardBasicSource;
  sourceWarning?: string;
  quotaSource?: { weightId: string; blueprintVersionId: string; scopeName: string; targetCount: number; allocation: "content_length_largest_remainder" };
};

async function generatePair(basis: unknown, sourceKind: "chapter" | "standard", sourceLabel: string, callModel: ModelCaller, target = 2, excludedNames: string[] = []) {
  const points: Array<{ name: string; importance: "X" | "Y" | "Z" }> = [];
  let lastError = "返回数量不足或包含重复、占位名称";
  const sourceInstruction = sourceKind === "chapter"
    ? "只依据给定教材章节正文提取最重要的具体知识，不得编造正文中没有的内容。"
    : `给定职业标准三级条目是考核范围，不是已经拆分好的考评点清单。请结合给定原文以及该职业、适用等级的通用专业知识，将此条目细化为${target}个不同且具体的理论知识考核角度，不要仅照抄条目名称。可以按含义与组成、准备步骤与核查要点、适用条件与注意事项等角度选择本条目确实适用的知识对象；不得仅改写同一概念凑数，不得越出条目范围，不得编造具体法律条款、数值标准或机构制度。不需要匹配教材。`;
  const nameKey = (name: string) => name.normalize("NFKC").replace(/[\s\p{P}]/gu, "");
  const used = new Set(excludedNames.map(nameKey));
  for (let attempt = 0; attempt < 6 && points.length < target; attempt += 1) {
    const requested = Math.min(40, target - points.length);
    try {
      const output = await callModel(
        `你是理论知识考评要素细目表编制专家。${sourceInstruction}生成能够独立考核的考评点，每点只考核一个对象。名称应是具体理论知识对象（如原则、含义、方法、条件、步骤、注意事项），不要输出试题、案例分析任务、实操任务或考核活动名称。不得跨章节、跨职业等级、跨职业功能或工作内容。不得生成占位名称或重复已有考评点。严格输出要求的新增数量，只返回 JSON，格式为 {"points":[{"name":"具体中文考评点名称","importance":"X"}]}，importance 只能为 X、Y、Z。`,
        JSON.stringify({
          依据: basis,
          本来源总目标数: target,
          本批必须生成考评点数: requested,
          已生成考评点: points,
          其他来源已生成考评点: excludedNames,
          重试说明: attempt
            ? `第${attempt + 1}次补齐。上次结果：${lastError}。已生成列表是排除项，禁止再次输出或仅改名；只输出${requested}个尚未覆盖的独立知识对象。`
            : `请一次输出${requested}个不同的具体知识对象，不要只返回概括性的原条目名称。内容不足须返回不足，不得编造或改写凑数。`,
        }),
        attempt ? 0.5 : 0,
      );
      const parsed = parseModelOutput(output);
      let duplicates = 0, placeholders = 0, added = 0;
      for (const point of parsed.points) {
        if (points.length === target || added === requested) break;
        if (/^(?:考评点(?:名称)?|考核点|知识点|测试|示例)\s*[-_（(]?\s*\d*\s*[）)]?$/u.test(point.name)) { placeholders += 1; continue; }
        if (used.has(nameKey(point.name))) { duplicates += 1; continue; }
        used.add(nameKey(point.name));
        points.push({ name: point.name, importance: point.importance });
        added += 1;
      }
      lastError = `返回${parsed.receivedCount}条，新增${added}条，重复${duplicates}条，占位${placeholders}条，字段无效${parsed.invalidCount}条，累计${points.length}/${target}`;
    } catch (error) {
      // Keep accepted points and retry only the missing part of this source unit.
      lastError = error instanceof Error ? error.message : "模型响应无效";
    }
  }
  if (points.length !== target) throw new Error(`${sourceLabel}：连续6次未能生成${target}个有效考评点（${points.length}/${target}；${lastError}），未发布新版本。`);
  return points;
}

export function validateTextbookInputs(chapters: GenerationChapter[], knowledge: StandardKnowledge[], levels: readonly string[]) {
  if (!chapters.length || chapters.some((chapter) => !chapter.content.trim())) throw new Error("最新教材没有完整的已存储章节内容。");
  if (new Set(chapters.map((chapter) => chapter.id)).size !== chapters.length) throw new Error("教材章节记录重复。");
  validateKnowledgeInputs(knowledge, levels);
}

function validateKnowledgeInputs(knowledge: StandardKnowledge[], levels: readonly string[]) {
  for (const level of levels) {
    const items = knowledge.filter((item) => item.levelCode === level);
    if (!items.length) throw new Error(`${level} 缺少相关知识要求，请先重新识别完整职业标准。`);
    const keys = items.map((item) => [item.functionCode, item.contentCode, item.code].join("/"));
    if (new Set(keys).size !== keys.length) throw new Error(`${level} 的相关知识要求路径重复。`);
    if (items.some((item) => !item.name || !item.functionName || !item.contentName ||
      !item.contentCode.startsWith(`${item.functionCode}.`) ||
      !/^\d+\.\d+\.\d+$/.test(item.code))) throw new Error(`${level} 的相关知识要求与职业功能、工作内容不匹配。`);
  }
}

export async function generateStandardBasic(occupationName: string, item: StandardBasicSource, callModel: ModelCaller, target = 2, excludedNames: string[] = []): Promise<TextbookPoint[]> {
  const pair = await generatePair({
    职业: occupationName, 适用等级: "五级、四级、三级共用基本要求",
    标准基本条目: { 分类: item.category, 父级: item.parentName, 编号: item.code, 名称: item.name, 原文: item.evidence },
  }, "standard", `标准公共基本条目${item.code}“${item.name}”`, callModel, target, excludedNames);
  return pair.map((point, index) => ({
    primaryName: item.category, secondaryName: item.parentName, tertiaryName: `${item.code} ${item.name}`,
    primaryWeight: null, secondaryWeight: null, tertiaryWeight: null,
    name: point.name, importanceCode: point.importance, sourceChapterIds: [],
    sectionKind: "basic", sharedPointKey: `standard:${item.blueprintVersionId}:${item.code}:${index + 1}`,
    standardBasicSource: item,
  }));
}

export async function generateBasicChapter(occupationName: string, chapter: GenerationChapter, callModel: ModelCaller, target = 2, excludedNames: string[] = []): Promise<TextbookPoint[]> {
  const pair = await generatePair({
    职业: occupationName, 适用等级: "五级、四级、三级共用基础知识",
    章节记录: { id: chapter.id, 序号: chapter.ordinal, 标题: chapter.sectionTitle || chapter.chapterTitle, 内容: chapter.content },
  }, "chapter", `教材章节${chapter.ordinal}“${chapter.sectionTitle || chapter.chapterTitle}”`, callModel, target, excludedNames);
  return pair.map((point, index) => ({
    primaryName: "基本要求", secondaryName: "基础知识",
    tertiaryName: `${chapter.ordinal}. ${chapter.sectionTitle || chapter.chapterTitle}`,
    primaryWeight: null, secondaryWeight: null, tertiaryWeight: null,
    name: point.name, importanceCode: point.importance, sourceChapterIds: [chapter.id],
    sectionKind: "basic", sharedPointKey: `${chapter.id}:${index + 1}`,
  }));
}

export async function generateStandardKnowledge(occupationName: string, item: StandardKnowledge, callModel: ModelCaller, target = 2, excludedNames: string[] = []): Promise<TextbookPoint[]> {
  const pair = await generatePair({
    职业: occupationName, 等级: item.levelCode,
    职业功能: { 编号: item.functionCode, 名称: item.functionName },
    工作内容: { 编号: item.contentCode, 名称: item.contentName },
    相关知识要求: { 编号: item.code, 名称: item.name, 原文: item.evidence },
  }, "standard", `${item.levelCode}／${item.functionName}／${item.contentName}／${item.code}“${item.name}”`, callModel, target, excludedNames);
  return pair.map((point) => ({
    primaryName: `相关知识要求 · ${item.functionName}`,
    secondaryName: item.contentName, tertiaryName: `${item.code} ${item.name}`,
    primaryWeight: null, secondaryWeight: null, tertiaryWeight: null,
    name: point.name, importanceCode: point.importance, sourceChapterIds: [],
    sectionKind: "related_knowledge", standardSource: item,
    // Source tables can contain numbering typos; parent links define the row, not the printed prefix.
    sourceWarning: item.code.startsWith(`${item.contentCode}.`) ? undefined : "标准原文条目编号与工作内容编号不一致，按原文表格归属保留，待核对。",
  }));
}

export async function generateTextbookOutlines(
  occupationName: string, chapters: GenerationChapter[], knowledge: StandardKnowledge[], levels: readonly string[],
  callModel: ModelCaller,
  onProgress: (level: string, completed: number, points: TextbookPoint[]) => Promise<void>,
  weights: TextbookWeight[],
) {
  validateTextbookInputs(chapters, knowledge, levels);
  const plans = planTextbookQuotas(chapters, knowledge, levels, weights);
  return generateWeightedOutlines(occupationName, knowledge, levels, callModel, onProgress, plans, chapters.map((chapter) => chapter.id),
    (id, target, excluded) => generateBasicChapter(occupationName, chapters.find((chapter) => chapter.id === id)!, callModel, target, excluded));
}

async function generateWeightedOutlines(
  occupationName: string, knowledge: StandardKnowledge[], levels: readonly string[], callModel: ModelCaller,
  onProgress: (level: string, completed: number, points: TextbookPoint[]) => Promise<void>,
  plans: Map<string, TextbookQuotaPlan>, sourceIds: string[],
  generateShared: (id: string, target: number, excluded: string[]) => Promise<TextbookPoint[]>,
) {
  const pool = new Map<string, TextbookPoint[]>();
  let completed = 0;
  const selectBasic = (level: string) => plans.get(level)!.basic.flatMap((quota) =>
    (pool.get(quota.sourceId) ?? []).slice(0, quota.count).map((point) => bindQuota(point, quota.weight, quota.count, level)));
  for (const sourceId of sourceIds) {
    const target = Math.max(0, ...levels.flatMap((level) => plans.get(level)!.basic
      .filter((quota) => quota.sourceId === sourceId).map((quota) => quota.count)));
    if (!target) continue;
    pool.set(sourceId, await generateShared(sourceId, target,
      [...pool.values()].flat().map((point) => point.name)));
    completed++;
    for (const level of levels) await onProgress(level, completed, selectBasic(level));
  }
  const result = new Map<string, TextbookPoint[]>();
  for (const level of levels) {
    const points = selectBasic(level);
    let levelCompleted = completed;
    for (const quota of plans.get(level)!.related) {
      if (!quota.count) continue;
      const item = knowledge.find((item) => item.id === quota.sourceId)!;
      points.push(...(await generateStandardKnowledge(occupationName, item, callModel, quota.count, points.map((point) => point.name)))
        .map((point) => bindQuota(point, quota.weight, quota.count, level)));
      await onProgress(level, ++levelCompleted, points);
    }
    if (points.length !== plans.get(level)!.total) throw new Error(`${level}配额未补齐，未发布新版本。`);
    result.set(level, points);
  }
  return result;
}

function bindQuota(point: TextbookPoint, weight: TextbookWeight, target: number, level: string): TextbookPoint {
  return { ...point, secondaryName: weight.category === "基本要求" && !point.standardBasicSource ? weight.name : point.secondaryName,
    primaryWeight: weight.category === "相关知识要求" ? weight.weights[level]! : null,
    secondaryWeight: weight.category === "基本要求" ? weight.weights[level]! : null,
    quotaSource: { weightId: weight.id, blueprintVersionId: weight.blueprintVersionId, scopeName: weight.name,
      targetCount: target, allocation: "content_length_largest_remainder" } };
}

export async function generateStandardOutlines(
  occupationName: string, basic: StandardBasicSource[], knowledge: StandardKnowledge[], levels: readonly string[],
  callModel: ModelCaller,
  onProgress: (level: string, completed: number, points: TextbookPoint[]) => Promise<void>,
  weights: TextbookWeight[],
) {
  validateStandardInputs(basic, knowledge, levels);
  const plans = planStandardQuotas(basic, knowledge, levels, weights);
  return generateWeightedOutlines(occupationName, knowledge, levels, callModel, onProgress, plans, basic.map((item) => item.code),
    (code, target, excluded) => generateStandardBasic(occupationName, basic.find((item) => item.code === code)!, callModel, target, excluded));
}

export function validateStandardInputs(basic: StandardBasicSource[], knowledge: StandardKnowledge[], levels: readonly string[]) {
  if (!basic.length || basic.some((item) => !item.code || !item.name || !item.evidence.trim())) throw new Error("标准公共基本条目缺失，无法生成细目表。");
  if (new Set(basic.map((item) => item.code)).size !== basic.length) throw new Error("标准公共基本条目重复。");
  validateKnowledgeInputs(knowledge, levels);
}
