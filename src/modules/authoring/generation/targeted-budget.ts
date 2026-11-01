import { parseQuestions, stemHash, type GeneratedQuestion, type QuestionType } from "./contracts";
import type { AngleSource, KnowledgeAngle, RetryFailure, RetryState } from "./retry-policy";
import { parseSkillDesign, resolveSkillSources, type SkillTaskDesign } from "./skill-candidate";
import { designCorePassed, parseDesignReviewCore } from "./skill-design-review";
import type { Snapshot } from "./contracts";
import type { TheoryExpansionState } from "./theory-expansion";
import { factualTheorySources } from "./evidence-catalog";
import { curatedTheoryBasis, curatedTheoryBasisReplacement } from "./curated-theory-basis";
import { expansionReviewMalformed } from "./expansion-review-schema";
import { createHash } from "node:crypto";

export const MAX_SLOT_GENERATIONS = 3;
export const MAX_SLOT_REPAIRS = 2;
export const MAX_SLOT_TRANSPORT_FAILURES = 3;
export const MAX_UNIT_MODEL_CALLS = 120;
export const MAX_SKILL_REPAIRS = 6;
export type SkillSlotWorkflow = {
  version: 1; generationBase: number; repairBase: number; designAttempts: number;
  design?: SkillTaskDesign; designResponse?: string; designReviewResponse?: string;
  designReviewResponses?: string[];
  designProtocolVersion?: 2; designCoreResponse?: string; designChecklistResponses?: string[];
  designReviewContext?: string;
  designCoreFailures?: number; designChecklistFailures?: number;
  designProtocolRecovery?: { at: string; previousBlock: RetryFailure; designAttemptCredits: number };
  designReviewFailures: number; candidateRepairs: number; verificationFailures: number;
  reviewRepairResponse?: string; candidateCalculation?: GeneratedQuestion["scoringCalculation"];
};
export type MissingSlot = { id: string; ordinal: number; question_type: QuestionType };
export type TargetedPhase = "analysis" | "generation" | "repair" | "verification";
export type SlotBudget = {
  ordinal: number; type: QuestionType; generations: number; repairs: number; transportFailures: number;
  analysisFailures: number; reviewFailures: number; searchedSourceIds: string[]; searchReasons: string[];
  analysisSearchedSourceIds?: string[];
  theoryRedesignRecovery?: { at: string; previousBlock: RetryFailure; previousGenerations: number; extraGenerations: 1 };
  theoryPromptVersion?: 2;
  theoryEchoRecovery?: { at: string; previousBlock: RetryFailure; previousGenerations: number; previousCalls: number; extraGenerations: 1 };
  theoryBasisRecovery?: { at: string; previousBlock: RetryFailure; previousGenerations: number; extraGenerations: 1 };
  expansionRecovery?: { at: string; previousBlock: RetryFailure; previousGenerations: number; extraGenerations: 1 };
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
    skillDesignChecklistResponses?: string[];
    scoringCalculation?: GeneratedQuestion["scoringCalculation"] }>;
};
export type TargetedBudget = {
  version: 2; calls: number; maxCalls: number; activeSlotId?: string; phase?: TargetedPhase;
  workflowVersion?: 3;
  skillRecovery?: { version: 1; attempts: number; previousCalls: number; previousMaxCalls: number; addedCalls: number; slotIds: string[]; at: string };
  sourceCount?: number; slots: Record<string, SlotBudget>; completedAngles: KnowledgeAngle[];
  catalogIds?: string[]; theoryExpansion?: TheoryExpansionState;
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
  return slot.skill ??= { version: 1, designProtocolVersion: 2, generationBase: 0, repairBase: 0, designAttempts: 0,
    designReviewFailures: 0, candidateRepairs: 0, verificationFailures: 0 };
}

