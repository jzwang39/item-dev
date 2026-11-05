import { z } from "zod";
import type { GeneratedQuestion, Snapshot } from "./contracts";
import { GenerationFailure, type AngleSource } from "./retry-policy";
import { generationQualityPolicy } from "./quality-policy";
import { parseModelJson, skillCandidateIssues } from "./skill-candidate";

const reviewSchema = z.object({
  checks: z.array(z.object({
    index: z.number().int().nonnegative(),
    meetsQualityStandard: z.boolean(), answerCorrect: z.boolean(), evidenceSupported: z.boolean(), distinctTask: z.boolean(),
    score: z.number().min(0).max(100), explanation: z.string().trim().min(4).max(4000),
    evidenceSourceIds: z.array(z.string()).min(1).max(12),
    requirements: z.array(z.object({
      requirement: z.string().trim().min(2), passed: z.boolean(), explanation: z.string().trim().min(2),
    })).min(1).max(100),
  })).min(1).max(3),
});

function normalizeStemText(value: string) {
  return value.normalize("NFKC").replace(/\s+/g, "");
}

function longestSharedSegment(a: string, b: string) {
  let longest = "";
  for (let start = 0; start < a.length; start++) {
    for (let end = start + 4; end <= a.length; end++) {
      const fragment = a.slice(start, end);
      if (fragment.length <= longest.length) continue;
      if (b.includes(fragment)) longest = fragment;
    }
  }
  return longest;
}

function candidateFormatFailures(candidate: GeneratedQuestion) {
  const failures: string[] = [];
  if (candidate.questionType !== "single") return failures;
  if (candidate.stem.includes("（　　）")) failures.push("单选题题干括号必须使用半角(　　)，不能使用全角（　　）。");
  if (!candidate.stem.includes("(　　)") && !candidate.stem.includes("（　　）")) return failures;
  const answer = candidate.answers[0];
  const correct = candidate.options.find((option) => option.key === answer)?.content;
  if (!correct) return failures;
  const stem = normalizeStemText(candidate.stem);
  const normalizedCorrect = normalizeStemText(correct);
  const overlap = longestSharedSegment(normalizedCorrect, stem);
  if (overlap.length >= 4 && overlap.length / normalizedCorrect.length >= 0.35) {
    failures.push(`题干已直接出现正确项核心词“${overlap}”，形成词面提示，未落在需要实质理解的区分上。`);
  }
  return failures;
}

function candidateScopeFailures(candidate: GeneratedQuestion, context?: { pointName?: string; kind?: "theory" | "skill" }) {
  const failures: string[] = [];
  if (context?.kind !== "theory" || !context.pointName || candidate.questionType !== "single") return failures;
  if (!/基本原则/u.test(context.pointName)) return failures;
  const stem = normalizeStemText(candidate.stem);
  const analysis = normalizeStemText(candidate.analysis);
  const options = candidate.options.map((option) => normalizeStemText(option.content));
  const asksDonorDefinition = /捐赠人/u.test(stem)
    && /(主体范围|范围是|可以成为|是指|定义|包括哪些|属于哪些)/u.test(stem);
  const optionListsSubjectRange = options.some((option) => /自然人|法人|其他组织/u.test(option))
    || options.some((option) => /受益人/u.test(option));
  const analysisTreatsAsDefinition = /捐赠人/u.test(analysis)
    && /(自然人|法人|其他组织|主体范围|术语定义|范围界定)/u.test(analysis);
  if (asksDonorDefinition && (optionListsSubjectRange || analysisTreatsAsDefinition)) {
    failures.push(`当前考评点“${context.pointName}”应考原则判断、适用条件或行为辨析，不应把“捐赠人”主体范围或术语定义当作主要考核目标。`);
  }
  return failures;
}

export function localCandidateFailures(candidate: GeneratedQuestion, context?: { pointName?: string; kind?: "theory" | "skill" }) {
  return [...candidateFormatFailures(candidate), ...candidateScopeFailures(candidate, context)];
}

function normalizeReviewPayload(content: string) {
  const payload = parseModelJson(content) as { checks?: unknown };
  const checks = Array.isArray(payload?.checks) ? payload.checks : [];
  return {
    ...payload,
    checks: checks.map((value) => {
      if (!value || typeof value !== "object") return value;
      const item = value as Record<string, unknown>;
      const rawRequirements = item.requirements
        ?? item.requirementChecks
        ?? item.criteria
        ?? item.rules
        ?? (typeof item.explanation === "string"
          ? [{
              requirement: "完整质量标准核验",
              passed: Boolean(item.meetsQualityStandard),
              explanation: item.explanation,
            }]
          : undefined);
      const requirements = Array.isArray(rawRequirements)
        ? rawRequirements.map((entry) => {
            if (!entry || typeof entry !== "object") return entry;
            const requirement = entry as Record<string, unknown>;
            return {
              requirement: requirement.requirement ?? requirement.name ?? requirement.rule ?? requirement.item ?? requirement.check,
              passed: requirement.passed ?? requirement.ok ?? requirement.result,
              explanation: requirement.explanation ?? requirement.reason ?? requirement.detail ?? requirement.note,
            };
          })
        : rawRequirements;
      return { ...item, requirements };
    }),
  };
}

