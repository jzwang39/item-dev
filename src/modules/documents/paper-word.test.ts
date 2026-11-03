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
  assert.match(value, /1．捐赠凭证应如何管理？（　　）/);
  assert.doesNotMatch(value, /1．捐赠凭证应如何管理？（2分）/);
  for (const text of ["参考答案", "核验并登记", "核验资料得3分"]) assert.ok(!value.includes(text));
});
test("选择题导出时剥离误混入题干的选项，并按行输出选项", async () => {
  const contaminated: PaperWord = {
    ...paper,
    items: [{
      item_no: 3,
      section_no: 1,
      question_type: "单项选择题",
      stem_snapshot: "根据职业守则内容，以下哪项不属于对公益热爱的表现？\n(A) 热爱公益\n(B) 诚信守法\n(C) 尊重伦理\n(D) 敬业奉献",
      content_snapshot_json: { options: [
        { key: "A", content: "热爱公益" },
        { key: "B", content: "诚信守法" },
        { key: "C", content: "尊重伦理" },
        { key: "D", content: "敬业奉献" },
      ] },
      answer_snapshot_json: { answers: ["D"] },
      score_rubric_snapshot_json: null,
      score: 1,
    }],
  };
  const { value } = await extractRawText({ buffer: await createPaperWord(contaminated, "paper") });
  assert.match(value, /3．根据职业守则内容，以下哪项不属于对公益热爱的表现？（　　）/);
  assert.equal((value.match(/热爱公益/g) ?? []).length, 1);
  assert.equal((value.match(/诚信守法/g) ?? []).length, 1);
  assert.equal((value.match(/尊重伦理/g) ?? []).length, 1);
  assert.equal((value.match(/敬业奉献/g) ?? []).length, 1);
  assert.match(value, /A、热爱公益\s+B、诚信守法\s+C、尊重伦理\s+D、敬业奉献/);
});
test("判断题导出时剥离误混入的选择题问法，仅保留判断陈述", async () => {
  const contaminated: PaperWord = {
    ...paper,
    items: [{
      item_no: 92,
      section_no: 2,
      question_type: "判断题",
      stem_snapshot: "在募捐工作中，以下哪种方法最有利于资料的长期保存？按照捐赠者姓名分类。",
      content_snapshot_json: {},
      answer_snapshot_json: { answers: ["错误"] },
      score_rubric_snapshot_json: null,
      score: 1,
    }],
  };
  const { value } = await extractRawText({ buffer: await createPaperWord(contaminated, "paper") });
  assert.match(value, /92．（　　）按照捐赠者姓名分类。/);
  assert.doesNotMatch(value, /以下哪种方法最有利于资料的长期保存/);
});
test("判断题导出时将是否问句改写为陈述句", async () => {
  const contaminated: PaperWord = {
    ...paper,
    items: [{
      item_no: 81,
      section_no: 2,
      question_type: "判断题",
      stem_snapshot: "公益项目资金使用透明度要求的执行和监督机制是否由公益项目本身完全负责？",
      content_snapshot_json: {},
      answer_snapshot_json: { answers: ["错误"] },
      score_rubric_snapshot_json: null,
      score: 1,
    }, {
      item_no: 87,
      section_no: 2,
      question_type: "判断题",
      stem_snapshot: "在募捐工作中，资料分类的伦理考量是否是应该优先考虑捐赠者的隐私保护？",
      content_snapshot_json: {},
      answer_snapshot_json: { answers: ["正确"] },
      score_rubric_snapshot_json: null,
      score: 1,
    }],
  };
  const { value } = await extractRawText({ buffer: await createPaperWord(contaminated, "paper") });
  assert.match(value, /81．（　　）公益项目资金使用透明度要求的执行和监督机制由公益项目本身完全负责。/);
  assert.match(value, /87．（　　）在募捐工作中，资料分类的伦理考量应该优先考虑捐赠者的隐私保护。/);
  assert.doesNotMatch(value, /是否由公益项目本身完全负责/);
  assert.doesNotMatch(value, /是否是应该优先考虑/);
});
test("理论答案卷按样例样式输出客观题答案键，并保留主观题评分标准", async () => {
  const { value } = await extractRawText({ buffer: await createPaperWord(paper, "answers") });
  for (const text of ["职业技能等级认定", "劝募员四级/中级工理论知识试卷答案", "一、单项选择题", "1. A", "二、简答题", "核验并登记", "核验资料得3分"]) {
    assert.ok(value.includes(text), text);
  }
  assert.ok(!value.includes("冻结试卷 · 答案及评分标准"));
  assert.ok(!value.includes("考试时间：120 分钟"));
  assert.ok(!value.includes("参考答案：A"));
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
