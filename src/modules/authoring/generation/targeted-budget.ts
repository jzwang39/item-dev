import type { GeneratedQuestion, QuestionType } from "./contracts";
import type { KnowledgeAngle, RetryFailure, RetryState } from "./retry-policy";

export const MAX_SLOT_GENERATIONS = 3;
export const MAX_SLOT_REPAIRS = 2;
export const MAX_SLOT_TRANSPORT_FAILURES = 3;
export const MAX_UNIT_MODEL_CALLS = 120;
export type MissingSlot = { id: string; ordinal: number; question_type: QuestionType };
export type TargetedPhase = "analysis" | "generation" | "repair" | "verification";
export type SlotBudget = {
  ordinal: number; type: QuestionType; generations: number; repairs: number; transportFailures: number;
  analysisFailures: number; reviewFailures: number; searchedSourceIds: string[]; searchReasons: string[];
  angle?: KnowledgeAngle; pendingResponse?: string; done?: boolean; blocked?: RetryFailure;
  evidenceSourceIds?: string[]; candidateRepairs?: GeneratedQuestion["candidateRepairs"];
  rejectedCandidates?: Array<{ response: string; repairs?: GeneratedQuestion["candidateRepairs"]; angle?: KnowledgeAngle; failures: RetryFailure[]; at: string }>;
};
export type TargetedBudget = {
  version: 2; calls: number; maxCalls: number; activeSlotId?: string; phase?: TargetedPhase;
  sourceCount?: number; slots: Record<string, SlotBudget>; completedAngles: KnowledgeAngle[];
  origin: { attempts: number; targetedAttempts: number; failures: RetryFailure[]; legacyError?: string | null; stopReason?: string };
  history: Array<{ phase: TargetedPhase; slotId: string; outcome: string; at: string }>;
};

export function ensureTargetedBudget(state: RetryState, missing: MissingSlot[], attempts: number, legacyError?: string | null) {
  state.budget ??= {
    version: 2, calls: 0, maxCalls: Math.min(MAX_UNIT_MODEL_CALLS, Math.max(24, missing.length * 16)),
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
