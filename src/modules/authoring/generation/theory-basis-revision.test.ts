import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import type { Snapshot } from "./contracts";
import { curatedTheoryBasis, curatedTheoryBasisReplacement } from "./curated-theory-basis";
import { completeRetry, retryState } from "./retry-policy";
import { ensureTargetedBudget, recoverTheoryBasisRevision, recoverTheoryEcho, theoryGenerationLimit } from "./targeted-budget";
import { generateTargeted, type TargetedDependencies } from "./targeted-generation";
import { acquireTheoryExpansion } from "./theory-expansion";

const snapshot: Snapshot = {
  projectId: "p", requirement: "每点4单选2判断", points: [], sourceVersionIds: [], qualityRequirements: [],
  qualityStandard: "答案唯一，依据真实，任务不同，干扰项合理，允许标注可靠扩展。",
  scope: { occupationId: "o", occupation: "劝募员", levelCode: "level_4", assessmentMode: "理论知识",
    blueprintVersions: { outline: { id: "outline", versionNo: 1 }, weights: { id: "weights", versionNo: 1 } } },
  nodes: [{ id: "n", code: "B-C-AD-002", name: "新媒体传播效果评估指标体系构建", chapterIds: [] }],
  model: { provider: "test", baseUrl: "https://example.com", model: "test" },
};
const oldStem = "在构建新媒体传播效果评估指标体系时，以下哪项不是新媒体传播效果的评估指标？";
const previous = [{ stem: oldStem }, { stem: "以下哪个新媒体传播规律描述是正确的？" },
  { stem: "以下哪项不是受众参与度的评估指标？" }, { stem: "评估指标体系构建需要方法分析。" }, { stem: "新媒体传播速度快。" }];
const question = { assessmentPointCode: "B-C-AD-002", questionType: "single",
  stem: "评估知识类视频传播效果时，将知识学习、信息获取的实现程度归入(　　)。",
  options: ["认知效果", "情感效果", "态度效果", "行为效果"].map((content, index) => ({ key: "ABCD"[index], content })),
  answers: ["A"], analysis: "表1明确认知效果的指标说明为知识学习、信息获取的实现程度。" };

function fixture() {
  const state = retryState(null);
  const budget = ensureTargetedBudget(state, [{ id: "s", ordinal: 382, question_type: "single" }], 0);
  const old = curatedTheoryBasisReplacement(snapshot, "B-C-AD-002")!.previous;
  const hash = createHash("sha256").update(old.text).digest("hex");
  const source = { id: "old-source", content: old.text, systemQuote: true,
    expansion: { url: old.url, label: "扩展" as const, review: "旧核验通过", retrievedAt: old.retrievedAt, documentHash: hash } };
  budget.calls = 10;
  budget.reviewContext = { kind: "theory", qualityStandard: snapshot.qualityStandard, qualityRequirements: [], previous };
  budget.theoryExpansion = { version: 1, curatedBasisId: old.id, sources: [source], discoveryAttempts: 0,
    reviewAttempts: 1, reviewResponses: ["旧资料核验响应"], discoveryResponses: [], errors: [],
    documents: [{ id: "D1", text: old.text, url: old.url, retrievedAt: old.retrievedAt, suggestedTitle: old.title, hash }] };
  const slot = budget.slots.s;
  slot.generations = 4;
  slot.theoryPromptVersion = 2;
  slot.blocked = { code: "duplicate", message: "候选题干与已有题重复" };
  slot.theoryRedesignRecovery = { at: "old", previousBlock: slot.blocked, previousGenerations: 3, extraGenerations: 1 };
  slot.searchedSourceIds = [source.id];
  slot.rejectedCandidates = Array.from({ length: 4 }, (_, index) => ({ at: `old-${index}`,
    response: JSON.stringify({ questions: [{ ...question, stem: oldStem, answers: [index % 2 ? "C" : "D"] }] }),
    failures: [slot.blocked!], evidenceSources: [source] }));
  state.failures = [slot.blocked];
  return { snapshot, code: "B-C-AD-002", previous, state, sources: [] };
}

function deps(call: TargetedDependencies["call"], signal = new AbortController().signal): TargetedDependencies {
  return { call, signal, persist: async () => {} };
}