export function candidateReviewPrompt(snapshot: Snapshot, code: string, candidates: GeneratedQuestion[], previous: unknown[], sources: AngleSource[]) {
  const kind = snapshot.scope.assessmentMode === "操作技能" ? "skill" : "theory";
  const point = snapshot.nodes.find((node) => node.code === code);
  const principleRule = kind === "theory" && /基本原则/u.test(point?.name ?? "")
    ? "\n若考评点名称含“基本原则”，候选应考原则判断、适用条件、行为辨析或职责边界，不得仅考术语定义、主体范围、概念列举或分类记忆。"
    : "";
  return {
    instruction: `你是职业技能试题独立核验助手，只核验候选，不改写试题。必须逐条对照输入中的完整对应质量标准，禁止以缺题、成本或题数为由降低任何要求。
核对题干、条件、所有选项、答案及解析；单选必须唯一正确，多选答案集合必须完整且唯一确定，判断须有明确正误依据。原文存在不等于能支持答案，必须说明原文如何支持答案。
与已有试题比较实际考查任务及实质内容；仅换词、语序或选项位置的题不合格。同知识不同任务只在完整标准允许时合格，不得覆盖知识独立性、多样性要求。
技能只按操作技能标准核验情境、任务、完整步骤、成果、评分项目和分值，不套用理论变式放宽；正式参数缺失不得编造。
覆盖完整标准的所有适用要求，requirements逐条列出要求、是否通过和理由；requirements为必填数组，即使只有1条也必须返回。任一要求不通过，则meetsQualityStandard必须为false。不能确认答案或依据时必须判不通过，不猜测。
每个候选必须返回唯一index，包含所有候选索引，不得遗漏。evidenceSourceIds只能选择输入中存在的稳定编号，不自行复制或编造原文。
${principleRule}
只返回JSON：{"checks":[{"index":0,"meetsQualityStandard":true,"answerCorrect":true,"evidenceSupported":true,"distinctTask":true,"score":90,"explanation":"说明原文如何支持答案及任务差异","evidenceSourceIds":["输入编号"],"requirements":[{"requirement":"适用标准原文要求","passed":true,"explanation":"核验理由"}]}]}。`,
    prompt: JSON.stringify({
      职业: snapshot.scope.occupation, 等级: snapshot.scope.commonGroupId ? "五级、四级、三级共用基本要求" : snapshot.scope.levelCode, 考评点: point,
      [kind === "skill" ? "操作技能试题质量标准" : "试题质量标准"]: kind === "skill" ? snapshot.skillQualityStandard : snapshot.qualityStandard,
      质量要求: snapshot.qualityRequirements, 质量执行策略: generationQualityPolicy(kind, true),
      候选: candidates.map((candidate, index) => ({ index, ...candidate })), 已有试题: previous,
      可核验原文: sources, 冻结内容结构: kind === "skill" ? snapshot.skillStructure : undefined,
    }),
  };
}

export function parseCandidateReview(content: string, candidates: GeneratedQuestion[], sources: AngleSource[],
  context?: { pointName?: string; kind?: "theory" | "skill" }) {
  let parsed: z.infer<typeof reviewSchema>;
  try { parsed = reviewSchema.parse(normalizeReviewPayload(content)); }
  catch (error) { throw new GenerationFailure("review_invalid", `候选质量核验格式无效：${skillCandidateIssues(error).slice(0, 20).join("；")}。不将未经核验的候选计入成果。`); }
  if (parsed.checks.length !== candidates.length || new Set(parsed.checks.map((check) => check.index)).size !== candidates.length
    || parsed.checks.some((check) => check.index >= candidates.length)) {
    throw new GenerationFailure("review_invalid", "候选核验遗漏或重复索引，需重新核验，不能按默认通过保存。");
  }
  const ids = new Set(sources.map((source) => source.id));
  const passed = parsed.checks.filter((check) => check.meetsQualityStandard && check.answerCorrect && check.evidenceSupported
    && check.distinctTask && check.requirements.every((item) => item.passed) && check.evidenceSourceIds.every((id) => ids.has(id)));
  if (!passed.length && parsed.checks.some((check) => check.evidenceSourceIds.some((id) => !ids.has(id)))) {
    throw new GenerationFailure("review_invalid", "核验引用了未知原文编号，保留候选重新核验，不猜答案或放宽引用要求。");
  }
  const blockedByLocalRules = new Map<number, string[]>();
  for (const check of parsed.checks) {
    const failures = localCandidateFailures(candidates[check.index], context);
    if (failures.length) blockedByLocalRules.set(check.index, failures);
  }
  return {
    questions: passed.filter((check) => !blockedByLocalRules.has(check.index)).sort((a, b) => b.score - a.score).map((check) => ({
      ...candidates[check.index],
      standardReview: { score: check.score, requirements: check.requirements, evidenceSourceIds: check.evidenceSourceIds },
    })),
    failures: parsed.checks.filter((check) => !passed.includes(check) || blockedByLocalRules.has(check.index)).map((check) => ({
      code: "quality_rejected" as const,
      message: blockedByLocalRules.has(check.index)
        ? `候选${check.index + 1}未通过完整质量核验：${check.explanation}；${blockedByLocalRules.get(check.index)!.join("；")}`
        : `候选${check.index + 1}未通过完整质量核验：${check.explanation}`,
    })),
  };
}
