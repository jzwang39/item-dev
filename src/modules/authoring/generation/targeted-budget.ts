import type { GeneratedQuestion, QuestionType } from "./contracts";
import type { AngleSource, KnowledgeAngle, RetryFailure, RetryState } from "./retry-policy";
import type { SkillTaskDesign } from "./skill-candidate";

export const MAX_SLOT_GENERATIONS = 3;
export const MAX_SLOT_REPAIRS = 2;
export const MAX_SLOT_TRANSPORT_FAILURES = 3;
export const MAX_UNIT_MODEL_CALLS = 120;
export const MAX_SKILL_REPAIRS = 6;
export type SkillSlotWorkflow = {
  version: 1; generationBase: number; repairBase: number; designAttempts: number;
  design?: SkillTaskDesign; designResponse?: string; designReviewResponse?: string;
  designReviewResponses?: string[];
  designReviewFailures: number; candidateRepairs: number; verificationFailures: number;
  reviewRepairResponse?: string; candidateCalculation?: GeneratedQuestion["scoringCalculation"];
};
export type MissingSlot = { id: string; ordinal: number; question_type: QuestionType };
export type TargetedPhase = "analysis" | "generation" | "repair" | "verification";
export type SlotBudget = {
  ordinal: number; type: QuestionType; generations: number; repairs: number; transportFailures: number;
  analysisFailures: number; reviewFailures: number; searchedSourceIds: string[]; searchReasons: string[];
  angle?: KnowledgeAngle; pendingResponse?: string; done?: boolean; blocked?: RetryFailure;
  evidenceSourceIds?: string[]; candidateRepairs?: GeneratedQuestion["candidateRepairs"];
  trialDesign?: boolean;
  reviewMode?: "single";
  singleReviews?: Array<{ index: number; response: string }>;
  singleReviewFailures?: Record<number, number>;
  recoveredBlock?: RetryFailure;
  skill?: SkillSlotWorkflow;
  evidenceSources?: AngleSource[];
  reviewResponses?: Array<{ mode: "batch" | "single"; index?: number; response: string }>;
  rejectedCandidates?: Array<{ response: string; repairs?: GeneratedQuestion["candidateRepairs"]; angle?: KnowledgeAngle; failures: RetryFailure[]; at: string;
    evidenceSources?: AngleSource[]; reviewResponses?: SlotBudget["reviewResponses"];
    skillDesignResponse?: string; skillDesignReviewResponse?: string; skillDesignReviewResponses?: string[];
    scoringCalculation?: GeneratedQuestion["scoringCalculation"] }>;
};
export type TargetedBudget = {
  version: 2; calls: number; maxCalls: number; activeSlotId?: string; phase?: TargetedPhase;
  workflowVersion?: 3;
  skillRecovery?: { version: 1; attempts: number; previousCalls: number; previousMaxCalls: number; addedCalls: number; slotIds: string[]; at: string };
  sourceCount?: number; slots: Record<string, SlotBudget>; completedAngles: KnowledgeAngle[];
  reviewContext?: {
    kind: "theory" | "skill"; qualityStandard: string; qualityRequirements: string[];
    previous: Array<{ stem: string; content?: unknown; answer?: unknown; analysis?: string | null }>;
  };
  origin: { attempts: number; targetedAttempts: number; failures: RetryFailure[]; legacyError?: string | null; stopReason?: string };
  history: Array<{ phase: TargetedPhase; slotId: string; outcome: string; at: string }>;
};

export function ensureTargetedBudget(state: RetryState, missing: MissingSlot[], attempts: number, legacyError?: string | null) {
  state.budget ??= {
    version: 2, workflowVersion: 3, calls: 0, maxCalls: Math.min(MAX_UNIT_MODEL_CALLS,
      Math.max(24, missing.length * (missing.every((slot) => slot.question_type === "practical") ? 24 : 16))),
    slots: {}, completedAngles: [],
    origin: { attempts, targetedAttempts: state.targetedAttempts, failures: state.failures.slice(), legacyError, stopReason: state.stopReason }, history: [],
  };
  const live = new Set(missing.map((slot) => slot.id));
  for (const [id, slot] of Object.entries(state.budget.slots)) if (!live.has(id)) slot.done = true;
  for (const slot of missing) {
    state.budget.slots[slot.id] ??= {
      ordinal: slot.ordinal, type: slot.question_type, generations: 0, repairs: 0, transportFailures: 0,
      analysisFailures: 0, reviewFailures: 0, searchedSourceIds: [], searchReasons: [],
    };
  }
  return state.budget;
}

export function skillSlotWorkflow(slot: SlotBudget): SkillSlotWorkflow {
  return slot.skill ??= { version: 1, generationBase: 0, repairBase: 0, designAttempts: 0,
    designReviewFailures: 0, candidateRepairs: 0, verificationFailures: 0 };
}

