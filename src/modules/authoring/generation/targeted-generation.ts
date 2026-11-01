import { parseQuestions, stemHash, type GeneratedQuestion, type Snapshot } from "./contracts";
import { anglePlanningPrompt, failureOf, GenerationFailure, parseAnglePlan, type AngleSource, type RequestOutput, type RetryFailure, type RetryState } from "./retry-policy";
import { MAX_SLOT_GENERATIONS, MAX_SLOT_REPAIRS, MAX_SLOT_TRANSPORT_FAILURES, nextTargetedSlot, recordTargetedPhase, type SlotBudget, type TargetedPhase } from "./targeted-budget";
import { nextEvidencePage } from "./evidence-catalog";
import { candidateReviewPrompt, parseCandidateReview } from "./candidate-review";
import { theoryQuestionPrompt } from "./theory-prompt";
import { skillQuestionPrompt } from "./skill-prompt";

type ModelInput = { instruction: string; prompt: string };
export type TargetedDependencies = {
  call: (input: ModelInput) => Promise<string>;
  persist: () => Promise<void>;
  signal: AbortSignal;
};

export async function generateTargeted(input: {
  snapshot: Snapshot; code: string; previous: Array<{ stem: string; content?: unknown; answer?: unknown; analysis?: string | null }>;
  sources: AngleSource[]; state: RetryState;
}, dependencies: TargetedDependencies): Promise<RequestOutput> {
  const { snapshot, code, previous, sources, state } = input;
  const budget = state.budget!;
  budget.sourceCount = sources.length;
  const active = nextTargetedSlot(state);
  if (!active) return { questions: [], failures: [], state };
  const [slotId, slot] = active;
  budget.activeSlotId = slotId;
  const kind = snapshot.scope.assessmentMode === "操作技能" ? "skill" : "theory";
  const failures: RetryFailure[] = [];
  const output = () => ({ questions: [], failures, state });
  const block = (failure: RetryFailure) => { slot.blocked = failure; failures.push(failure); };
  const call = async (phase: TargetedPhase, prompt: ModelInput) => {
    dependencies.signal.throwIfAborted();
    if (budget.calls >= budget.maxCalls) throw new GenerationFailure("model_error", "本请求模型调用预算已耗尽，未检索完不等于缺少依据，请查看查阅记录并人工处理。");
    budget.phase = phase;
    budget.calls++;
    await dependencies.persist();
    dependencies.signal.throwIfAborted();
    const response = await dependencies.call(prompt);
    dependencies.signal.throwIfAborted();
    recordTargetedPhase(state, "模型返回，等待对应阶段校验");
    return response;
  };
  try {
    if (!sources.length) {
      block({ code: "insufficient_basis", message: "本考评点关联教材和冻结标准均无可核验原文，请补充资料或人工命题，不编造依据。" });
      return output();
    }
    if (slot.angle && !sources.some((source) => source.id === slot.angle!.sourceId)) {
      slot.angle = undefined;
      slot.pendingResponse = undefined;
    }
    if (!slot.angle) {
      for (let pageIndex = 0; pageIndex < 2 && !slot.angle; pageIndex++) {
        const page = nextEvidencePage(sources, slot.searchedSourceIds);
        if (!page.length) {
          block({ code: "insufficient_basis", message: `已查阅本考评点全部${sources.length}段关联原文，仍未找到符合完整标准的${slot.type}考查任务。请补充依据或人工命题。` });
          return output();
        }
        const analysisPrompt = anglePlanningPrompt(code, snapshot.nodes.find((node) => node.code === code)!.name, slot.type,
          previous, page, state, { 职业: snapshot.scope.occupation, 等级: snapshot.scope.levelCode }, {
            kind, content: kind === "skill" ? snapshot.skillQualityStandard ?? "" : snapshot.qualityStandard,
            requirements: snapshot.qualityRequirements,
          });
        if (failures.length) analysisPrompt.prompt = JSON.stringify({ ...JSON.parse(analysisPrompt.prompt), 上次分析错误: failures.map((failure) => failure.message) });
        try {
          const content = await call("analysis", analysisPrompt);
          // Only successful saved tasks are excluded; failed attempts remain
          // available for repair or a genuinely different candidate.
          const plan = parseAnglePlan(content, previous.length, page, budget.completedAngles,
            kind === "theory" && slot.type !== "practical" ? slot.type : undefined);
          slot.angle = plan.selected;
          slot.evidenceSourceIds = page.map((source) => source.id);
          slot.searchedSourceIds = [...new Set([...slot.searchedSourceIds, ...page.map((source) => source.id)])];
          state.covered = plan.covered;
          state.selectedAngle = plan.selected;
          state.attemptedAngles = [...state.attemptedAngles.slice(-59), plan.selected];
        } catch (error) {
          const failure = failureOf(error);
          if (failure.code === "no_task_in_excerpt" || failure.code === "angle_duplicate") {
            slot.searchedSourceIds = [...new Set([...slot.searchedSourceIds, ...page.map((source) => source.id)])];
            slot.searchReasons = [...slot.searchReasons.slice(-19), failure.message];
          } else if (failure.code === "angle_plan_invalid" || failure.code === "evidence_invalid") {
            slot.analysisFailures++;
            failures.push(failure);
            if (slot.analysisFailures >= 2) {
              slot.blocked = { ...failure, message: `${failure.message}；分析或引用修复已达2次，请人工核对，不判定为原文不足。` };
              return output();
            }
          } else throw error;
        }
        await dependencies.persist();
      }
      if (!slot.angle) {
        if (nextEvidencePage(sources, slot.searchedSourceIds).length) {
          failures.push({ code: "search_pending", message: `已查阅${slot.searchedSourceIds.length}/${sources.length}段原文，继续检索其他关联段落。` });
        } else {
          block({ code: "insufficient_basis", message: `已查阅本考评点全部${sources.length}段原文，未找到符合完整质量标准的任务，请补充资料或人工命题。` });
        }
        return output();
      }
    }
    state.selectedAngle = slot.angle;
    const usedSources = sources.filter((source) => source.id === slot.angle!.sourceId || slot.evidenceSourceIds?.includes(source.id));
    let repairs: NonNullable<GeneratedQuestion["candidateRepairs"]> = slot.candidateRepairs ?? [];
    if (!slot.pendingResponse) {
      if (slot.generations >= MAX_SLOT_GENERATIONS) {
        block({ code: "invalid_content", message: "该缺题已生成3轮候选仍未通过完整标准，需人工命题；其他缺题继续处理。" });
        return output();
      }
      const count = kind === "skill" ? 2 : 3;
      const prompt = kind === "skill"
        ? skillQuestionPrompt(snapshot, code, count, previous.map((question) => question.stem))
        : theoryQuestionPrompt(snapshot, code, Array(count).fill(slot.type), previous, usedSources, slot.generations + 1, true);
      prompt.instruction += "\n本次为一个缺题槽位生成少量不同候选，不增加正式计划题数。候选只按完整质量标准择优填入一个槽位；不要复制已有题。必须使用系统提供的原文，不能把原文存在当作答案正确。";
      prompt.prompt = JSON.stringify({ ...JSON.parse(prompt.prompt), 本次候选数: count, 本次实际填槽数: 1,
        本次指定缺额题型: slot.type, 考查任务: slot.angle, 原文依据: usedSources, 上次具体错误: state.failures });
      slot.pendingResponse = await call("generation", prompt);
      slot.generations++;
      await dependencies.persist();
    }
    const parse = () => {
      try { return parseQuestions(slot.pendingResponse!, code, slot.type, snapshot.scope.occupation, { judgement: kind === "theory" }); }
      catch (error) { return { valid: [], invalidReasons: [error instanceof Error ? error.message : "候选JSON无效"], invalidCandidates: [] }; }
    };
    let parsed = parse();
    if (!parsed.valid.length && !parsed.invalidReasons.length) {
      failures.push({ code: "invalid_content", message: "模型没有返回候选，需重新设计有依据的任务，不将空结果当作格式错误反复修复。" });
      clearCandidates(slot, failures);
      return output();
    }
    while (!parsed.valid.length && slot.repairs < MAX_SLOT_REPAIRS) {
      const originalResponse = slot.pendingResponse!;
      const corrected = await call("repair", {
        instruction: "你是职业技能试题修订助手。修复给定候选及具体校验错误，不另找考评点、不降低完整质量标准。答案键和格式可修复，但答案对错、唯一解必须依据原文重新论证，不能猜答案或随意删除正确选项。无法保证正确性时返回questions=[]。只返回与原题相同结构的questions JSON数组。",
        prompt: JSON.stringify({
          职业: snapshot.scope.occupation, 等级: snapshot.scope.levelCode,
          考评点: { code, name: snapshot.nodes.find((node) => node.code === code)!.name }, 指定题型: slot.type,
          冻结依据: kind === "skill" ? snapshot.nodes.find((node) => node.code === code)!.skillContext : snapshot.nodes.find((node) => node.code === code)!.theoryContext,
          考查任务: slot.angle, 原始候选响应: originalResponse, 具体错误: parsed.invalidReasons,
          无效候选: parsed.invalidCandidates, 原文依据: usedSources, 已有试题: previous,
          [kind === "skill" ? "操作技能试题质量标准" : "试题质量标准"]: kind === "skill" ? snapshot.skillQualityStandard : snapshot.qualityStandard,
          质量要求: snapshot.qualityRequirements, 冻结内容结构: kind === "skill" ? snapshot.skillStructure : undefined,
        }),
      });
      slot.repairs++;
      repairs = [...repairs, { originalResponse, correctedResponse: corrected, errors: parsed.invalidReasons }];
      slot.candidateRepairs = repairs;
      slot.pendingResponse = corrected;
      await dependencies.persist();
      parsed = parse();
      if (!parsed.valid.length && !parsed.invalidReasons.length) break;
    }
    const previousHashes = new Set(previous.map((question) => stemHash(question.stem)));
    const candidates = parsed.valid.filter((question) => !previousHashes.has(stemHash(question.stem))).slice(0, 3);
    if (!candidates.length) {
      failures.push({ code: parsed.valid.length ? "duplicate" : "invalid_content",
        message: parsed.valid.length ? "候选题干与已有题重复，需重新设计任务，不仅换词改写。" : `候选修复后仍不合格：${parsed.invalidReasons.join("；") || "模型未提供可核验候选"}` });
      clearCandidates(slot, failures);
      return output();
    }
    try {
      const content = await call("verification", candidateReviewPrompt(snapshot, code, candidates, previous, usedSources));
      const review = parseCandidateReview(content, candidates, usedSources);
      if (review.questions.length) {
        slot.pendingResponse = undefined;
        slot.candidateRepairs = undefined;
        recordTargetedPhase(state, `通过完整标准核验，仅保存一个缺额；其他合格候选作为重复冲突备选。${review.failures.map((failure) => failure.message).join("；")}`);
        return { questions: review.questions.map((question) => ({ ...question, targetSlotId: slotId, candidateRepairs: repairs })),
          failures: [], state };
      }
      failures.push(...review.failures);
      clearCandidates(slot, failures);
    } catch (error) {
      const failure = failureOf(error);
      if (failure.code !== "review_invalid") throw error;
      slot.reviewFailures++;
      failures.push(failure);
      if (slot.reviewFailures >= 2) slot.blocked = { ...failure, message: `${failure.message}；请人工核验候选，不保存未核验内容。` };
    }
  } catch (error) {
    const failure = failureOf(error);
    failures.push(failure);
    if (["network_timeout", "network_error", "rate_limited", "invalid_json"].includes(failure.code)) {
      slot.transportFailures++;
      if (slot.transportFailures >= MAX_SLOT_TRANSPORT_FAILURES) slot.blocked = { ...failure, message: `${failure.message}；该槽位累计网络或响应异常已达上限，请检查模型连接。` };
    }
  }
  recordTargetedPhase(state, failures.map((failure) => failure.message).join("；"));
  return output();
}

function clearCandidates(slot: SlotBudget, failures: RetryFailure[]) {
  slot.rejectedCandidates = [...(slot.rejectedCandidates ?? []).slice(-2), {
    response: slot.pendingResponse ?? "", repairs: slot.candidateRepairs, angle: slot.angle,
    failures: failures.slice(), at: new Date().toISOString(),
  }];
  slot.pendingResponse = undefined;
  slot.candidateRepairs = undefined;
  slot.angle = undefined;
  // A failed generated candidate is not a successful knowledge coverage.
  // If every source was previously inspected, a new design may reuse it.
  if (slot.generations < MAX_SLOT_GENERATIONS) slot.searchedSourceIds = [];
}
