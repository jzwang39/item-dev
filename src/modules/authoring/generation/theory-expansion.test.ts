import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { documentText, publicIpv4, trustedDocumentUrl } from "./external-document";
import { factualTheorySources } from "./evidence-catalog";
import { acquireTheoryExpansion, parseExpansionAudit } from "./theory-expansion";
import { ensureTargetedBudget, recoverExpansionReviewProtocol, recoverCuratedTheoryBasis, recoverNoTextbookTheory, theoryGenerationLimit } from "./targeted-budget";
import { curatedTheoryBasis } from "./curated-theory-basis";
import { generateTargeted } from "./targeted-generation";
import { completeRetry, retryState } from "./retry-policy";
import type { Snapshot } from "./contracts";

const snapshot: Snapshot = {
  projectId: "p", requirement: "按点补齐", points: [], sourceVersionIds: ["基础教材版本"],
  qualityRequirements: ["准确，扩展须标注出处"], qualityStandard: "允许可靠扩展；答案正确、符合等级，不得重复。",
  scope: { occupationId: "o", occupation: "资料管理", levelCode: "level_4", assessmentMode: "理论知识",
    blueprintVersions: { outline: { id: "outline", versionNo: 1 }, weights: { id: "weights", versionNo: 1 } } },
  nodes: [{ id: "n", code: "A", name: "资料借阅", chapterIds: [], theoryContext: { evidence: "1.1.4 资料借阅" } }],
  model: { provider: "test", baseUrl: "https://example.com", model: "test" },
};
const scopeSources = [{ id: "scope", content: "1.1.4 资料借阅", systemQuote: true }];
const quote = "资料借阅前应当登记借阅人、资料名称及借阅时间；归还资料时应核对完整性，并记录归还时间，发现缺失应及时报告。";
const text = `某政府机构资料借阅教学说明。${quote}适用初级资料管理工作，登记信息应确保完整和真实。${quote}`;
const url = "https://www.moe.gov.cn/test-evidence.html";
const hash = createHash("sha256").update(text).digest("hex");
const document = { id: "D1", url, text, retrievedAt: "2026-11-01T00:00:00.000Z", hash, suggestedTitle: "建议标题不是证据" };
const audit = (extra = {}) => JSON.stringify({ checks: [{ sourceId: "D1", quote, trustworthy: true, correctScope: true,
  supportsKnowledge: true, standardAllowsExpansion: true, isLegalQuestion: false, explanation: "机构教学说明支持资料登记任务及范围。", ...extra }] });
function fixture() {
  const state = retryState(null);
  state.targeted = true;
  ensureTargetedBudget(state, [{ id: "s", ordinal: 382, question_type: "single" }], 4);
  return { snapshot, code: "A", previous: [], sources: scopeSources, state };
}
const fetchDocument = async () => ({ url, text, retrievedAt: document.retrievedAt });

function curatedFixture() {
  const input = fixture();
  const target: Snapshot = { ...snapshot, scope: { ...snapshot.scope, occupation: "劝募员" },
    nodes: [{ ...snapshot.nodes[0], code: "B-C-AD-002", name: "新媒体传播规律" }] };
  return { ...input, snapshot: target, code: "B-C-AD-002" };
}

function malformedCuratedReview() {
  const input = curatedFixture();
  const basis = curatedTheoryBasis(input.snapshot, input.code)!;
  const budget = input.state.budget!;
  budget.calls = 2;
  budget.theoryExpansion = {
    version: 1, discoveryAttempts: 0, reviewAttempts: 2, sources: [], discoveryResponses: [], errors: [],
    curatedBasisId: basis.id, documents: [{
      id: "D1", url: basis.url, text: basis.text, retrievedAt: basis.retrievedAt, suggestedTitle: basis.title,
      hash: createHash("sha256").update(basis.text).digest("hex"),
    }], reviewResponses: [
      audit({ quote: basis.text, standardAllowsExpansion: false, explanation: "该摘录符合质量标准，出版机构可信，并能支持具体命题。" }),
      '{"answer":"短视频用户从信息接收者变为多重主体。"}',
    ],
  };
  budget.slots.s.blocked = { code: "insufficient_basis", message: "核验已达2次" };
  input.state.failures = [budget.slots.s.blocked];
  return input;
}