export function grantSkillRecovery(state: RetryState, attempts: number) {
  const budget = state.budget;
  if (!budget || budget.skillRecovery || !(budget.sourceCount! > 0)) return false;
  if (state.failures.some((failure) => ["restricted_scope", "connection_changed", "save_error", "network_error", "network_timeout", "rate_limited", "lease_expired"].includes(failure.code))) return false;
  const slots = Object.entries(budget.slots).filter(([, slot]) => slot.type === "practical" && !slot.done && !slot.skill
    && slot.transportFailures < MAX_SLOT_TRANSPORT_FAILURES && slot.blocked
    && ["invalid_content", "duplicate", "quality_rejected", "review_invalid", "evidence_invalid", "angle_plan_invalid", "insufficient_basis"].includes(slot.blocked.code));
  if (!slots.length) return false;
  const addedCalls = Math.min(MAX_UNIT_MODEL_CALLS, slots.length * 24);
  budget.skillRecovery = { version: 1, attempts, previousCalls: budget.calls, previousMaxCalls: budget.maxCalls,
    addedCalls, slotIds: slots.map(([id]) => id), at: new Date().toISOString() };
  budget.maxCalls += addedCalls;
  for (const [id, slot] of slots) {
    slot.recoveredBlock = slot.blocked;
    slot.blocked = undefined;
    slot.skill = { version: 1, generationBase: slot.generations, repairBase: slot.repairs,
      designAttempts: 0, designReviewFailures: 0, candidateRepairs: 0, verificationFailures: 0 };
    budget.history = [...budget.history.slice(-59), { phase: "analysis", slotId: id,
      outcome: `管理员重试授权技能专项修复：新增3轮单候选及最多6次字段修复，历史生成${slot.generations}轮、修复${slot.repairs}次保留。`, at: new Date().toISOString() }];
  }
  state.stopReason = undefined;
  return true;
}

export function recoverPrematureBlocks(state: RetryState) {
  const budget = state.budget;
  if (!budget || budget.workflowVersion === 3 || budget.calls >= budget.maxCalls) return false;
  let recovered = false;
  for (const [id, slot] of Object.entries(budget.slots)) {
    if (slot.done || !slot.blocked || slot.transportFailures >= MAX_SLOT_TRANSPORT_FAILURES) continue;
    const trial = slot.blocked.code === "insufficient_basis" && slot.generations < MAX_SLOT_GENERATIONS
      && (budget.sourceCount ?? 0) > 0 && slot.searchedSourceIds.length === budget.sourceCount;
    const review = slot.blocked.code === "review_invalid" && Boolean(slot.pendingResponse);
    if (!trial && !review) continue;
    slot.recoveredBlock = slot.blocked;
    slot.blocked = undefined;
    if (trial) slot.trialDesign = true;
    if (review) slot.reviewMode = "single";
    budget.history = [...budget.history.slice(-59), {
      phase: trial ? "analysis" : "verification", slotId: id,
      outcome: `一次性流程恢复，累计预算保留：${slot.recoveredBlock.message}`, at: new Date().toISOString(),
    }];
    recovered = true;
  }
  if (recovered) {
    budget.workflowVersion = 3;
    state.stopReason = undefined;
  }
  return recovered;
}

export function nextTargetedSlot(state: RetryState) {
  return Object.entries(state.budget?.slots ?? {}).filter(([, slot]) => !slot.done && !slot.blocked)
    .sort((a, b) => a[1].ordinal - b[1].ordinal)[0];
}

export function targetedBudgetBlocked(state: RetryState) {
  if (!state.budget) return;
  if (state.budget.calls >= state.budget.maxCalls) return `本请求已达到${state.budget.maxCalls}次模型调用预算，请核对缺额和检索记录后人工处理。`;
  if (!nextTargetedSlot(state)) return "剩余缺题均需补充依据或人工命题，请查看逐题缺口记录；已有成果保留。";
}

export function recordTargetedPhase(state: RetryState, outcome: string) {
  const budget = state.budget;
  if (!budget?.activeSlotId || !budget.phase) return;
  budget.history = [...budget.history.slice(-59), {
    phase: budget.phase, slotId: budget.activeSlotId, outcome: outcome.slice(0, 1500), at: new Date().toISOString(),
  }];
}

export function markTargetedSaved(state: RetryState, slotId: string) {
  const slot = state.budget?.slots[slotId];
  if (!slot) return;
  slot.done = true;
  slot.pendingResponse = undefined;
  if (slot.angle) state.budget!.completedAngles.push(slot.angle);
  recordTargetedPhase(state, "已核验并保存到指定缺额槽位");
}