function sourceReview(prompt: string, passed = true, sourceId?: string) {
  const document = JSON.parse(prompt).实际下载资料[0];
  return JSON.stringify({ checks: [{ sourceId: sourceId ?? document.sourceId, quote: document.正文,
    trustworthy: true, correctScope: passed, supportsKnowledge: passed, standardAllowsExpansion: true,
    isLegalQuestion: false, explanation: passed ? "表格定义支持知识类视频的效果维度辨析。" : "缺少本考点对应依据。" }] });
}

test("指标体系考点选用指标定义表，不沿用主体角色材料，传播规律旧用途保留", () => {
  assert.match(curatedTheoryBasis(snapshot, "B-C-AD-002")!.text, /认知效果/);
  const other = { ...snapshot, nodes: [{ ...snapshot.nodes[0], name: "新媒体传播规律" }] };
  assert.match(curatedTheoryBasis(other, "B-C-AD-002")!.text, /去中心化/);
  assert.equal(curatedTheoryBasisReplacement(other, "B-C-AD-002"), undefined);
});

test("新协议单题仍换选项复用旧干时，旧复述恢复不适用，资料修订可保留4轮和10次调用一次恢复", () => {
  const input = fixture();
  const budget = input.state.budget!, evidence = budget.theoryExpansion!, slot = budget.slots.s;
  const history = JSON.stringify(slot.rejectedCandidates);
  assert.equal(recoverTheoryEcho(input.state, snapshot, input.code), false);
  assert.equal(recoverTheoryBasisRevision(input.state, snapshot, input.code), true);
  assert.equal(theoryGenerationLimit(slot), 5);
  assert.equal(slot.generations, 4);
  assert.equal(budget.calls, 10);
  assert.equal(budget.maxCalls, 24);
  assert.equal(evidence.reviewAttempts, 1);
  assert.equal(evidence.basisRevision!.previousSources[0].id, "old-source");
  assert.equal(evidence.sources.length, 0);
  assert.equal(evidence.documents[0].id, "D1");
  assert.equal(JSON.stringify(slot.rejectedCandidates), history);
  assert.equal(recoverTheoryBasisRevision(input.state, snapshot, input.code), false);
});

test("旧缓存已核验也不能继续用于指标题，必须走显式资料修订", async () => {
  const input = fixture();
  input.state.budget!.slots.s.blocked = undefined;
  const output = await generateTargeted(input, deps(async () => { throw new Error("不应调用模型"); }));
  assert.equal(output.questions.length, 0);
  assert.equal(output.failures[0].code, "evidence_invalid");
  assert.equal(input.state.budget!.calls, 10);
});

for (const passed of [true, false]) {
  test(`资料修订独立核验、定向单候选及完整核验闭环：最终${passed ? "通过" : "拒绝"}`, async () => {
    const input = fixture();
    recoverTheoryBasisRevision(input.state, snapshot, input.code);
    let calls = 0;
    const output = await generateTargeted(input, deps(async (prompt) => {
      calls++;
      const data = JSON.parse(prompt.prompt);
      if (prompt.instruction.includes("扩展依据独立核验助手")) {
        assert.equal(data.实际下载资料.length, 1);
        assert.equal(data.实际下载资料[0].sourceId, "D2");
        assert.doesNotMatch(prompt.prompt, /去中心化|旧资料核验响应/);
        return sourceReview(prompt.prompt);
      }
      if (prompt.instruction.includes("试题独立核验助手")) {
        assert.match(prompt.prompt, /以下哪项不是新媒体传播效果/);
        return JSON.stringify({ checks: [{ index: 0, meetsQualityStandard: passed, answerCorrect: passed,
          evidenceSupported: true, distinctTask: true, score: 90, explanation: passed ? "表1支持唯一答案，任务不同。" : "未满足质量标准。",
          evidenceSourceIds: [data.可核验原文[0].id],
          requirements: [{ requirement: "完整质量标准", passed, explanation: "逐条核验" }] }] });
      }
      assert.doesNotMatch(prompt.prompt, /以下哪项不是新媒体传播效果|去中心化/);
      assert.match(data.考查任务.task, /知识学习/);
      assert.equal(data.本次候选数, 1);
      assert.match(prompt.instruction, /认知效果/);
      return JSON.stringify({ questions: [question] });
    }));
    const budget = input.state.budget!;
    assert.equal(calls, 3);
    assert.equal(budget.calls, 13);
    assert.equal(budget.slots.s.generations, 5);
    assert.equal(budget.theoryExpansion!.reviewAttempts, 2);
    assert.equal(budget.theoryExpansion!.documents.length, 2);
    assert.equal(budget.theoryExpansion!.reviewResponses[0], "旧资料核验响应");
    assert.equal(output.questions.length, passed ? 1 : 0);
    if (passed) assert.match(output.questions[0].analysis, /\[扩展\]/);
    else {
      const closed = completeRetry(input.state, 6, 0, 1, output.failures);
      assert.equal(closed.status, "failed");
      assert.equal(recoverTheoryBasisRevision(closed.state, snapshot, input.code), false);
    }
  });
}