export function theoryGenerationLimit(slot: SlotBudget) {
  if (slot.theoryBasisRecovery) return slot.theoryBasisRecovery.previousGenerations + slot.theoryBasisRecovery.extraGenerations;
  if (slot.theoryEchoRecovery) return slot.theoryEchoRecovery.previousGenerations + slot.theoryEchoRecovery.extraGenerations;
  if (slot.expansionRecovery) return slot.expansionRecovery.previousGenerations + slot.expansionRecovery.extraGenerations;
  return slot.theoryRedesignRecovery
    ? slot.theoryRedesignRecovery.previousGenerations + slot.theoryRedesignRecovery.extraGenerations
    : MAX_SLOT_GENERATIONS;
}

export function recoverNoTextbookTheory(state: RetryState, snapshot: Pick<Snapshot, "scope" | "nodes">, code: string) {
  const budget = state.budget;
  const node = snapshot.nodes.find((item) => item.code === code);
  if (!budget || snapshot.scope.assessmentMode === "操作技能" || !node || node.chapterIds.length || budget.calls >= budget.maxCalls
    || state.failures.some((failure) => ["restricted_scope", "connection_changed", "save_error", "network_error",
      "network_timeout", "rate_limited", "lease_expired"].includes(failure.code))) return false;
  let recovered = false;
  for (const [id, slot] of Object.entries(budget.slots)) {
    const original = [...(slot.evidenceSources ?? []), ...(slot.rejectedCandidates?.flatMap((record) => record.evidenceSources ?? []) ?? [])];
    if (slot.type === "practical" || slot.done || slot.expansionRecovery || budget.theoryExpansion || !slot.blocked
      || slot.transportFailures >= MAX_SLOT_TRANSPORT_FAILURES || !["duplicate", "insufficient_basis", "evidence_invalid"].includes(slot.blocked.code)
      || !original.length || factualTheorySources(original).length) continue;
    slot.expansionRecovery = { at: new Date().toISOString(), previousBlock: slot.blocked,
      previousGenerations: slot.generations, extraGenerations: 1 };
    slot.blocked = undefined;
    slot.pendingResponse = undefined;
    slot.angle = undefined;
    slot.trialDesign = false;
    slot.analysisSearchedSourceIds = [];
    budget.history = [...budget.history.slice(-59), { phase: "analysis", slotId: id, at: new Date().toISOString(),
      outcome: "无教材标题不足一次性流程恢复：先下载并核验可靠扩展依据，最多追加1轮候选，历史调用和生成计数保留，不增加调用预算。" }];
    recovered = true;
  }
  if (recovered) state.stopReason = undefined;
  return recovered;
}

export function recoverCuratedTheoryBasis(state: RetryState, snapshot: Pick<Snapshot, "scope" | "nodes">, code: string) {
  const budget = state.budget;
  const evidence = budget?.theoryExpansion;
  if (!budget || !evidence || !curatedTheoryBasis(snapshot, code) || evidence.curatedRecovery || evidence.curatedBasisId
    || evidence.sources.length || evidence.documents.length || evidence.reviewAttempts !== 0 || evidence.discoveryAttempts < 2
    || budget.calls >= budget.maxCalls || state.failures.some((failure) => failure.code !== "insufficient_basis")) return false;
  const slots = Object.entries(budget.slots).filter(([, slot]) => !slot.done && slot.type === "single"
    && slot.generations === 0 && slot.transportFailures < MAX_SLOT_TRANSPORT_FAILURES && slot.blocked?.code === "insufficient_basis");
  if (!slots.length) return false;
  evidence.curatedRecovery = { at: new Date().toISOString(), previousBlocks: Object.fromEntries(slots.map(([id, slot]) => [id, slot.blocked!])),
    previousCalls: budget.calls, previousDiscoveryAttempts: evidence.discoveryAttempts };
  for (const [id, slot] of slots) {
    slot.blocked = undefined;
    budget.history = [...budget.history.slice(-59), { phase: "analysis", slotId: id, at: new Date().toISOString(),
      outcome: "新媒体传播考评点定向资料一次恢复：保留两轮无效地址检索及全部调用计数，使用版本化学术正文重新核验，不新增额度。" }];
  }
  state.stopReason = undefined;
  return true;
}

