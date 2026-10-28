import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "mysql2/promise";
import { runLegalJob } from "./legal-service";
import { confirmQuestionBatch } from "./bulk-question-confirmation";
import { storeQuestions } from "./question-storage";

const projectId = "00000000000000000000000018";
const quote = "测试条文用于验证通用命题的原文引用，不用于正式业务试题。";
const templates = [
  { assessmentPointCode: "law-6", questionType: "single", stem: "以下哪个选项符合给定测试条文规定的验证用途？",
    options: ["通用命题原文引用验证", "替代正式法律原文", "编造新的法律条款", "省略法律依据核验"].map((content, index) => ({ key: String.fromCharCode(65 + index), content })),
    answers: ["A"], analysis: "给定原文明确说明测试条文只用于验证通用命题的原文引用，不用于正式业务试题，因此该选项符合原文。",
    knowledge: "原文引用验证", difficulty: "easy", evidence: { clauseId: "第一条", quote } },
  { assessmentPointCode: "law-6", questionType: "judgement", stem: "给定测试条文可以直接用于正式业务试题。",
    options: [], answers: ["错误"], analysis: "给定原文明确声明测试条文仅用于验证通用命题的原文引用，不用于正式业务试题，因此该判断错误。",
    knowledge: "测试素材范围", difficulty: "easy", evidence: { clauseId: "第一条", quote } },
];
const payload = { questions: [
  ...Array.from({ length: 4 }, (_, index) => ({ ...templates[0], stem: `${templates[0].stem}（单选测试${index + 1}）` })),
  ...Array.from({ length: 2 }, (_, index) => ({ ...templates[1], stem: `${templates[1].stem}（判断测试${index + 1}）` })),
] };

test("通用命题不传职业等级考评点，保存后必须审核确认才能入库", async (context) => {
  const previous = globalThis.__itembankMysqlPool;
  context.after(() => { globalThis.__itembankMysqlPool = previous; });
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const questions: Array<{ id: string; project_id: string; current_version_id: string; current_status: string; confirmed_at: string | null }> = [];
  const job = {
    id: "generic-job", project_id: projectId, status: "queued", created_by: "admin", target_count: 6,
    snapshot_json: { scope: "generic", instructions: "", topics: [{
      id: "law-6", prompt: "测试管理员保存的专用提示词，不用于正式命题。", documentTitle: "中华人民共和国个人所得税法",
      clauses: [{ id: "第一条", text: quote }], revision: 1,
    }] },
  };
  const db = {
    beginTransaction: async () => undefined,
    commit: async () => undefined,
    rollback: async () => undefined,
    release: () => undefined,
    execute: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      if (sql.startsWith("SELECT * FROM legal_agent_jobs")) return [[job], []];
      if (sql.startsWith("UPDATE legal_agent_jobs SET status='running'")) job.status = "running";
      if (sql.startsWith("SELECT id FROM projects")) return [[{ id: projectId }], []];
      if (sql.startsWith("INSERT INTO questions(")) questions.push({
        id: values[0] as string, project_id: values[1] as string, current_version_id: values[6] as string,
        current_status: "pending_review", confirmed_at: null,
      });
      if (/SELECT q.id, ?q.project_id/.test(sql)) return [questions, []];
      if (sql.startsWith("SELECT question_version_id FROM question_review_confirmations")) {
        return [questions.filter((q) => q.current_version_id === values[0] && q.confirmed_at)
          .map((q) => ({ question_version_id: q.current_version_id })), []];
      }
      if (sql.startsWith("INSERT INTO question_review_confirmations")) questions.find((q) => q.current_version_id === values[0])!.confirmed_at = "now";
      if (sql.startsWith("UPDATE questions SET current_status='stored'")) questions.find((q) => q.id === values[0])!.current_status = "stored";
      return [[], []];
    },
  };
  globalThis.__itembankMysqlPool = { execute: db.execute, getConnection: async () => db } as unknown as Pool;
  let modelCalls = 0;
  await runLegalJob(job.id, async (system, user) => {
    modelCalls++;
    const input = JSON.parse(user);
    assert.equal(input.职业, undefined);
    assert.equal(input.等级, undefined);
    assert.equal(input.考评点, undefined);
    if (modelCalls === 1) {
      assert.equal(input.主题代码, "law-6");
      assert.ok(system.includes("不绑定职业"));
      assert.ok(system.includes("4道single和2道judgement"));
      return JSON.stringify(payload);
    }
    assert.ok(system.includes("全部6道题"));
    return JSON.stringify({ checks: payload.questions.map((_, index) => ({ index, supported: true, relevant: true, reason: "测试核验通过" })) });
  });
  assert.equal(modelCalls, 2);
  assert.equal(questions.length, 6);
  assert.ok(calls.some((call) => call.sql.startsWith("UPDATE legal_agent_jobs SET generated_count") && call.values[0] === 6));
  for (const call of calls.filter((call) => call.sql.startsWith("INSERT INTO questions("))) {
    assert.equal(call.values[1], projectId);
    assert.equal(call.values[3], null);
    assert.equal(call.values[4], null);
  }
  assert.ok(!calls.some((call) => call.sql.includes("INSERT INTO question_assessment_points")));
  const selected = questions.map((q) => ({ questionId: q.id, versionId: q.current_version_id }));
  const connection = db as unknown as Awaited<ReturnType<Pool["getConnection"]>>;
  await assert.rejects(storeQuestions(connection, selected, "admin"), /仅已审定/);
  questions.forEach((q) => { q.current_status = "approved"; });
  await assert.rejects(storeQuestions(connection, selected, "admin"), /确认/);
  await confirmQuestionBatch(connection, selected, "admin", "测试确认");
  assert.equal((await storeQuestions(connection, selected, "admin")).storedCount, 6);
  assert.ok(questions.every((q) => q.current_status === "stored"));
});