test("实际否定布尔值仍拒绝，即使解释说符合标准也不自动翻转", () => {
  const input = malformedCuratedReview();
  const evidence = input.state.budget!.theoryExpansion!;
  assert.equal(parseExpansionAudit(evidence.reviewResponses[0], evidence.documents).length, 0);
  assert.throws(() => parseExpansionAudit(evidence.reviewResponses[1], evidence.documents));
});

test("两轮后一轮返回摘要时一次恢复核验，保留原文及否定响应、不增加调用预算", () => {
  const input = malformedCuratedReview();
  const budget = input.state.budget!;
  const originals = JSON.stringify(budget.theoryExpansion!.reviewResponses);
  assert.equal(recoverExpansionReviewProtocol(input.state, input.snapshot, input.code), true);
  assert.equal(budget.theoryExpansion!.reviewAttempts, 2);
  assert.equal(budget.calls, 2);
  assert.equal(budget.maxCalls, 24);
  assert.equal(JSON.stringify(budget.theoryExpansion!.reviewResponses), originals);
  assert.equal(budget.slots.s.blocked, undefined);
  assert.equal(budget.slots.s.generations, 0);
  assert.equal(recoverExpansionReviewProtocol(input.state, input.snapshot, input.code), false);
});

test("明确内容否定、篡改正文、跨考点和预算耗尽不能获得格式恢复", () => {
  const validDenial = malformedCuratedReview();
  validDenial.state.budget!.theoryExpansion!.reviewResponses[1] = validDenial.state.budget!.theoryExpansion!.reviewResponses[0];
  assert.equal(recoverExpansionReviewProtocol(validDenial.state, validDenial.snapshot, validDenial.code), false);
  const tampered = malformedCuratedReview();
  tampered.state.budget!.theoryExpansion!.documents[0].hash = "changed";
  assert.equal(recoverExpansionReviewProtocol(tampered.state, tampered.snapshot, tampered.code), false);
  const input = malformedCuratedReview();
  assert.equal(recoverExpansionReviewProtocol(input.state, input.snapshot, "OTHER"), false);
  input.state.budget!.calls = 24;
  assert.equal(recoverExpansionReviewProtocol(input.state, input.snapshot, input.code), false);
});

test("修正核验提示后独立重判，只有完整真实通过才返回依据", async () => {
  const input = malformedCuratedReview();
  assert.equal(recoverExpansionReviewProtocol(input.state, input.snapshot, input.code), true);
  let calls = 0;
  const sources = await acquireTheoryExpansion(input, {
    signal: new AbortController().signal, persist: async () => {},
    call: async (_phase, prompt) => {
      calls++;
      assert.match(prompt.instruction, /不是教材|是否教材/);
      assert.match(prompt.instruction, /逐项阅读标准/);
      assert.match(prompt.instruction, /不自动翻转/);
      assert.doesNotMatch(prompt.instruction, /"standardAllowsExpansion":false/);
      return audit({ quote: input.state.budget!.theoryExpansion!.documents[0].text });
    },
  });
  assert.equal(sources.length, 1);
  assert.equal(calls, 1);
  assert.equal(input.state.budget!.theoryExpansion!.reviewAttempts, 3);
  assert.equal(input.state.budget!.theoryExpansion!.reviewResponses.length, 3);
});

test("恢复后仍否定标准允许或仍返回摘要时不得生成，再执行也不追加核验", async () => {
  for (const malformed of [true, false]) {
    const input = malformedCuratedReview();
    assert.equal(recoverExpansionReviewProtocol(input.state, input.snapshot, input.code), true);
    let calls = 0;
    const dependencies = {
      signal: new AbortController().signal, persist: async () => {},
      call: async () => {
        calls++;
        return malformed ? '{"answer":"摘要"}'
          : audit({ quote: input.state.budget!.theoryExpansion!.documents[0].text, standardAllowsExpansion: false });
      },
    };
    assert.equal((await acquireTheoryExpansion(input, dependencies)).length, 0);
    assert.match(input.state.budget!.theoryExpansion!.errors.at(-1)!, malformed ? /结构或引用无效/ : /standardAllowsExpansion/);
    await assert.rejects(() => acquireTheoryExpansion(input, dependencies), /核验已达3次/);
    assert.equal(calls, 1);
    assert.equal(input.state.budget!.slots.s.generations, 0);
    assert.equal(recoverExpansionReviewProtocol(input.state, input.snapshot, input.code), false);
  }
});

