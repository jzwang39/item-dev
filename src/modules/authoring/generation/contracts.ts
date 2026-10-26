import { createHash } from "node:crypto";
import { z } from "zod";

export const questionTypes = ["single", "multiple", "judgement"] as const;
export type QuestionType = typeof questionTypes[number];
export const BUSINESS_BATCH_LIMIT = 100;
export const MODEL_REQUEST_LIMIT = 12;
export const GENERATION_CONCURRENCY = 2;
export const MAX_ATTEMPTS = 6;

export const quotaPointSchema = z.object({
  code: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1),
  single: z.number().int().min(0).max(100),
  multiple: z.number().int().min(0).max(100),
  judgement: z.number().int().min(0).max(100),
  total: z.number().int().nonnegative(),
});
export type QuotaPoint = z.infer<typeof quotaPointSchema>;
export type Scope = {
  occupationId: string; occupation: string;
  levelCode: "level_5" | "level_4" | "level_3" | "level_2" | "level_1";
  assessmentMode: "理论知识" | "操作技能";
  blueprintVersions: { outline: { id: string; versionNo: number }; weights: { id: string; versionNo: number } };
};
export type Snapshot = {
  projectId: string; requirement: string; scope: Scope;
  points: QuotaPoint[]; qualityRequirements: string[]; qualityStandard: string;
  sourceVersionIds: string[];
  nodes: Array<{ id: string; code: string; name: string; chapterIds: string[] }>;
  model: { provider: string; baseUrl: string; model: string };
};
export type UnitSpec = { code: string; type: "mixed"; ordinals: number[]; slotTypes: QuestionType[] };
export type BatchSpec = { ordinal: number; target: number; units: UnitSpec[] };

export function validateQuota(points: QuotaPoint[], level: Scope["levelCode"]) {
  if (!["level_5", "level_4", "level_3"].includes(level)) throw new Error("二级、一级需按试卷结构规划，不能执行固定考评点配额命题。");
  const minimums = level === "level_3" ? [3, 2, 2] : [4, 0, 2];
  const codes = new Set<string>();
  for (const point of points) {
    quotaPointSchema.parse(point);
    if (codes.has(point.code)) throw new Error("计划存在重复考评点代码。");
    codes.add(point.code);
    if (questionTypes.some((type, index) => point[type] < minimums[index])) throw new Error(`“${point.name}”题量低于系统最低规则。`);
  }
  if (!points.length) throw new Error("计划没有考评点。");
}

export function buildBatches(points: QuotaPoint[]): BatchSpec[] {
  const batches: BatchSpec[] = [];
  let current: BatchSpec = { ordinal: 1, target: 0, units: [] };
  let ordinal = 0;
  const flush = () => {
    if (current.target) batches.push(current);
    current = { ordinal: batches.length + 1, target: 0, units: [] };
  };
  for (const point of points) {
    const total = questionTypes.reduce((sum, type) => sum + point[type], 0);
    if (current.target && current.target + total > BUSINESS_BATCH_LIMIT) flush();
    const types = questionTypes.flatMap((type) => Array<QuestionType>(point[type]).fill(type));
    let offset = 0;
    while (offset < types.length) {
      if (current.target === BUSINESS_BATCH_LIMIT) flush();
      const count = Math.min(types.length - offset, MODEL_REQUEST_LIMIT, BUSINESS_BATCH_LIMIT - current.target);
      current.units.push({
        code: point.code, type: "mixed",
        ordinals: Array.from({ length: count }, () => ++ordinal),
        slotTypes: types.slice(offset, offset + count),
      });
      current.target += count;
      offset += count;
    }
  }
  flush();
  return batches;
}

const questionSchema = z.object({
  assessmentPointCode: z.string().trim().min(1),
  questionType: z.enum(questionTypes),
  stem: z.string().trim().min(8).max(10000).regex(/[\u4e00-\u9fff]/),
  options: z.array(z.object({ key: z.string().trim().min(1).max(8).transform((key) => key.toUpperCase()), content: z.string().trim().min(1) })).max(8).default([]),
  answers: z.array(z.string().trim().min(1).transform((answer) => answer.toUpperCase())).min(1).max(8),
  analysis: z.string().trim().min(1).max(20000),
});
export type GeneratedQuestion = z.infer<typeof questionSchema>;

export function stemHash(stem: string) {
  return createHash("sha256").update(stem.normalize("NFKC").replace(/\s+/g, "").toLowerCase()).digest("hex");
}

export function parseQuestions(content: string, code: string, requestedType: QuestionType | "mixed") {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    const start = trimmed.search(/[{[]/);
    const end = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
    if (start < 0 || end <= start) throw new Error("模型未返回试题 JSON。");
    payload = JSON.parse(trimmed.slice(start, end + 1));
  }
  const record = payload as Record<string, unknown>;
  const raw = Array.isArray(payload) ? payload : record?.questions ?? record?.["试题"];
  if (!Array.isArray(raw)) throw new Error("模型响应没有 questions 试题数组。");
  const valid: GeneratedQuestion[] = [];
  const invalidReasons: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    const item = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const answer = item.answers ?? item.answer ?? item["答案"];
    const parsed = questionSchema.safeParse({
      ...item,
      answers: typeof answer === "string" ? [answer] : answer,
      analysis: item.analysis ?? item.explanation ?? item["解析"],
    });
    if (!parsed.success) {
      invalidReasons.push(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
      continue;
    }
    const question = parsed.data;
    if (question.assessmentPointCode !== code || (requestedType !== "mixed" && question.questionType !== requestedType)) {
      invalidReasons.push("考评点代码或题型与请求不符");
      continue;
    }
    const type = question.questionType;
    const optionKeys = new Set(question.options.map((option) => option.key));
    const answers = new Set(question.answers);
    const options = new Set(question.options.map((option) => option.content.normalize("NFKC").replace(/\s+/g, "")));
    const legal = type === "judgement"
      ? question.options.length === 0 && question.answers.length === 1 && ["正确", "错误"].includes(question.answers[0])
      : optionKeys.size === question.options.length && options.size === question.options.length
        && answers.size === question.answers.length && question.answers.every((answer) => optionKeys.has(answer))
        && (type === "single" ? question.options.length === 4 && answers.size === 1 : question.options.length >= 4 && answers.size >= 2);
    const hash = stemHash(question.stem);
    if (!legal || seen.has(hash) || /^(?:试题|题干|测试|示例)\s*\d*$/u.test(question.stem)) {
      invalidReasons.push(!legal ? `${type}选项或答案规则不符` : "题干重复或占位");
      continue;
    }
    seen.add(hash);
    valid.push(question);
  }
  return { valid, received: raw.length, invalid: raw.length - valid.length, invalidReasons };
}
