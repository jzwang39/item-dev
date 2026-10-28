export type WeightRange = { key: string; category: string; name: string; weight: number };
export type WeightedSection = { questionType: string; itemCount: number; scorePerItem: number; rangeKey?: string };
export type Allocation = Array<Array<{ section: number; range: string; count: number }>>;

export function baseQuestionType(type: string) {
  return type.replace(/^[A-Z]\s+/, "").trim();
}

export function scoreCents(value: number) {
  const cents = Math.round(value * 100);
  if (!Number.isFinite(value) || value < 0 || Math.abs(cents - value * 100) > 0.000001) {
    throw new Error("分值必须为非负数，且最多保留两位小数。");
  }
  return cents;
}

export function rangeTargets(ranges: WeightRange[], totalScore: number) {
  if (!ranges.length || new Set(ranges.map((range) => range.key)).size !== ranges.length ||
    ranges.some((range) => !range.name || !Number.isFinite(range.weight) || range.weight <= 0) ||
    Math.abs(ranges.reduce((sum, range) => sum + range.weight, 0) - 100) > 0.000001) {
    throw new Error("当前等级和方向的有效范围权重必须唯一且合计为100%。");
  }
  const total = scoreCents(totalScore);
  return ranges.map((range) => {
    const target = total * range.weight / 100;
    if (Math.abs(target - Math.round(target)) > 0.000001) {
      throw new Error(`“${range.name}”目标分数无法精确到0.01分，不能舍入后冒充严格符合权重。`);
    }
    return { ...range, targetCents: Math.round(target) };
  });
}

export function inventoryKey(range: string, type: string) {
  return `${range}\u0000${baseQuestionType(type)}`;
}

// Exact bounded allocation, including shared inventory across all papers.
// No rounding of range targets and no proportional guess presented as a solution.
export function allocateWeighted(
  sections: WeightedSection[], ranges: WeightRange[], inventory: Record<string, number>, paperCount: number,
): Allocation {
  if (!Number.isInteger(paperCount) || paperCount < 1 || paperCount > 10 ||
    !sections.length || sections.some((section) => !Number.isInteger(section.itemCount) || section.itemCount < 1 || scoreCents(section.scorePerItem) < 1)) {
    throw new Error("组卷题量、每题分值或套数无效。");
  }
  const totalScore = sections.reduce((sum, section) => sum + scoreCents(section.scorePerItem) * section.itemCount, 0) / 100;
  const targets = rangeTargets(ranges, totalScore);
  const capacities = new Map(Object.entries(inventory));
  const scores = sections.map((section) => scoreCents(section.scorePerItem));
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
  for (const range of targets) {
    const eligible = sections.filter((section) => !section.rangeKey || section.rangeKey === range.key);
    const divisor = eligible.reduce((result, section) => gcd(result, scoreCents(section.scorePerItem)), 0);
    if (!divisor || range.targetCents % divisor !== 0) {
      throw new Error(`“${range.name}”权重${range.weight}%要求${range.targetCents / 100}分，但现有每题分值无法精确组成该分数；请调整结构并确认后重试。`);
    }
    const available = [...new Set(eligible.map((section) => baseQuestionType(section.questionType)))]
      .reduce((sum, type) => sum + (inventory[inventoryKey(range.key, type)] ?? 0), 0);
    if (available < paperCount) {
      throw new Error(`“${range.name}”要求每套${range.targetCents / 100}分，但现有题型的范围库存不足以覆盖${paperCount}套；请先补充已入库题目。`);
    }
  }
  const result: Allocation = Array.from({ length: paperCount }, () => []);
  const failed = new Set<string>();
  let visited = 0;
  const capKey = (r: number, s: number) => inventoryKey(targets[r].key, sections[s].questionType);
  const solve = (paper: number, range: number, remaining: number[]): boolean => {
    if (++visited > 200000) throw new Error("精确配分组合过多，已停止搜索且未出卷；请按范围拆分结构后重试或生成调整建议。");
    if (paper === paperCount) return true;
    if (range === targets.length) {
      return remaining.every((count) => count === 0) &&
        solve(paper + 1, 0, sections.map((section) => section.itemCount));
    }
    const state = `${paper}:${range}:${remaining.join(",")}:${Array.from(capacities.values()).join(",")}`;
    if (failed.has(state)) return false;
    const eligible = sections.map((_, index) => index)
      .filter((index) => !sections[index].rangeKey || sections[index].rangeKey === targets[range].key)
      .sort((a, b) => scores[b] - scores[a]);
    const counts = sections.map(() => 0);
    const assign = (position: number, left: number): boolean => {
      if (++visited > 200000) throw new Error("精确配分组合过多，已停止搜索且未出卷；请按范围拆分结构后重试或生成调整建议。");
      if (position === eligible.length) {
        if (left !== 0) return false;
        const cells = counts.flatMap((count, section) => count ? [{ section, range: targets[range].key, count }] : []);
        result[paper].push(...cells);
        if (solve(paper, range + 1, remaining.map((count, index) => count - counts[index]))) return true;
        result[paper].splice(result[paper].length - cells.length, cells.length);
        return false;
      }
      const section = eligible[position];
      const key = capKey(range, section);
      const available = capacities.get(key) ?? 0;
      const max = Math.min(remaining[section], available, Math.floor(left / scores[section]));
      const lastRange = range === targets.length - 1;
      const min = lastRange ? remaining[section] : 0;
      for (let count = max; count >= min; count--) {
        const next = left - count * scores[section];
        if (position === eligible.length - 1 && next !== 0) continue;
        const possible = eligible.slice(position + 1).reduce((sum, index) =>
          sum + Math.min(remaining[index], capacities.get(capKey(range, index)) ?? 0) * scores[index], 0);
        if (next > possible) continue;
        counts[section] = count;
        capacities.set(key, available - count);
        if (assign(position + 1, next)) return true;
        capacities.set(key, available);
      }
      counts[section] = 0;
      return false;
    };
    if (assign(0, targets[range].targetCents)) return true;
    failed.add(state);
    return false;
  };
  if (!solve(0, 0, sections.map((section) => section.itemCount))) {
    throw new Error("现有题型、题量、每题分值和各范围已入库库存无法同时满足严格权重；不会自动改分或生成不合规试卷。");
  }
  return result;
}