test("定向资料只匹配劝募员无教材新媒体考评点，不跨职业、考点、技能或教材", () => {
  const input = curatedFixture();
  assert.ok(curatedTheoryBasis(input.snapshot, input.code));
  assert.equal(curatedTheoryBasis(input.snapshot, "OTHER"), undefined);
  assert.equal(curatedTheoryBasis({ ...input.snapshot, scope: snapshot.scope }, input.code), undefined);
  assert.equal(curatedTheoryBasis({ ...input.snapshot, scope: { ...input.snapshot.scope, assessmentMode: "操作技能" } }, input.code), undefined);
  assert.equal(curatedTheoryBasis({ ...input.snapshot, nodes: [{ ...input.snapshot.nodes[0], chapterIds: ["book"] }] }, input.code), undefined);
  assert.equal(curatedTheoryBasis({ ...input.snapshot, nodes: [{ ...input.snapshot.nodes[0], name: "其他知识" }] }, input.code), undefined);
});

test("定向恢复保留两轮失败和调用数，不新增额度，不可再次恢复核验失败", () => {
  const input = curatedFixture();
  const budget = input.state.budget!;
  budget.calls = 2;
  budget.theoryExpansion = { version: 1, discoveryAttempts: 2, reviewAttempts: 0, documents: [], sources: [],
    errors: ["404"], discoveryResponses: ["旧响应1", "旧响应2"], reviewResponses: [] };
  budget.slots.s.blocked = { code: "insufficient_basis", message: "两轮地址失败" };
  input.state.failures = [budget.slots.s.blocked];
  assert.equal(recoverCuratedTheoryBasis(input.state, input.snapshot, input.code), true);
  assert.equal(budget.calls, 2);
  assert.equal(budget.maxCalls, 24);
  assert.equal(budget.theoryExpansion.discoveryAttempts, 2);
  assert.equal(budget.theoryExpansion.discoveryResponses.length, 2);
  assert.equal(budget.slots.s.generations, 0);
  budget.slots.s.blocked = { code: "insufficient_basis", message: "新资料核验失败" };
  assert.equal(recoverCuratedTheoryBasis(input.state, input.snapshot, input.code), false);
});

test("留存的真实学术正文不猜网址，不绕过独立核验且完整记录获取方式", async () => {
  const input = curatedFixture();
  let calls = 0;
  const sources = await acquireTheoryExpansion(input, {
    signal: new AbortController().signal, persist: async () => {},
    fetchDocument: async () => { throw new Error("定向资料不请求网络"); },
    call: async (_phase, prompt) => {
      calls++;
      assert.match(prompt.instruction, /扩展依据独立核验助手/);
      const data = JSON.parse(prompt.prompt);
      const doc = data.实际下载资料[0];
      assert.match(doc.留存资料信息.acquisition, /不代表运行时重新下载/);
      return audit({ quote: doc.正文, explanation: "核对学术资料的用户角色切换，适用于该知识范围。" });
    },
  });
  assert.equal(calls, 1);
  assert.equal(sources.length, 1);
  assert.match(sources[0].content, /信息生成、传播、分享和接收/);
  assert.match(sources[0].expansion!.url, /ustb.edu.cn/);
});

test("定向资料真实也不能抵消标准或范围核验不通过", async () => {
  const input = curatedFixture();
  const deps = { signal: new AbortController().signal, persist: async () => {},
    call: async (_phase: string, prompt: { prompt: string }) => {
      const data = JSON.parse(prompt.prompt);
      return audit({ quote: data.实际下载资料[0].正文, correctScope: false });
    } };
  assert.equal((await acquireTheoryExpansion(input, deps)).length, 0);
  assert.equal((await acquireTheoryExpansion(input, deps)).length, 0);
  await assert.rejects(() => acquireTheoryExpansion(input, deps), /核验已达2次/);
  assert.equal(input.state.budget!.slots.s.generations, 0);
});