export function recoverExpansionReviewProtocol(state: RetryState, snapshot: Pick<Snapshot, "scope" | "nodes">, code: string) {
  const budget = state.budget;
  const evidence = budget?.theoryExpansion;
  const basis = curatedTheoryBasis(snapshot, code);
  if (!budget || !evidence || !basis || evidence.curatedBasisId !== basis.id || evidence.reviewProtocolRecovery
    || evidence.sources.length || evidence.reviewAttempts !== 2 || evidence.reviewResponses.length !== 2
    || !expansionReviewMalformed(evidence.reviewResponses[1]) || budget.calls >= budget.maxCalls
    || state.failures.some((failure) => failure.code !== "insufficient_basis")
    || evidence.documents.length !== 1 || evidence.documents[0].text !== basis.text || evidence.documents[0].url !== basis.url
    || evidence.documents[0].hash !== createHash("sha256").update(basis.text).digest("hex")) return false;
  const slots = Object.entries(budget.slots).filter(([, slot]) => !slot.done && slot.type === "single"
    && slot.generations === 0 && slot.transportFailures < MAX_SLOT_TRANSPORT_FAILURES && slot.blocked?.code === "insufficient_basis");
  if (!slots.length) return false;
  evidence.reviewProtocolRecovery = { at: new Date().toISOString(), previousAttempts: evidence.reviewAttempts,
    previousCalls: budget.calls, previousBlocks: Object.fromEntries(slots.map(([id, slot]) => [id, slot.blocked!])), extraReviews: 1 };
  for (const [id, slot] of slots) {
    slot.blocked = undefined;
    budget.history = [...budget.history.slice(-59), { phase: "verification", slotId: id, at: new Date().toISOString(),
      outcome: "定向资料核验协议一次恢复：原文及两次响应保留，追加最多1次完整独立核验，不翻转否定值、不清零计数、不增加调用预算。" }];
  }
  state.stopReason = undefined;
  return true;
}

export function recoverTheoryDuplicate(state: RetryState) {
  const budget = state.budget;
  if (!budget || budget.calls >= budget.maxCalls || !(budget.sourceCount! > 0)
    || state.failures.some((failure) => ["restricted_scope", "connection_changed", "save_error", "network_error",
      "network_timeout", "rate_limited", "lease_expired"].includes(failure.code))) return false;
  let recovered = false;
  for (const [id, slot] of Object.entries(budget.slots)) {
    if (slot.type === "practical" || slot.done || slot.theoryRedesignRecovery || slot.blocked?.code !== "duplicate"
      || slot.transportFailures >= MAX_SLOT_TRANSPORT_FAILURES || slot.generations !== MAX_SLOT_GENERATIONS
      || !slot.rejectedCandidates?.some((record) => record.response && record.evidenceSources?.length
        && record.failures.some((failure) => failure.code === "duplicate"))) continue;
    slot.theoryRedesignRecovery = { at: new Date().toISOString(), previousBlock: slot.blocked,
      previousGenerations: slot.generations, extraGenerations: 1 };
    slot.blocked = undefined;
    slot.angle = undefined;
    slot.trialDesign = false;
    slot.analysisSearchedSourceIds = [];
    slot.searchedSourceIds = [...new Set([...slot.searchedSourceIds,
      ...slot.rejectedCandidates.flatMap((record) => record.evidenceSources?.map((source) => source.id) ?? [])])];
    budget.history = [...budget.history.slice(-59), { phase: "analysis", slotId: id, at: new Date().toISOString(),
      outcome: "理论重复失败一次性重设计：累计3轮保留，追加最多1轮候选，明确排除被拒绝的重复任务，不新增模型调用预算或降低质量标准。" }];
    recovered = true;
  }
  if (recovered) state.stopReason = undefined;
  return recovered;
}

