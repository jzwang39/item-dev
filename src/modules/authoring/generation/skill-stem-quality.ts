export function skillStemQualityError(stem: string, occupation?: string): string | undefined {
  const text = stem.normalize("NFKC").replace(/[\s\u200b-\u200d\ufeff]+/g, "");
  const roles = [...new Set(["劝募员", occupation?.normalize("NFKC").replace(/\s+/g, "")].filter((role): role is string => !!role))];
  for (const role of roles) {
    const escaped = role.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?:作为|身为|你是|您是)(?:一名|一个|一位)?${escaped}`, "u").test(text)) {
      return "实操题题干违反质量标准第9条：出现职业身份铺垫。请直接描述任务、条件和提交成果，删除“作为/身为/你是某职业”及等级前缀，不得仅换词替代身份铺垫。";
    }
  }
  return undefined;
}
