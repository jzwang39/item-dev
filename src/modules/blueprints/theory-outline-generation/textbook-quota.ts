import type { GenerationChapter } from "./generation-context";
import type { StandardKnowledge } from "./textbook-generation";
import type { StandardBasicSource } from "./standard-basic";

export type TextbookWeight = {
  id: string;
  name: string;
  category: string;
  weights: Record<string, number | null>;
  blueprintVersionId: string;
};
export type SourceQuota = { sourceId: string; count: number; weight: TextbookWeight };
export type TextbookQuotaPlan = { basic: SourceQuota[]; related: SourceQuota[]; total: number };

// Largest-remainder allocation keeps integer child quotas exactly equal to their parent.
export function allocateQuota(total: number, units: readonly { id: string; size: number }[]): Map<string, number> {
  if (!Number.isInteger(total) || total < 0) throw new Error("考评点配额必须为非负整数。");
  if (!units.length) {
    if (total) throw new Error("正权重范围缺少可分配的教材章节或标准条目。");
    return new Map();
  }
  const sum = units.reduce((value, unit) => value + Math.max(1, unit.size), 0);
  const rows = units.map((unit, index) => {
    const exact = total * Math.max(1, unit.size) / sum;
    return { id: unit.id, index, count: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let remaining = total - rows.reduce((value, row) => value + row.count, 0);
  for (const row of [...rows].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
    if (remaining-- > 0) row.count++;
  }
  return new Map(rows.map((row) => [row.id, row.count]));
}

const normalizeName = (name: string) => name.replace(/\s|[·、：:]/g, "").replace(/^\d+[.．]?/, "");

export function planTextbookQuotas(
  chapters: GenerationChapter[], knowledge: StandardKnowledge[], levels: readonly string[], weights: TextbookWeight[],
): Map<string, TextbookQuotaPlan> {
  return planWeightedQuotas(knowledge, levels, weights, (weight) => {
    const units = /^(基础知识|基本知识|理论知识|基础理论)$/.test(weight.name)
      ? chapters.filter((chapter) => !/职业道德|职业守则/.test(`${chapter.chapterTitle}${chapter.sectionTitle ?? ""}`))
      : chapters.filter((chapter) => normalizeName(`${chapter.chapterTitle}${chapter.sectionTitle ?? ""}${chapter.content}`).includes(normalizeName(weight.name)));
    return units.map((chapter) => ({ id: chapter.id, size: chapter.content.replace(/\s/g, "").length }));
  }, "教材章节");
}

export function planStandardQuotas(
  basic: StandardBasicSource[], knowledge: StandardKnowledge[], levels: readonly string[], weights: TextbookWeight[],
): Map<string, TextbookQuotaPlan> {
  if (new Set(basic.map((item) => item.code)).size !== basic.length) throw new Error("标准公共基本条目编号重复。");
  return planWeightedQuotas(knowledge, levels, weights, (weight) => {
    const names = (item: StandardBasicSource) => item.ancestorNames ?? [item.category, item.parentName];
    const direct = basic.filter((item) => [...names(item), item.name].some((name) => normalizeName(name) === normalizeName(weight.name)));
    const units = direct.length || !/^(基础知识|基本知识|理论知识|基础理论)$/.test(weight.name)
      ? direct
      : basic.filter((item) => !names(item).some((name) => /职业道德|职业守则/.test(name)) && !/职业道德|职业守则/.test(item.name));
    return units.map((item) => ({ id: item.code, size: item.evidence.replace(/\s/g, "").length }));
  }, "标准公共基本条目");
}

function planWeightedQuotas(
  knowledge: StandardKnowledge[], levels: readonly string[], weights: TextbookWeight[],
  selectBasic: (weight: TextbookWeight) => { id: string; size: number }[], sourceLabel: string,
): Map<string, TextbookQuotaPlan> {
  if (!weights.length) throw new Error("缺少当前理论知识权重表，不能按权重生成细目表。");
  if (new Set(weights.map((weight) => `${weight.category}/${weight.name}`)).size !== weights.length) {
    throw new Error("权重范围重复，不能重复计算父子配额。");
  }
  const plans = new Map<string, TextbookQuotaPlan>();
  for (const level of levels) {
    const plan: TextbookQuotaPlan = { basic: [], related: [], total: 0 };
    const assignedBasic = new Set<string>(), assignedRelated = new Set<string>();
    // Match specific basic scopes first; the umbrella foundation uses the remaining chapters.
    const ordered = [...weights].sort((a, b) => Number(/^(基础知识|基本知识|理论知识|基础理论)$/.test(a.name)) -
      Number(/^(基础知识|基本知识|理论知识|基础理论)$/.test(b.name)));
    for (const weight of ordered) {
      const value = weight.weights[level];
      if (value === null || value === 0) {
        if (weight.category === "相关知识要求") knowledge.filter((item) => item.levelCode === level &&
          normalizeName(item.functionName) === normalizeName(weight.name)).forEach((item) => assignedRelated.add(item.id));
        continue;
      }
      if (value === undefined || !Number.isFinite(value) || value < 0 || value > 100 || !Number.isInteger(value * 2)) {
        throw new Error(`${level}／${weight.name}权重缺失或无法换算为整数考评点配额。`);
      }
      const count = value * 2;
      if (weight.category === "基本要求") {
        const available = selectBasic(weight).filter((unit) => !assignedBasic.has(unit.id));
        if (!available.length) throw new Error(`${level}／${weight.name}权重范围没有匹配的${sourceLabel}。`);
        const allocation = allocateQuota(count, available);
        for (const unit of available) {
          assignedBasic.add(unit.id);
          plan.basic.push({ sourceId: unit.id, count: allocation.get(unit.id)!, weight });
        }
      } else if (weight.category === "相关知识要求") {
        const units = knowledge.filter((item) => item.levelCode === level &&
          normalizeName(item.functionName) === normalizeName(weight.name));
        if (!units.length) throw new Error(`${level}／${weight.name}权重范围没有匹配的职业功能条目。`);
        if (units.some((item) => assignedRelated.has(item.id))) throw new Error(`${weight.name}权重范围重叠，不能重复计算。`);
        const allocation = allocateQuota(count, units.map((item) => ({ id: item.id, size: item.evidence.replace(/\s/g, "").length })));
        for (const item of units) {
          assignedRelated.add(item.id);
          plan.related.push({ sourceId: item.id, count: allocation.get(item.id)!, weight });
        }
      } else throw new Error(`无法识别权重范围“${weight.category}／${weight.name}”。`);
      plan.total += count;
    }
    if (plan.total !== 200) throw new Error(`${level}权重合计不是100%，未生成新版本。`);
    if (knowledge.some((item) => item.levelCode === level && !assignedRelated.has(item.id))) {
      throw new Error(`${level}存在未匹配权重范围的相关知识要求，请核对职业功能名称。`);
    }
    plans.set(level, plan);
  }
  return plans;
}