export function recoverTheoryBasisRevision(state: RetryState, snapshot: Pick<Snapshot, "scope" | "nodes">, code: string) {
  const budget = state.budget, evidence = budget?.theoryExpansion;
  const replacement = curatedTheoryBasisReplacement(snapshot, code);
  if (!budget || !evidence || !replacement || evidence.basisRevision || budget.maxCalls - budget.calls < 3
    || evidence.curatedBasisId !== replacement.previous.id
    || state.failures.some((failure) => !["duplicate", "evidence_invalid"].includes(failure.code))
    || !evidence.documents.some((document) => document.text === replacement.previous.text && document.url === replacement.previous.url
      && document.hash === createHash("sha256").update(replacement.previous.text).digest("hex"))) return false;
  const slots = Object.entries(budget.slots).filter(([, slot]) => !slot.done && slot.type === "single"
    && !slot.theoryBasisRecovery && !slot.pendingResponse && slot.transportFailures < MAX_SLOT_TRANSPORT_FAILURES
    && slot.blocked && ["duplicate", "evidence_invalid"].includes(slot.blocked.code));
  if (!slots.length) return false;
  const at = new Date().toISOString();
  evidence.basisRevision = { fromId: replacement.previous.id, toId: replacement.next.id, at,
    previousSources: evidence.sources, previousReviewAttempts: evidence.reviewAttempts, previousCalls: budget.calls };
  evidence.sources = [];
  evidence.curatedBasisId = replacement.next.id;
  for (const [id, slot] of slots) {
    slot.theoryBasisRecovery = { at, previousBlock: slot.blocked!, previousGenerations: slot.generations, extraGenerations: 1 };
    slot.blocked = undefined;
    slot.angle = undefined;
    slot.trialDesign = false;
    slot.analysisSearchedSourceIds = [];
    slot.evidenceSourceIds = [];
    slot.singleReviews = undefined;
    slot.reviewMode = undefined;
    budget.history = [...budget.history.slice(-59), { phase: "verification", slotId: id, at,
      outcome: "管理员重试触发评估指标资料修订：原传播主体资料及核验、候选、计数完整保留；新指标定义须重新核验，最多生成1轮新候选，不增加模型调用上限。" }];
  }
  state.selectedAngle = undefined;
  state.stopReason = undefined;
  return true;
}

export function recoverTheoryEcho(state: RetryState, snapshot: Pick<Snapshot, "scope" | "nodes">, code: string) {
  const budget = state.budget;
  if (!budget || snapshot.scope.assessmentMode !== "理论知识" || budget.reviewContext?.kind !== "theory"
    || budget.maxCalls - budget.calls < 3 || state.failures.some((failure) => failure.code !== "duplicate")) return false;
  const previous = new Set(budget.reviewContext.previous.map((question) => stemHash(question.stem)));
  let recovered = false;
  for (const [id, slot] of Object.entries(budget.slots)) {
    if (slot.done || slot.type === "practical" || slot.theoryPromptVersion === 2 || slot.theoryEchoRecovery
      || slot.blocked?.code !== "duplicate" || slot.transportFailures >= MAX_SLOT_TRANSPORT_FAILURES
      || slot.generations < theoryGenerationLimit(slot) || slot.pendingResponse) continue;
    const records = slot.rejectedCandidates?.slice(-2);
    if (!records || records.length !== 2 || records[0].response !== records[1].response
      || records.some((record) => !record.failures.length || record.failures.some((failure) => failure.code !== "duplicate")
        || !factualTheorySources(record.evidenceSources ?? []).length)) continue;
    try {
      const parsed = parseQuestions(records[1].response, code, slot.type, snapshot.scope.occupation);
      if (!parsed.valid.length || parsed.invalidReasons.length || parsed.valid.some((question) => !previous.has(stemHash(question.stem)))) continue;
    } catch { continue; }
    slot.theoryEchoRecovery = { at: new Date().toISOString(), previousBlock: slot.blocked,
      previousGenerations: slot.generations, previousCalls: budget.calls, extraGenerations: 1 };
    slot.blocked = undefined;
    slot.angle = undefined;
    slot.trialDesign = false;
    slot.analysisSearchedSourceIds = [];
    budget.history = [...budget.history.slice(-59), { phase: "analysis", slotId: id, at: new Date().toISOString(),
      outcome: "旧版连续复述已有题一次性恢复：隔离旧题答案与原始失败响应，仅生成1道新候选；追加最多1轮，历史计数及调用上限保留，仍须查重和完整核验。" }];
    recovered = true;
  }
  if (recovered) state.stopReason = undefined;
  return recovered;
}

