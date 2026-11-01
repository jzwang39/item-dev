import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { documentText, publicIpv4, trustedDocumentUrl } from "./external-document";
import { factualTheorySources } from "./evidence-catalog";
import { acquireTheoryExpansion, parseExpansionAudit } from "./theory-expansion";
import { ensureTargetedBudget, recoverNoTextbookTheory, theoryGenerationLimit } from "./targeted-budget";
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
