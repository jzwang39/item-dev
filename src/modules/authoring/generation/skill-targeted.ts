import { stemHash, type GeneratedQuestion, type Snapshot } from "./contracts";
import { candidateReviewPrompt, parseCandidateReview } from "./candidate-review";
import { GenerationFailure, type AngleSource, type RequestOutput, type RetryFailure, type RetryState } from "./retry-policy";
import { MAX_SKILL_REPAIRS, recordTargetedPhase, skillSlotWorkflow, type SlotBudget, type TargetedPhase } from "./targeted-budget";
import { aliasedSources, applySkillPatch, parseSkillCandidate, parseSkillDesign, resolveSkillSources, skillCandidateIssues, skillRepairFields } from "./skill-candidate";
import { skillQuestionPrompt } from "./skill-prompt";
import { designCorePassed, parseDesignRequirements, parseDesignReviewCore } from "./skill-design-review";

type ModelInput = { instruction: string; prompt: string };
type SkillInput = { snapshot: Snapshot; code: string; previous: Array<{ stem: string; content?: unknown; answer?: unknown; analysis?: string | null }>;
  sources: AngleSource[]; state: RetryState; slotId: string; slot: SlotBudget };
type Dependencies = { call: (phase: TargetedPhase, input: ModelInput) => Promise<string>; persist: () => Promise<void>; signal: AbortSignal };