export function recoverSkillDesignProtocol(state: RetryState) {
  const budget = state.budget;
  if (!budget || budget.calls >= budget.maxCalls || state.failures.some((failure) =>
    ["restricted_scope", "connection_changed", "save_error", "network_error", "network_timeout", "rate_limited", "lease_expired"].includes(failure.code))) return false;
  let recovered = false;
  for (const [id, slot] of Object.entries(budget.slots)) {
    const skill = slot.skill;
    if (!skill || skill.designProtocolVersion === 2 || skill.designProtocolRecovery || slot.done || slot.type !== "practical"
      || slot.transportFailures >= MAX_SLOT_TRANSPORT_FAILURES || slot.blocked?.code !== "review_invalid"
      || !/任务设计核验格式.*requirements/s.test(slot.blocked.message) || slot.generations !== skill.generationBase) continue;
    const records = (slot.rejectedCandidates ?? []).filter((record) => {
      if (!record.skillDesignResponse || !record.evidenceSources?.length || !record.failures.length
        || !record.failures.every((failure) => failure.code === "review_invalid" && /任务设计核验格式.*requirements/s.test(failure.message))) return false;
      try {
        const core = parseDesignReviewCore(record.skillDesignReviewResponses?.at(-1) ?? record.skillDesignReviewResponse ?? "");
        parseSkillDesign(record.skillDesignResponse, record.evidenceSources);
        resolveSkillSources(core.sourceIds, record.evidenceSources);
        return designCorePassed(core);
      } catch { return false; }
    });
    const record = records.at(-1);
    const raw = record?.skillDesignReviewResponses?.at(-1) ?? record?.skillDesignReviewResponse;
    if (!record || !raw) continue;
    try {
      const evidence = record.evidenceSources!;
      const core = parseDesignReviewCore(raw);
      if (!designCorePassed(core)) continue;
      resolveSkillSources(core.sourceIds, evidence);
      const design = parseSkillDesign(record.skillDesignResponse!, evidence);
      skill.designProtocolRecovery = { at: new Date().toISOString(), previousBlock: slot.blocked,
        designAttemptCredits: Math.min(2, records.length - 1) };
      skill.designProtocolVersion = 2;
      skill.design = design;
      skill.designResponse = record.skillDesignResponse;
      skill.designCoreResponse = undefined;
      skill.designReviewResponse = undefined;
      skill.designReviewResponses = record.skillDesignReviewResponses?.slice() ?? [raw];
      slot.evidenceSources = evidence;
      slot.evidenceSourceIds = evidence.map((source) => source.id);
      slot.blocked = undefined;
      budget.history = [...budget.history.slice(-59), { phase: "verification", slotId: id, at: new Date().toISOString(),
        outcome: `设计核验协议一次性恢复：保留累计${skill.designAttempts}轮设计，${skill.designProtocolRecovery.designAttemptCredits}轮纯格式误耗单独留痕；续核验原设计，不新增调用额度。` }];
      recovered = true;
    } catch { /* Invalid or unsupported historical records cannot be recovered. */ }
  }
  if (recovered) state.stopReason = undefined;
  return recovered;
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
  if (!nextTargetedSlot(state)) return "剩余缺题已因逐题额度或校验失败关闭，不等同于依据不足；请查看具体记录并补充资料或人工命题，已有成果保留。";
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