test("新资料核验否定或引用旧资料编号时不生成，不复用旧通过结论", async () => {
  for (const oldId of [undefined, "D1"]) {
    const input = fixture();
    recoverTheoryBasisRevision(input.state, snapshot, input.code);
    const output = await generateTargeted(input, deps(async (prompt) => {
      assert.match(prompt.instruction, /扩展依据独立核验助手/);
      return sourceReview(prompt.prompt, Boolean(oldId), oldId);
    }));
    assert.equal(output.questions.length, 0);
    assert.equal(input.state.budget!.slots.s.generations, 4);
    assert.equal(input.state.budget!.theoryExpansion!.sources.length, 0);
  }
});

test("固定指标表按编号取回原文，不要求模型抄写，不改变否定或缺失的布尔结论", async () => {
  for (const variant of ["no-quote", "publication-quote", "denied", "missing-flag", "duplicate-id"]) {
    const input = fixture();
    recoverTheoryBasisRevision(input.state, snapshot, input.code);
    const sources = await acquireTheoryExpansion(input, {
      persist: async () => {}, signal: new AbortController().signal,
      call: async (_phase, prompt) => {
        assert.match(prompt.instruction, /只用sourceId定位原表/);
        const response = JSON.parse(sourceReview(prompt.prompt));
        const check = response.checks[0];
        delete check.quote;
        if (variant === "publication-quote") check.quote = "华南师范大学学报（自然科学版），2023，55(4)：87-99";
        if (variant === "denied") check.standardAllowsExpansion = false;
        if (variant === "missing-flag") delete check.supportsKnowledge;
        if (variant === "duplicate-id") response.checks.push({ ...check });
        return JSON.stringify(response);
      },
    });
    assert.equal(sources.length, ["no-quote", "publication-quote"].includes(variant) ? 1 : 0);
    if (sources.length) assert.equal(sources[0].content, curatedTheoryBasis(snapshot, input.code)!.text);
    assert.equal(input.state.budget!.theoryExpansion!.fixedExcerptProtocol, 1);
    assert.equal(input.state.budget!.slots.s.generations, 4);
  }
});

test("无原始留证、正文篡改、预算不足、已完成和非目标范围不能恢复", () => {
  const mutations: Array<(input: ReturnType<typeof fixture>) => void> = [
    (input) => { input.state.budget!.theoryExpansion!.documents = []; },
    (input) => { input.state.budget!.theoryExpansion!.documents[0].text += "被修改"; },
    (input) => { input.state.budget!.calls = 22; },
    (input) => { input.state.budget!.slots.s.done = true; },
    (input) => { input.snapshot = { ...snapshot, scope: { ...snapshot.scope, assessmentMode: "操作技能" } }; },
    (input) => { input.snapshot = { ...snapshot, nodes: [{ ...snapshot.nodes[0], chapterIds: ["教材"] }] }; },
    (input) => { input.state.failures = [{ code: "save_error", message: "保存失败" }]; },
  ];
  for (const mutate of mutations) {
    const input = fixture();
    mutate(input);
    assert.equal(recoverTheoryBasisRevision(input.state, input.snapshot, input.code), false);
  }
});

test("资料修订中停止时迟到核验不能进入生成", async () => {
  const input = fixture();
  recoverTheoryBasisRevision(input.state, snapshot, input.code);
  const controller = new AbortController();
  let calls = 0;
  const output = await generateTargeted(input, deps(async (prompt) => {
    calls++;
    controller.abort(new Error("停止生成"));
    return sourceReview(prompt.prompt);
  }, controller.signal));
  assert.equal(output.questions.length, 0);
  assert.equal(calls, 1);
  assert.equal(input.state.budget!.slots.s.generations, 4);
});