export async function generateSkillTargeted(input: SkillInput, dependencies: Dependencies): Promise<RequestOutput> {
  const { snapshot, code, previous, sources, state, slot, slotId } = input;
  const workflow = skillSlotWorkflow(slot);
  workflow.designProtocolVersion = 2;
  const failures: RetryFailure[] = [];
  const output = () => ({ questions: [], failures, state });
  const fail = (code: RetryFailure["code"], message: string) => {
    failures.push({ code, message });
    recordTargetedPhase(state, message);
  };
  const common = {
    职业: snapshot.scope.occupation, 等级: snapshot.scope.levelCode,
    考评点: snapshot.nodes.find((node) => node.code === code), 冻结内容结构: snapshot.skillStructure,
    操作技能试题质量标准: snapshot.skillQualityStandard ?? "", 质量要求: snapshot.qualityRequirements,
    已有试题: previous,
  };
  const reviewContext = JSON.stringify(common);
  if (workflow.designReviewContext !== reviewContext) {
    workflow.designCoreResponse = undefined;
    workflow.designChecklistResponses = undefined;
    workflow.designReviewResponse = undefined;
    workflow.designReviewContext = reviewContext;
  }
  const designLimit = 3 + (workflow.designProtocolRecovery?.designAttemptCredits ?? 0);
  const rejectCandidate = () => {
    slot.rejectedCandidates = [...(slot.rejectedCandidates ?? []), {
      response: slot.pendingResponse ?? "", repairs: slot.candidateRepairs, failures: failures.slice(),
      at: new Date().toISOString(), evidenceSources: slot.evidenceSources, reviewResponses: slot.reviewResponses,
      skillDesignResponse: workflow.designResponse, skillDesignReviewResponse: workflow.designReviewResponse,
      skillDesignReviewResponses: workflow.designReviewResponses,
      skillDesignChecklistResponses: workflow.designChecklistResponses,
      scoringCalculation: workflow.candidateCalculation,
    }];
    slot.pendingResponse = undefined;
    slot.candidateRepairs = undefined;
    slot.reviewResponses = undefined;
    workflow.design = undefined;
    workflow.designReviewResponse = undefined;
    workflow.designReviewResponses = undefined;
    workflow.designCoreResponse = undefined;
    workflow.designChecklistResponses = undefined;
    workflow.designCoreFailures = 0;
    workflow.designChecklistFailures = 0;
    workflow.designReviewFailures = 0;
    workflow.candidateRepairs = 0;
    workflow.verificationFailures = 0;
    workflow.reviewRepairResponse = undefined;
    workflow.candidateCalculation = undefined;
    if (slot.generations - workflow.generationBase >= 3 || workflow.designAttempts >= designLimit) {
      slot.blocked = failures[0] ?? { code: "invalid_content", message: "技能专项候选预算已耗尽，请人工核查。" };
    }
  };
  if (!snapshot.skillQualityStandard?.trim()) {
    slot.blocked = { code: "model_error", message: "缺少完整操作技能试题质量标准，不能用理论标准或空标准代替。" };
    failures.push(slot.blocked);
    return output();
  }
  if (!snapshot.nodes.find((node) => node.code === code)?.skillContext || !snapshot.skillStructure || !sources.length) {
    slot.blocked = { code: "insufficient_basis", message: "技能任务缺少冻结标准依据或内容结构，不能试制或猜测补齐。" };
    failures.push(slot.blocked);
    return output();
  }
  if (!workflow.design && !slot.pendingResponse) {
    slot.angle = undefined;
    state.selectedAngle = undefined;
    if (workflow.designAttempts >= designLimit || slot.generations - workflow.generationBase >= 3) {
      slot.blocked = { code: "invalid_content", message: "技能专项3轮任务设计或候选生成已耗尽，请人工核查具体缺口。" };
      failures.push(slot.blocked);
      return output();
    }
    const start = (workflow.designAttempts * 6) % sources.length;
    const page = [...sources.slice(start), ...sources.slice(0, start)].slice(0, 6);
    slot.evidenceSources = page;
    slot.evidenceSourceIds = page.map((source) => source.id);
    const response = await dependencies.call("analysis", {
      instruction: `你是技能任务设计助手。先设计一个完整实操任务，不输出试题或分值。
严格依据当前鉴定点、等级、方向及冻结标准，逐条遵守操作技能试题质量标准。综合点必须覆盖所属完整过程，不能缩减为子技能。
给出任务情境、明确标注的模拟输入材料、工作要求、可观察提交成果、完整操作步骤、评分观察点和与已有任务的实质差异。
不得仅换名称数字凑不同任务，不得编造正式工具、阈值、时间或国家规定；未知正式参数保持待核对。设计方案还须独立核验。
sourceIds只能选输入中的短编号S1等，由系统确定性映射到冻结原文，禁止自行构造引用。
只返回JSON：{"scenario":"任务情境","materials":["模拟输入材料"],"requirements":["完整工作要求"],"deliverables":["可观察提交成果"],"steps":["完整操作步骤"],"observations":["可核验表现"],"sourceIds":["S1"],"difference":"与已有题实际操作任务的差异"}。`,
      prompt: JSON.stringify({ ...common, 原文依据: aliasedSources(page),
        已拒绝方案与具体原因: slot.rejectedCandidates, 上次失败: state.failures, 本次设计轮次: workflow.designAttempts + 1 }),
    });
    workflow.designAttempts++;
    workflow.designResponse = response;
    slot.searchedSourceIds = [...new Set([...slot.searchedSourceIds, ...page.map((source) => source.id)])];
    try { workflow.design = parseSkillDesign(response, page); }
    catch (error) {
      const issues = skillCandidateIssues(error);
      fail(issues.some((item) => /来源编号/.test(item)) ? "evidence_invalid" : "angle_plan_invalid", `技能任务设计：${issues.join("；")}`);
      slot.searchReasons.push(failures[0].message);
      slot.rejectedCandidates = [...(slot.rejectedCandidates ?? []), { response: "", failures: failures.slice(),
        at: new Date().toISOString(), evidenceSources: page, skillDesignResponse: response }];
      if (workflow.designAttempts >= designLimit) slot.blocked = failures[0];
      await dependencies.persist();
      return output();
    }
    await dependencies.persist();
  }
  const evidence = slot.evidenceSources ?? sources.filter((source) => slot.evidenceSourceIds?.includes(source.id));
  if (!evidence.length) {
    slot.blocked = { code: "evidence_invalid", message: "历史候选的来源无法在冻结目录定位，不能默认核验通过。" };
    failures.push(slot.blocked);
    return output();
  }
  if (workflow.design && !workflow.designReviewResponse && !slot.pendingResponse) {
    const response = workflow.designCoreResponse ?? await dependencies.call("verification", {
      instruction: `你是技能任务设计核验助手。只核验设计，不生成试题。逐条对照完整操作技能质量标准、冻结范围和原文。
核对情境、材料、工作要求、操作步骤、提交成果、评分观察点及任务差异。原文存在不等于支持任务；综合点必须覆盖完整归属。
任何不确定、依据不足、仅换措辞或遗漏适用标准要求必须判不通过；不得因缺题降低标准。sourceIds只用输入提供的S编号。
只返回JSON：{"evidenceSupported":true,"completeTask":true,"correctScope":true,"distinctTask":true,"meetsQualityStandard":true,"explanation":"逐项核验理由","sourceIds":["S1"],"requirements":[{"requirement":"适用标准原文要求","passed":true,"explanation":"核验理由"}]}。`,
      prompt: JSON.stringify({ ...common, 任务设计: workflow.design, 原文依据: aliasedSources(evidence),
        上次核验格式错误: slot.searchReasons.at(-1), 上次核验响应: workflow.designReviewResponses?.at(-1) }),
    });
    if (!workflow.designCoreResponse) {
      workflow.designReviewResponses = [...(workflow.designReviewResponses ?? []), response];
      await dependencies.persist();
    }
    let core: ReturnType<typeof parseDesignReviewCore>;
    try {
      core = parseDesignReviewCore(response);
      resolveSkillSources(core.sourceIds, evidence);
      if (!designCorePassed(core)) {
        workflow.designReviewResponse = response;
        fail("quality_rejected", `任务设计未通过专项标准：${core.explanation}`);
        rejectCandidate();
        await dependencies.persist();
        return output();
      }
    } catch (error) {
      workflow.designReviewFailures++;
      workflow.designCoreFailures = (workflow.designCoreFailures ?? 0) + 1;
      fail("review_invalid", `任务设计核验格式：${skillCandidateIssues(error).join("；")}`);
      slot.searchReasons.push(failures[0].message);
      if (workflow.designCoreFailures >= 2) slot.blocked = failures[0];
      await dependencies.persist();
      return output();
    }
    workflow.designCoreResponse = response;
    await dependencies.persist();
    let requirements: ReturnType<typeof parseDesignRequirements> | undefined;
    // Missing per-standard judgments are never filled with default passes.
    // Ask a separate, smaller protocol to audit the unchanged design instead.
    try { requirements = parseDesignRequirements(response); }
    catch { /* Continue with an independent per-standard audit below. */ }
    if (!requirements) {
      const checklist = await dependencies.call("verification", {
        instruction: `你是技能标准逐条核验助手。只返回requirements字段，不输出任务设计、不生成试题。
必须逐条对照完整操作技能试题质量标准及质量要求，列出所有适用条款原文、是否通过及具体核验理由。
核对给定任务设计的情境、材料、工作要求、步骤、成果、评分观察点、归属和与已有任务的实质差异。不能确认时passed=false。
禁止因基础结论通过、题数不足或前一响应漏字段而默认通过；不得把设计的工作要求字符串数组当成核验结果。
只返回JSON：{"requirements":[{"requirement":"适用标准原文条款","passed":false,"explanation":"对应设计内容及核验依据或失败原因"}]}。`,
        prompt: JSON.stringify({ ...common, 任务设计: workflow.design, 原文依据: aliasedSources(evidence),
          基础核验响应: response, 上次逐条核验响应: workflow.designChecklistResponses?.at(-1),
          上次格式错误: slot.searchReasons.at(-1), 必须返回字段: "requirements：非空对象数组，每项包含requirement、passed布尔值、explanation" }),
      });
      workflow.designChecklistResponses = [...(workflow.designChecklistResponses ?? []), checklist];
      await dependencies.persist();
      try { requirements = parseDesignRequirements(checklist); }
      catch (error) {
        workflow.designReviewFailures++;
        workflow.designChecklistFailures = (workflow.designChecklistFailures ?? 0) + 1;
        fail("review_invalid", `任务设计逐条标准核验格式：${skillCandidateIssues(error).join("；")}`);
        slot.searchReasons.push(failures[0].message);
        if (workflow.designChecklistFailures >= 2) slot.blocked = failures[0];
        await dependencies.persist();
        return output();
      }
    }
    if (requirements.some((item) => !item.passed)) {
      fail("quality_rejected", `任务设计标准条款未通过：${requirements.filter((item) => !item.passed).map((item) => `${item.requirement}：${item.explanation}`).join("；")}`);
      rejectCandidate();
      await dependencies.persist();
      return output();
    }
    workflow.designReviewResponse = JSON.stringify({ ...core, requirements });
    recordTargetedPhase(state, "技能任务设计通过独立核验，进入单候选生成");
    await dependencies.persist();
  }
  if (!slot.pendingResponse) {
    const prompt = skillQuestionPrompt(snapshot, code, 1, previous.map((question) => question.stem));
    prompt.instruction += `
本次专项生成且仅生成1道候选，按已经独立核验的任务设计填写完整题干、操作步骤和解析；每个answers元素必须是完整操作步骤，不用序号、标签或待核对三字替代步骤。
本次评分采用weightedRubric代替scoreRubric：{"totalScore":100,"criteria":[{"item":"评分项目","weight":1,"rationale":"权重的技能重要性依据","standard":"可核验的评分表现"}]}。
沿用现有100分制候选模板，与正式组卷配分分开。程序按有理由的正权重计算0.01分精度配分，不能编造正式评分规定。不要自行计算score；权重和评分含义仍须完整质量核验和人工审定。
不得用文字填充过字数门槛。缺少真实任务条件或操作依据时不要强行输出。`;
    prompt.prompt = JSON.stringify({ ...JSON.parse(prompt.prompt), 任务设计: workflow.design,
      原文依据: evidence, 本次候选数: 1, 历史拒绝候选: slot.rejectedCandidates });
    slot.pendingResponse = await dependencies.call("generation", prompt);
    slot.generations++;
    workflow.candidateRepairs = 0;
    workflow.verificationFailures = 0;
    await dependencies.persist();
  }
  let question: GeneratedQuestion | undefined;
  let issues: string[] = [];
  const parse = () => {
    try {
      const parsed = parseSkillCandidate(slot.pendingResponse!, code, snapshot.scope.occupation);
      question = parsed.question;
      workflow.candidateCalculation = question.scoringCalculation;
      issues = [];
    } catch (error) { question = undefined; issues = skillCandidateIssues(error); }
  };
  parse();
  while (!question && workflow.candidateRepairs < 2 && slot.repairs - workflow.repairBase < MAX_SKILL_REPAIRS) {
    const originalResponse: string = slot.pendingResponse!;
    const originalIssues = issues.slice();
    const fields = skillRepairFields(issues);
    const patch = await dependencies.call("repair", {
      instruction: `你是技能字段修订助手。仅修复指定错误字段，保留其他已正确内容；不换考评点、不降低完整操作技能标准，不编造条件或填充文字。
参考答案修复必须给出真实完整操作步骤，评分修复必须给出正权重、重要性理由和可核验表现，不能改100分总分。
${fields.length ? '只返回JSON：{"patch":{"指定字段":"修复后的内容"}}。禁止返回或改写未指定字段。' : "原JSON不可定位，仅恢复完整questions对象结构，必须保留原候选事实、任务和答案，不默认补正确答案。"}
修复结果还要重新结构校验和完整质量核验，不代表通过。`,
      prompt: JSON.stringify({ ...common, 任务设计: workflow.design, 原文依据: evidence,
        原始候选响应: originalResponse, 具体字段错误: issues, 允许修复字段: fields, 上次字段修复: slot.candidateRepairs?.at(-1) }),
    });
    slot.repairs++;
    workflow.candidateRepairs++;
    try { slot.pendingResponse = fields.length ? applySkillPatch(originalResponse, patch, fields) : patch; }
    catch (error) { issues = skillCandidateIssues(error); }
    slot.candidateRepairs = [...(slot.candidateRepairs ?? []), {
      originalResponse, correctedResponse: slot.pendingResponse!, errors: originalIssues, patchResponse: patch, fields,
    }];
    await dependencies.persist();
    parse();
  }
  if (!question) {
    fail("invalid_content", `技能候选字段修复仍不合格：${issues.join("；")}`);
    rejectCandidate();
    await dependencies.persist();
    return output();
  }
  if (previous.some((item) => stemHash(item.stem) === stemHash(question!.stem))) {
    fail("duplicate", "技能候选与已有题干重复，下一轮须重新设计实际任务，不只换词改写。");
    rejectCandidate();
    await dependencies.persist();
    return output();
  }
  // Alias mapping is used only for citation identifiers, never to infer a pass.
  const prompt = candidateReviewPrompt(snapshot, code, [question], previous, aliasedSources(evidence));
  if (slot.reviewResponses?.length) prompt.prompt = JSON.stringify({ ...JSON.parse(prompt.prompt),
    上次核验响应: slot.reviewResponses.at(-1)?.response, 上次核验具体错误: slot.searchReasons.at(-1),
    返回要求: "重新核验所有适用标准和全部字段，必须返回完整checks对象，不能默认补通过值。" });
  const response = await dependencies.call("verification", prompt);
  slot.reviewResponses = [...(slot.reviewResponses ?? []), { mode: "single", index: 0, response }];
  await dependencies.persist();
  try {
    const review = parseCandidateReview(response, [question], aliasedSources(evidence));
    if (!review.questions.length) {
      failures.push(...review.failures);
      rejectCandidate();
      await dependencies.persist();
      return output();
    }
    const accepted = review.questions[0];
    accepted.standardReview.evidenceSourceIds = resolveSkillSources(accepted.standardReview.evidenceSourceIds, evidence);
    recordTargetedPhase(state, "技能单候选通过完整专项核验，权重及程序配分留痕，仍为待人工审定草稿");
    return { questions: [{ ...accepted, targetSlotId: slotId, candidateRepairs: slot.candidateRepairs }], failures: [], state };
  } catch (error) {
    if (!(error instanceof GenerationFailure) || error.code !== "review_invalid") throw error;
    workflow.verificationFailures++;
    fail("review_invalid", `技能核验响应错误：${error.message}`);
    slot.searchReasons.push(failures[0].message);
    // Retain the exact candidate; the next call explicitly fixes the schema and
    // re-verifies content rather than fabricating missing boolean decisions.
    if (workflow.verificationFailures >= 2) {
      fail("review_invalid", "该候选专项核验格式修复已达2次，保留原候选及核验响应；仍有额度时重新设计下一候选，不保存未经核验内容。");
      rejectCandidate();
    }
    await dependencies.persist();
    return output();
  }
}
