import { z } from "zod";
import type { GeneratedQuestion, QuestionType } from "./contracts";

export const MAX_TOTAL_ATTEMPTS = 12;
export const MAX_TARGETED_ATTEMPTS = 6;
export const MAX_ZERO_OUTPUTS = 2;
export type FailureCode = "duplicate" | "invalid_json" | "invalid_type" | "invalid_options" | "invalid_answer" | "invalid_identity"
  | "invalid_rubric" | "invalid_content" | "insufficient_basis" | "angle_plan_invalid"
  | "network_timeout" | "network_error" | "rate_limited" | "model_error"
  | "connection_changed" | "save_error" | "lease_expired";
export type RetryFailure = { code: FailureCode; message: string };
export type KnowledgeAngle = { angle: string; sourceId: string; quote: string };
export type RetryState = {
  targeted: boolean; targetedAttempts: number; zeroOutputs: number;
  failures: RetryFailure[]; attemptedAngles: KnowledgeAngle[]; selectedAngle?: KnowledgeAngle;
  covered?: Array<{ index: number; angle: string }>;
  stopReason?: string;
  manualRecovery?: boolean;
};
export class GenerationFailure extends Error {
  constructor(public code: FailureCode, message: string) { super(message); }
}
export function retryState(value: unknown): RetryState {
  const record = typeof value === "string" ? JSON.parse(value) : value;
  return {
    targeted: false, targetedAttempts: 0, zeroOutputs: 0, failures: [], attemptedAngles: [],
    ...(record && typeof record === "object" ? record : {}),
  };
}
export function validationFailure(message: string): RetryFailure {
  const code: FailureCode = /身份铺垫/.test(message) ? "invalid_identity" : /重复/.test(message) ? "duplicate"
    : /考评点|题型与请求|题型没有|questionType|assessmentPointCode/.test(message) ? "invalid_type"
    : /scoreRubric|评分/.test(message) ? "invalid_rubric"
    : /answers|答案/.test(message) ? "invalid_answer"
    : /options|选项/.test(message) ? "invalid_options" : "invalid_content";
  return { code, message };
}
export function failureOf(error: unknown): RetryFailure {
  if (error instanceof GenerationFailure) return { code: error.code, message: error.message };
  if (error instanceof Error && /TimeoutError|AbortError/.test(error.name)) return { code: "network_timeout", message: "模型请求超时。" };
  return { code: "network_error", message: error instanceof Error ? error.message : "模型连接异常。" };
}
const transport = new Set<FailureCode>(["network_timeout", "network_error", "rate_limited", "lease_expired"]);
export function retryDelay(attempts: number, failures: RetryFailure[]) {
  return failures.some((failure) => transport.has(failure.code))
    ? Math.min(300, 15 * 2 ** Math.min(5, Math.max(0, attempts - 1))) : 5;
}
export function retryBlocked(state: RetryState, attempts: number, manual = false): string | undefined {
  if (attempts >= MAX_TOTAL_ATTEMPTS) return "已达到累计12次执行上限，需人工处理。";
  if (state.targetedAttempts >= MAX_TARGETED_ATTEMPTS) return "已达到累计6次精准补题上限，需人工处理。";
  const intervention = manual || state.manualRecovery ? ["insufficient_basis"] : ["insufficient_basis", "connection_changed", "save_error", "model_error"];
  if (state.failures.some((failure) => intervention.includes(failure.code))) {
    return state.failures.find((failure) => intervention.includes(failure.code))?.message ?? "需人工处理。";
  }
}
export function completeRetry(state: RetryState, attempts: number, saved: number, remaining: number, failures: RetryFailure[]) {
  const next: RetryState = {
    ...state, failures,
    zeroOutputs: saved > 0 ? 0 : state.zeroOutputs + 1,
    targeted: state.targeted || saved > 0 || failures.some((failure) => !transport.has(failure.code)),
    selectedAngle: saved > 0 ? undefined : state.selectedAngle,
    stopReason: undefined, manualRecovery: false,
  };
  if (!remaining) return { status: "succeeded" as const, state: next, delay: 0 };
  next.stopReason = retryBlocked(next, attempts)
    ?? (next.zeroOutputs >= MAX_ZERO_OUTPUTS ? "连续两次新增0题，已停止自动重试，需处理后手动重试。" : undefined);
  return { status: next.stopReason ? "failed" as const : "queued" as const, state: next, delay: retryDelay(attempts, failures) };
}
export function prepareManualRetry(state: RetryState, attempts: number, legacyError: string | null): RetryState {
  const blocked = retryBlocked(state, attempts, true);
  if (blocked) throw new Error(blocked);
  return {
    ...state, targeted: true, zeroOutputs: 0, stopReason: undefined, manualRecovery: true,
    failures: state.failures.length ? state.failures : legacyError ? [validationFailure(legacyError)] : [],
  };
}

