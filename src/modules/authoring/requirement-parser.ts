import { z } from "zod";

const aiResultSchema = z.object({
  occupationName: z.string().trim().min(1),
  levelCode: z.enum(["level_5", "level_4", "level_3", "level_2", "level_1"]),
  assessmentMode: z.enum(["theory", "skill"]),
  temporaryMinimums: z.object({
    single: z.number().int().min(0).max(100).default(0),
    multiple: z.number().int().min(0).max(100).default(0),
    judgement: z.number().int().min(0).max(100).default(0),
    practical: z.number().int().min(0).max(100).default(0),
  }).default({ single: 0, multiple: 0, judgement: 0, practical: 0 }),
  qualityRequirements: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
});

export type ParsedRequirement = z.infer<typeof aiResultSchema>;

export function findPlanOccupation<T extends { name: string }>(occupations: T[], name: string): T | undefined {
  const exact = occupations.filter((occupation) => occupation.name === name);
  if (exact.length === 1) return exact[0];
  const matches = exact.length ? exact : occupations.filter((occupation) =>
    name.includes(occupation.name) || occupation.name.includes(name));
  if (matches.length > 1) throw new Error("命题职业匹配到多个职业，请使用完整职业名称重新生成计划。");
  return matches[0];
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;

function field(value: Record<string, unknown>, keys: string[]) {
  for (const key of keys) if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];
  return undefined;
}

function normalizeLevel(value: unknown): unknown {
  if (typeof value !== "string" && typeof value !== "number") return value;
  const text = String(value).normalize("NFKC").trim().toLowerCase().replace(/\s+/g, "");
  const titles = ["高级技师", "技师", "高级工", "中级工", "初级工"];
  const numerals = ["一", "二", "三", "四", "五"];
  for (let index = 0; index < titles.length; index++) {
    const level = index + 1;
    const aliases = [`level_${level}`, String(level), `${level}级`, `${numerals[index]}级`,
      titles[index], `${numerals[index]}级/${titles[index]}`, `${level}级/${titles[index]}`];
    if (aliases.includes(text)) return `level_${level}`;
  }
  return value;
}

function normalizeMode(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.normalize("NFKC").trim().toLowerCase();
  if (["theory", "理论知识", "理论"].includes(text)) return "theory";
  if (["skill", "操作技能", "技能", "实操"].includes(text)) return "skill";
  return value;
}

function normalizeMinimums(value: unknown): unknown {
  const source = record(value);
  if (!source) return value;
  const aliases = {
    single: ["single", "单选", "单选题", "单项选择题"],
    multiple: ["multiple", "多选", "多选题", "多项选择题"],
    judgement: ["judgement", "judgment", "判断", "判断题"],
    practical: ["practical", "实操题", "操作技能题"],
  };
  return Object.fromEntries(Object.entries(aliases).map(([key, names]) => {
    const count = field(source, names);
    // Convert only unambiguous nonnegative integer strings, not null, units or ranges.
    return [key, typeof count === "string" && /^\d+$/.test(count.trim()) ? Number(count.trim()) : count];
  }));
}

export function parseModelRequirement(content: string): ParsedRequirement {
  const json = content.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error("AI 未返回可解析的命题范围。");
  let parsed: unknown;
  try { parsed = JSON.parse(json); }
  catch { throw new Error("AI 返回的命题范围 JSON 格式不正确，请调整模型输出格式后重试。"); }
  let source = record(parsed);
  if (source && field(source, ["occupationName", "occupation", "职业名称", "职业"]) === undefined) {
    source = record(source.data) ?? record(source.result) ?? source;
  }
  const normalized = source ? {
    occupationName: field(source, ["occupationName", "occupation", "职业名称", "职业"]),
    levelCode: normalizeLevel(field(source, ["levelCode", "level", "技能等级", "等级"])),
    assessmentMode: normalizeMode(field(source, ["assessmentMode", "考核方式", "考核类型"])),
    temporaryMinimums: normalizeMinimums(field(source, ["temporaryMinimums", "临时最低题量", "每个考评点题量"])),
    qualityRequirements: field(source, ["qualityRequirements", "质量要求"]),
  } : parsed;
  const result = aiResultSchema.safeParse(normalized);
  if (!result.success) {
    const labels: Record<string, string> = {
      occupationName: "职业名称", levelCode: "技能等级", assessmentMode: "考核方式",
      temporaryMinimums: "每个考评点题量（须为0至100的整数）",
      qualityRequirements: "质量要求（须为最多10条、每条1至200字的文本数组）",
    };
    const invalid = [...new Set(result.error.issues.map((issue) => labels[String(issue.path[0])] ?? "命题范围"))];
    throw new Error(`AI 返回的${invalid.join("、")}格式无效，请重试；若持续失败，请检查模型设置。`);
  }
  return result.data;
}