export function suggestWeightedSections(
  sections: WeightedSection[], ranges: WeightRange[], inventory: Record<string, number>, paperCount: number,
) {
  const targets = rangeTargets(ranges, 100);
  const types = [...new Set(sections.filter((section) => section.itemCount > 0)
    .sort((a, b) => b.itemCount - a.itemCount).map((section) => baseQuestionType(section.questionType)))];
  const totalItems = sections.reduce((sum, section) => sum + section.itemCount, 0);
  const suggested: WeightedSection[] = [];
  for (const range of targets) {
    const type = types.find((candidate) => (inventory[inventoryKey(range.key, candidate)] ?? 0) >= paperCount);
    if (!type) throw new Error(`“${range.name}”没有足够的已入库、明确归属的现有题型试题，无法给出可执行调整方案；请先补充题库。`);
    const capacity = Math.floor(inventory[inventoryKey(range.key, type)] / paperCount);
    const count = Math.max(1, Math.min(Math.round(totalItems * range.weight / 100), capacity, range.targetCents));
    const each = Math.floor(range.targetCents / count);
    const extra = range.targetCents % count;
    if (count - extra) suggested.push({ questionType: type, rangeKey: range.key, itemCount: count - extra, scorePerItem: each / 100 });
    if (extra) suggested.push({ questionType: type, rangeKey: range.key, itemCount: extra, scorePerItem: (each + 1) / 100 });
  }
  allocateWeighted(suggested, ranges, inventory, paperCount);
  return suggested;
}

export function scaleRubric(value: unknown, score: number) {
  const rubric = (typeof value === "string" ? JSON.parse(value) : value) as {
    totalScore: number; criteria: Array<{ score: number; item: string; standard: string }>;
  };
  if (!rubric || !Number.isFinite(rubric.totalScore) || rubric.totalScore <= 0 || !Array.isArray(rubric.criteria) ||
    !rubric.criteria.length || rubric.criteria.some((item) => !Number.isFinite(item.score) || item.score <= 0 || !item.item || !item.standard) ||
    Math.abs(rubric.criteria.reduce((sum, item) => sum + item.score, 0) - rubric.totalScore) > 0.000001) {
    throw new Error("实操题评分标准缺失或分值不一致，请先修订、审定并入库。");
  }
  const target = scoreCents(score);
  const parts = rubric.criteria.map((item, index) => {
    const raw = target * item.score / rubric.totalScore;
    return { index, cents: Math.floor(raw), remainder: raw - Math.floor(raw) };
  });
  let missing = target - parts.reduce((sum, item) => sum + item.cents, 0);
  for (const part of [...parts].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
    if (missing-- > 0) part.cents++;
  }
  return {
    ...rubric, totalScore: score,
    criteria: rubric.criteria.map((item, index) => ({ ...item, score: parts[index].cents / 100 })),
    originalRubric: rubric,
    scalingNote: `仅本试卷按${score}分同比换算评分项；原题版本不变，原标准中的文字分值以本试卷换算值为准。`,
  };
}