test("定向候选携带角色切换建议，最后质量核验拒绝时仍不计为成果", async () => {
  for (const passed of [true, false]) {
    const input = curatedFixture();
    input.previous = [];
    let finalReviews = 0;
    const output = await generateTargeted(input, { signal: new AbortController().signal, persist: async () => {},
      call: async (prompt) => {
        const data = JSON.parse(prompt.prompt);
        if (prompt.instruction.includes("扩展依据独立核验助手")) return audit({ quote: data.实际下载资料[0].正文 });
        if (prompt.instruction.includes("补题分析助手")) return JSON.stringify({ remaining: [{
          angle: "短视频用户角色", sourceId: input.state.budget!.theoryExpansion!.sources[0].id,
          task: "识别接收与创作分享之间的用户角色切换", reusesKnowledge: false, reason: "原文明确支持角色切换",
        }] });
        if (prompt.instruction.includes("试题独立核验助手")) {
          finalReviews++;
          return JSON.stringify({ checks: [{ index: 0, meetsQualityStandard: passed, answerCorrect: true,
            evidenceSupported: true, distinctTask: true, score: 90, explanation: passed ? "用户角色切换有原文支持。" : "干扰项未满足完整质量标准。",
            evidenceSourceIds: [data.可核验原文[0].id], requirements: [{ requirement: "完整标准核验", passed, explanation: "逐项核验" }] }] });
        }
        assert.match(prompt.instruction, /定向设计建议/);
        assert.match(prompt.instruction, /不考高校意识形态政策/);
        return JSON.stringify({ questions: [{ assessmentPointCode: input.code, questionType: "single",
          stem: "短视频用户由观看内容转为创作、发布和分享内容，体现了传播过程中(　　)。",
          options: [{ key: "A", content: "传播主体的角色切换" }, { key: "B", content: "传播内容的主题分类" },
            { key: "C", content: "传播渠道的技术更新" }, { key: "D", content: "传播效果的量化评估" }],
          answers: ["A"], analysis: "资料指出用户在信息生成、传播、分享和接收间切换。" }] });
      } });
    assert.equal(finalReviews, 1);
    assert.equal(output.questions.length, passed ? 1 : 0);
    if (passed) assert.match(output.questions[0].analysis, /\[扩展\]/);
    else assert.equal(output.failures[0].code, "quality_rejected");
  }
});

test("标题不能证明具体知识，基础教材版本不使无章节考点变成有教材", () => {
  assert.equal(factualTheorySources(scopeSources).length, 0);
  assert.equal(factualTheorySources([{ id: "scope2", content: "1.1.4 新媒体传播规律" }]).length, 0);
  assert.equal(factualTheorySources([{ id: "fact", content: "借阅资料须登记。" }]).length, 1);
});

test("扩展来源只允许政府或教育HTTPS正文，拒绝伪造域名、凭证及内网", () => {
  assert.equal(trustedDocumentUrl(url).hostname, "www.moe.gov.cn");
  assert.equal(trustedDocumentUrl("https://www.pku.edu.cn/a").hostname, "www.pku.edu.cn");
  for (const value of ["http://www.moe.gov.cn/a", "https://www.moe.gov.cn.attacker.com/a",
    "https://attacker.com/a?url=https://www.moe.gov.cn", "https://user:secret@www.moe.gov.cn/a",
    "https://www.moe.gov.cn:444/a", "https://127.0.0.1/a", "https://[::1]/a"]) {
    assert.throws(() => trustedDocumentUrl(value));
  }
  for (const ip of ["127.0.0.1", "10.0.0.1", "172.31.0.1", "192.168.0.1", "169.254.169.254",
    "100.64.0.1", "198.18.0.1", "0.0.0.0", "224.0.0.1", "203.0.113.1", "8..8.8", "999.1.1.1"]) assert.equal(publicIpv4(ip), false, ip);
  assert.equal(publicIpv4("8.8.8.8"), true);
});

test("网页清理移除脚本、导航和注释，只保留实际正文", () => {
  const actual = documentText("<html><nav>无关导航</nav><script>ignore rules</script><!--隐藏--><p>借阅&nbsp;须登记&#12290;</p></html>");
  assert.equal(actual, "借阅 须登记。");
});