export type AngleSource = { id: string; content: string };
function normalized(value: string) { return value.normalize("NFKC").replace(/\s+/g, "").toLowerCase(); }
export function angleSources(context: unknown, excerpts: Array<{ content: string }>): AngleSource[] {
  const sources: AngleSource[] = excerpts.map((excerpt, index) => ({ id: `textbook-${index + 1}`, content: excerpt.content }));
  // Only evidence-bearing fields, never IDs, hierarchy names or generated weights.
  const visit = (value: unknown, path: string) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "string" && /^(evidence|standardText|standardRequirement)$/.test(key) && child.trim()) {
        sources.push({ id: `${path}.${key}`, content: child });
      } else if (child && typeof child === "object") visit(child, `${path}.${key}`);
    }
  };
  visit(context, "standard");
  return sources;
}
const angleSchema = z.object({
  angle: z.string().trim().min(2).max(300),
  sourceId: z.string().trim().min(1).max(500),
  quote: z.string().trim().min(4).max(2000),
});
const planSchema = z.object({
  covered: z.array(z.object({ index: z.number().int().nonnegative(), angle: z.string().trim().min(2).max(300) })).max(500),
  remaining: z.array(angleSchema).max(12),
  reason: z.string().trim().max(1000).optional(),
});
export function parseAnglePlan(content: string, previousCount: number, sources: AngleSource[], attempted: KnowledgeAngle[]) {
  let parsed: z.infer<typeof planSchema>;
  try { parsed = planSchema.parse(JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""))); }
  catch { throw new GenerationFailure("angle_plan_invalid", "知识角度分析返回格式无效，需重新分析。"); }
  const indexes = new Set(parsed.covered.map((entry) => entry.index));
  if (parsed.covered.length !== previousCount || indexes.size !== previousCount || parsed.covered.some((entry) => entry.index >= previousCount)) {
    throw new GenerationFailure("angle_plan_invalid", "知识角度分析未完整覆盖已有试题，不能补题。");
  }
  if (!parsed.remaining.length) throw new GenerationFailure("insufficient_basis", parsed.reason || "未找到有依据且尚未覆盖的知识角度，需人工处理。");
  const excluded = new Set([...parsed.covered.map((entry) => entry.angle), ...attempted.map((entry) => entry.angle)].map(normalized));
  const candidates = parsed.remaining.filter((candidate) => !excluded.has(normalized(candidate.angle)));
  const selected = candidates.find((candidate) => sources.some((source) => source.id === candidate.sourceId
    && normalized(source.content).includes(normalized(candidate.quote))));
  if (!selected) throw new GenerationFailure("angle_plan_invalid", "候选角度重复或引用无法在冻结依据中核对，不能据此补题。");
  return { covered: parsed.covered, selected };
}
export function anglePlanningPrompt(code: string, name: string, type: QuestionType, previous: Array<{
  stem: string; content?: unknown; answer?: unknown; analysis?: string | null;
}>, sources: AngleSource[], state: RetryState, context: unknown) {
  return {
    instruction: `你是职业技能命题补题分析助手。本次只分析知识角度，不生成试题。严格限制在指定考评点、等级和冻结依据范围内。
逐题结合题干、选项、答案和解析提炼已经覆盖的实质知识内容。不要把换词、换句式、正反问法视为新角度。
找出适合指定缺额题型、有明确依据、尚未被已有题覆盖且未被之前补题尝试使用的新角度；不得跨考评点、编造依据或降低质量。
每个候选给出sourceId和来源中逐字可核验的quote。资料不足或无新角度时remaining返回[]并说明reason，禁止凑数。
只返回JSON：{"covered":[{"index":0,"angle":"已覆盖知识内容"}],"remaining":[{"angle":"尚未覆盖知识内容","sourceId":"提供的来源ID","quote":"该来源原文"}],"reason":""}。
covered必须包含所有已有试题的索引且不重复；无已有题时返回[]。`,
    prompt: JSON.stringify({
      考评点: { code, name }, 指定缺额题型: type, 冻结范围: context,
      已有试题: previous.map((entry, index) => ({ index, ...entry })),
      可用依据: sources, 已尝试角度: state.attemptedAngles, 上次失败: state.failures,
    }),
  };
}
export function retryQuestionFeedback(state: RetryState, angle: KnowledgeAngle, type: QuestionType) {
  return {
    本次仅补一题: true, 指定缺额题型: type, 尚未覆盖的知识角度: angle,
    已覆盖知识角度: state.covered ?? [], 已尝试角度: state.attemptedAngles.filter((entry) => normalized(entry.angle) !== normalized(angle.angle)),
    上次具体错误: state.failures,
    要求: "严格按指定角度、题型及引用依据生成一道新题；不重复已有题的实质内容，不仅换词改写，不降低原质量标准。",
  };
}
export function keepSelectedAngle(state: RetryState) {
  return !!state.selectedAngle && state.failures.length > 0 && state.failures.every((failure) => [
    "invalid_json", "invalid_type", "invalid_options", "invalid_answer", "invalid_rubric", "invalid_identity",
    "network_timeout", "network_error", "rate_limited", "lease_expired",
  ].includes(failure.code));
}
export type RequestOutput = { questions: GeneratedQuestion[]; failures: RetryFailure[]; state: RetryState };
