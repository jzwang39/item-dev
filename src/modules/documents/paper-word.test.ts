import assert from "node:assert/strict";
import test from "node:test";
import { extractRawText } from "mammoth";
import { answerText, createPaperWord, scoringText, type PaperWord } from "./paper-word";

const paper: PaperWord = {
  title: "冻结试卷", paper_no: "TEST-1", occupation_name: "劝募员", level_code: "level_4",
  assessment_mode: "theory", duration_minutes: 120, items: [{
    item_no: 1, section_no: 1, question_type: "单项选择题", stem_snapshot: "捐赠凭证应如何管理？",
    content_snapshot_json: JSON.stringify({ options: [{ key: "A", content: "按规范存档" }, { key: "B", text: "随意销毁" }] }),
    answer_snapshot_json: '{"answers":["A"]}', score_rubric_snapshot_json: null, score: "2.00",
  }, {
    item_no: 2, section_no: 2, question_type: "简答题", stem_snapshot: "简述捐赠工作流程。",
    content_snapshot_json: {}, answer_snapshot_json: { answers: ["核验并登记"] },
    score_rubric_snapshot_json: { 要点: ["核验资料得3分", "登记资料得2分"] }, score: 5,
  }],
};
test("试卷生成真实DOCX，包含题干选项但不泄漏答案或评分标准", async () => {
  const bytes = await createPaperWord(paper, "paper");
  assert.equal(bytes.subarray(0, 2).toString(), "PK");
  const { value } = await extractRawText({ buffer: bytes });
  for (const text of ["冻结试卷", "四级/中级工", "120 分钟", "2 题 / 7 分", "按规范存档", "随意销毁"]) assert.ok(value.includes(text));
  for (const text of ["参考答案", "核验并登记", "核验资料得3分"]) assert.ok(!value.includes(text));
});
test("答案卷包含参考答案和冻结的评分标准", async () => {
  const { value } = await extractRawText({ buffer: await createPaperWord(paper, "answers") });
  for (const text of ["答案及评分标准", "参考答案：A", "核验并登记", "核验资料得3分", "错答、漏答不得分"]) assert.ok(value.includes(text));
  assert.ok(!value.includes("随意销毁"));
});
test("缺少主观题评分标准时明确提示，不能编造", () => {
  assert.match(scoringText({ ...paper.items[1], score_rubric_snapshot_json: null })[0], /未保存评分标准/);
});
test("答案兼容对象、JSON字符串、数组和纯文本", () => {
  assert.equal(answerText({ answer: "正确" }), "正确");
  assert.equal(answerText('{"answers":["A","C"]}'), "A、C");
  assert.equal(answerText(["B"]), "B");
  assert.equal(answerText("参考文字"), "参考文字");
});
test("拒绝生成空白试卷", async () => {
  await assert.rejects(createPaperWord({ ...paper, items: [] }, "paper"), /没有题目/);
});