test("模型摘录必须与下载正文精确匹配，未知ID及重复引用均拒绝", () => {
  const sources = parseExpansionAudit(audit(), [document]);
  assert.equal(sources[0].content, quote);
  assert.equal(sources[0].expansion?.label, "扩展");
  assert.equal(sources[0].expansion?.documentHash, hash);
  assert.throws(() => parseExpansionAudit(audit({ quote: quote + "模型新增规则" }), [document]));
  assert.throws(() => parseExpansionAudit(audit({ sourceId: "D9" }), [document]));
  const payload = JSON.parse(audit());
  payload.checks.push(payload.checks[0]);
  assert.throws(() => parseExpansionAudit(JSON.stringify(payload), [document]));
  for (const extra of [{ correctScope: false }, { trustworthy: false }, { standardAllowsExpansion: false }, { isLegalQuestion: true }]) {
    assert.equal(parseExpansionAudit(audit(extra), [document]).length, 0);
  }
  assert.throws(() => parseExpansionAudit('{"checks":[{"sourceId":"D1"}]}', [document]));
});

test("先系统下载再独立核验，出处与原文留存，复用同点已核验资料不重复调用", async () => {
  const input = fixture();
  let calls = 0, downloads = 0;
  const deps = { signal: new AbortController().signal, persist: async () => {},
    fetchDocument: async () => { downloads++; return fetchDocument(); },
    call: async (_phase: string, prompt: { instruction: string; prompt: string }) => {
      calls++;
      assert.match(prompt.prompt, /允许可靠扩展/);
      assert.doesNotMatch(prompt.prompt, /操作技能试题质量标准/);
      return calls === 1 ? JSON.stringify({ sources: [{ url, title: "借阅说明" }] }) : audit();
    } };
  assert.equal((await acquireTheoryExpansion(input, deps)).length, 1);
  assert.equal((await acquireTheoryExpansion(input, deps)).length, 1);
  assert.equal(calls, 2);
  assert.equal(downloads, 1);
  assert.equal(input.state.budget!.theoryExpansion!.documents[0].text, text);
});

test("伪造网址不会下载；检索两轮无来源后关闭，不凭标题生成", async () => {
  const input = fixture();
  let downloads = 0;
  const deps = { signal: new AbortController().signal, persist: async () => {},
    fetchDocument: async () => { downloads++; return fetchDocument(); },
    call: async () => JSON.stringify({ sources: [{ url: "https://evil.com/a", title: "伪造资料" }] }) };
  assert.equal((await acquireTheoryExpansion(input, deps)).length, 0);
  assert.equal((await acquireTheoryExpansion(input, deps)).length, 0);
  await assert.rejects(() => acquireTheoryExpansion(input, deps), /已达2轮/);
  assert.equal(downloads, 0);
  assert.equal(input.state.budget!.slots.s.generations, 0);
});

test("扩展核验遗漏字段保留实际文档，最多重核验2次，不重新检索或默认通过", async () => {
  const input = fixture();
  let downloads = 0, calls = 0;
  const deps = { signal: new AbortController().signal, persist: async () => {},
    fetchDocument: async () => { downloads++; return fetchDocument(); },
    call: async () => ++calls === 1 ? JSON.stringify({ sources: [{ url, title: "借阅说明" }] }) : '{"checks":[{"sourceId":"D1"}]}' };
  assert.equal((await acquireTheoryExpansion(input, deps)).length, 0);
  assert.equal((await acquireTheoryExpansion(input, deps)).length, 0);
  await assert.rejects(() => acquireTheoryExpansion(input, deps), /核验已达2次/);
  assert.equal(downloads, 1);
  assert.equal(calls, 3);
});

test("停止任务拦截下载迟到响应，不保存文档或继续核验", async () => {
  const input = fixture();
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(() => acquireTheoryExpansion(input, { signal: controller.signal, persist: async () => {},
    fetchDocument: async () => { controller.abort(new Error("已停止")); return fetchDocument(); },
    call: async () => { calls++; return JSON.stringify({ sources: [{ url, title: "借阅说明" }] }); } }), /已停止/);
  assert.equal(calls, 1);
  assert.equal(input.state.budget!.theoryExpansion!.documents.length, 0);
});

