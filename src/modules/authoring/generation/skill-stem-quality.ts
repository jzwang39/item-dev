export function cleanSkillStem(stem: string, occupation?: string): string {
  const roles = [...new Set(["劝募员", occupation?.normalize("NFKC").replace(/\s+/g, "")].filter((role): role is string => !!role))];
  const gap = "(?:[^\\S\\r\\n]|[\\u200b-\\u200d\\ufeff])*";
  let result = stem;
  for (const role of roles) {
    const escaped = [...role].map((char) => char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(gap);
    const level = `(?:[1-5１-５一二三四五]${gap}级(?:${gap}[\\/／]${gap}(?:初级工|中级工|高级工|高级技师|技师))?|初级工|中级工|高级工|高级技师|技师)`;
    const qualifier = `(?:${level}|操作技能|的评估者|的考生|考生|的身份)`;
    // Remove only a recognized introductory identity phrase, not an arbitrary
    // span up to the next comma (which could contain real task requirements).
    const prefix = new RegExp(`(^|[。！？\\n])${gap}(?:你|您)?(?:作为|身为|你是|您是)${gap}(?:一名|一个|一位)?${gap}${escaped}(?:${gap}${qualifier})*${gap}(?:[，,：:]${gap}|(?=请|根据|完成|准备|执行|提交|$))`, "gu");
    result = result.replace(prefix, "$1");
  }
  return result.trim();
}