test("初轮和补题共用扩展依据，完整质量核验通过才填槽并标注扩展", async () => {
  const input = fixture();
  const deps = { signal: new AbortController().signal, persist: async () => {}, fetchDocument,
    call: async (prompt: { instruction: string; prompt: string }) => {
      if (prompt.instruction.includes("资料检索助手")) return JSON.stringify({ sources: [{ url, title: "借阅说明" }] });
      if (prompt.instruction.includes("扩展依据独立核验助手")) return audit();
      if (prompt.instruction.includes("补题分析助手")) {
        const id = input.state.budget!.theoryExpansion!.sources[0].id;
        return JSON.stringify({ remaining: [{ angle: "借阅登记", sourceId: id, task: "选择借阅前的登记要求", reusesKnowledge: false, reason: "原文支持" }] });
      }
      if (prompt.instruction.includes("试题独立核验助手")) {
        const data = JSON.parse(prompt.prompt);
        assert.equal(data.可核验原文[0].expansion.label, "扩展");
        return JSON.stringify({ checks: [{ index: 0, meetsQualityStandard: true, answerCorrect: true,
          evidenceSupported: true, distinctTask: true, score: 90, explanation: "原文支持登记流程及唯一正确选项。",
          evidenceSourceIds: [data.可核验原文[0].id], requirements: [{ requirement: "符合等级及依据", passed: true, explanation: "已核对" }] }] });
      }
      assert.match(prompt.instruction, /标注\[扩展\]/);
      return JSON.stringify({ questions: [{ assessmentPointCode: "A", questionType: "single", stem: "借阅资料前应当首先完成哪项手续？",
        options: [{ key: "A", content: "登记借阅信息" }, { key: "B", content: "删除登记记录" }, { key: "C", content: "忽略借阅时间" }, { key: "D", content: "直接带走资料" }],
        answers: ["A"], analysis: "原文要求借阅前登记。" }] });
    } };
  const output = await generateTargeted(input, deps);
  assert.equal(output.questions.length, 1);
  assert.match(output.questions[0].analysis, /\[扩展\]/);
  assert.match(output.questions[0].analysis, /moe.gov.cn/);
  assert.equal(input.state.budget!.slots.s.generations, 1);
  assert.equal(input.state.budget!.calls, 5);
  assert.deepEqual(snapshot.nodes[0].chapterIds, []);
  assert.deepEqual(snapshot.sourceVersionIds, ["基础教材版本"]);
});

test("扩展来源无法取得时多次执行也不生成无依据候选", async () => {
  const input = fixture();
  const deps = { signal: new AbortController().signal, persist: async () => {}, fetchDocument,
    call: async () => '{"sources":[]}' };
  for (let index = 0; index < 3; index++) {
    const output = await generateTargeted(input, deps);
    assert.equal(output.questions.length, 0);
    completeRetry(input.state, index + 1, 0, 1, output.failures);
  }
  assert.equal(input.state.budget!.slots.s.generations, 0);
  assert.equal(input.state.budget!.slots.s.blocked?.code, "insufficient_basis");
  assert.equal(input.state.budget!.calls, 2);
});

test("旧无教材标题重复槽位一次恢复，历史预算保留，不影响有教材及技能", () => {
  const input = fixture();
  const slot = input.state.budget!.slots.s;
  slot.generations = 4;
  slot.blocked = { code: "duplicate", message: "候选重复" };
  slot.evidenceSources = scopeSources;
  input.state.budget!.calls = 8;
  assert.equal(recoverNoTextbookTheory(input.state, { ...snapshot, nodes: [{ ...snapshot.nodes[0], chapterIds: ["book"] }] }, "A"), false);
  assert.equal(recoverNoTextbookTheory(input.state, { ...snapshot, scope: { ...snapshot.scope, assessmentMode: "操作技能" } }, "A"), false);
  assert.equal(recoverNoTextbookTheory(input.state, snapshot, "A"), true);
  assert.equal(theoryGenerationLimit(slot), 5);
  assert.equal(slot.generations, 4);
  assert.equal(input.state.budget!.calls, 8);
  assert.equal(input.state.budget!.maxCalls, 24);
  slot.blocked = { code: "duplicate", message: "再次重复" };
  assert.equal(recoverNoTextbookTheory(input.state, snapshot, "A"), false);
});
