import assert from "node:assert/strict";
import test from "node:test";
import { allowedClauses, validateLegalQuestions, type LegalConfigInput } from "./legal-contracts";
import { defaultLegalPrompt, isLegalPoint, legalTopics } from "./legal-topics";

const config: LegalConfigInput = {
  id: "law-6", prompt: "只根据正式原文编制理论知识试题，不能编造条款。",
  documentTitle: "中华人民共和国个人所得税法", documentVersion: "测试版本",
  effectiveDate: "2020-01-01", sourceUrl: "https://www.npc.gov.cn/test", confirmed: true,
  fullText: "中华人民共和国个人所得税法\n第一条 测试条文用于验证原文边界和引用规则，不用于正式命题。\n第二条 另一条测试条文用于验证第二条正文的引用范围。\n第三条 此条内容不得发送给个人所得税法命题模型。",
};
const quote = "测试条文用于验证原文边界和引用规则，不用于正式命题。";
function payload() {
  const templates = [
    { assessmentPointCode: "A-001", questionType: "single", stem: "以下哪个选项符合测试条文规定的验证用途？",
      options: ["原文边界验证", "无依据事实", "自行编造内容", "改变原文内容"].map((content, index) => ({ key: String.fromCharCode(65 + index), content })),
      answers: ["A"], analysis: "给定原文明确说明其用途是验证原文边界及引用规则，因此该选项符合原文，不涉及其他用途。",
      knowledge: "原文边界", difficulty: "easy", evidence: { clauseId: "第一条", quote } },
    { assessmentPointCode: "A-001", questionType: "judgement", stem: "测试条文明确声明不能将测试素材用于正式命题。",
      options: [], answers: ["正确"], analysis: "条文说明测试素材只供边界及引用规则验证，并且明确标注不用于正式命题，因此该判断成立。",
      knowledge: "测试素材范围", difficulty: "easy", evidence: { clauseId: "第一条", quote } },
  ];
  return { questions: [
    ...Array.from({ length: 4 }, (_, index) => ({ ...templates[0], stem: `${templates[0].stem}（单选测试${index + 1}）` })),
    ...Array.from({ length: 2 }, (_, index) => ({ ...templates[1], stem: `${templates[1].stem}（判断测试${index + 1}）` })),
  ] };
}

test("十类参考提示词数量固定为6，配额为4单选2判断", () => {
  assert.equal(legalTopics.length, 10);
  for (const topic of legalTopics) {
    assert.ok(defaultLegalPrompt(topic).includes("固定6道题：4道单项选择题、2道判断题"));
    assert.ok(defaultLegalPrompt(topic).includes("不得编造"));
  }
});
test("个人所得税法只取第1—2条，不虚构第一章，不含第3条", () => {
  const clauses = allowedClauses(config);
  assert.deepEqual(clauses.map((item) => item.id), ["第一条", "第二条"]);
  assert.ok(!clauses.some((clause) => clause.text.includes("此条内容")));
});
test("其他法规仅取第一章，正文不足或目录歧义时拒绝", () => {
  const source = { ...config, id: "law-2", documentTitle: "中华人民共和国劳动法",
    fullText: "中华人民共和国劳动法 第一章 总则 第一条 测试内容用于检查第一章的条款引用准确性。 第二条 测试第二条内容用于检查条文的连续性。 第二章 劳动合同 第三条 不应被取到的内容。" };
  assert.equal(allowedClauses(source).length, 2);
  assert.ok(!allowedClauses(source).some((item) => item.text.includes("劳动合同")));
  assert.throws(() => allowedClauses({ ...source, fullText: source.fullText.replace("第二章", "其他") }), /边界/);
});
test("缺少原文、版本、日期、确认或非权威链接时拒绝", () => {
  for (const field of ["fullText", "documentVersion", "effectiveDate", "sourceUrl"] as const) assert.throws(() => allowedClauses({ ...config, [field]: "" }));
  assert.throws(() => allowedClauses({ ...config, confirmed: false }));
  assert.throws(() => allowedClauses({ ...config, sourceUrl: "https://npc.gov.cn.evil.example/" }), /权威/);
  assert.throws(() => allowedClauses({ ...config, effectiveDate: "2099-01-01" }), /尚未施行/);
  assert.throws(() => allowedClauses({ ...config, effectiveDate: "2020-02-31" }), /无效/);
  assert.throws(() => allowedClauses({ ...config, documentTitle: "错误文件" }), /文件名称/);
});
test("重复条号、缺少条文、缺号时拒绝", () => {
  assert.throws(() => allowedClauses({ ...config, fullText: config.fullText.replace("第二条", "第一条") }), /编号重复/);
  assert.throws(() => allowedClauses({ ...config, fullText: config.fullText.replace("第二条", "第四条") }), /不连续/);
  assert.throws(() => allowedClauses({ ...config, fullText: "中华人民共和国个人所得税法 第一条 短文。" }), /完整覆盖/);
});
test("4单选2判断及逐字引用通过，改写或越章引用拒绝", () => {
  const clauses = allowedClauses(config);
  assert.equal(validateLegalQuestions(JSON.stringify(payload()), "A-001", clauses).length, 6);
  const invalid = payload();
  invalid.questions[0].evidence.clauseId = "第三条";
  assert.throws(() => validateLegalQuestions(JSON.stringify(invalid), "A-001", clauses), /允许章条/);
  invalid.questions[0].evidence.clauseId = "第一条";
  invalid.questions[0].evidence.quote = "此内容是模型编造的不存在原文中的内容。";
  assert.throws(() => validateLegalQuestions(JSON.stringify(invalid), "A-001", clauses), /虚构/);
});
test("错误配额、答案结构、取巧选项、解析长度和重复题干拒绝", () => {
  const clauses = allowedClauses(config);
  assert.throws(() => validateLegalQuestions('{"questions":[]}', "A-001", clauses), /恰好6道/);
  const oldQuota = payload(); oldQuota.questions = oldQuota.questions.slice(0, 2);
  assert.throws(() => validateLegalQuestions(JSON.stringify(oldQuota), "A-001", clauses), /恰好6道/);
  const wrongTypes = payload();
  wrongTypes.questions[3] = { ...wrongTypes.questions[4], stem: "用于验证三单选三判断配额拒绝的独立测试题干。" };
  assert.throws(() => validateLegalQuestions(JSON.stringify(wrongTypes), "A-001", clauses), /4道单选、2道判断/);
  const invalid = payload();
  invalid.questions[0].options[0].content = "以上都正确";
  assert.throws(() => validateLegalQuestions(JSON.stringify(invalid), "A-001", clauses), /取巧/);
  const short = payload(); short.questions[0].analysis = "短";
  assert.throws(() => validateLegalQuestions(JSON.stringify(short), "A-001", clauses), /30—80/);
  const repeated = payload(); repeated.questions[1].stem = repeated.questions[0].stem;
  assert.throws(() => validateLegalQuestions(JSON.stringify(repeated), "A-001", clauses), /不合法/);
});
test("法规识别使用父级名称和源依据，普通知识点不误判", () => {
  assert.equal(isLegalPoint({ name: "基本含义", tertiaryName: "2.2.6 相关法律、法规及标准知识" }), true);
  assert.equal(isLegalPoint({ name: "准备要点", requirement_json: { tertiaryName: "相关法律知识" } }), true);
  assert.equal(isLegalPoint({ name: "公开信息", source_ref_json: { standardBasic: { name: "法规知识" } } }), true);
  assert.equal(isLegalPoint({ name: "募捐基本理念", tertiaryName: "理念宣传" }), false);
});

test("人民网及新华社转载来源可用，伪装域名与非HTTPS仍拒绝", () => {
  for (const sourceUrl of ["https://cpc.people.com.cn/test", "https://www.news.cn/test", "https://www.xinhuanet.com/test"]) {
    assert.equal(allowedClauses({ ...config, sourceUrl }).length, 2);
  }
  for (const sourceUrl of ["https://people.com.cn.evil.example/test", "https://fakepeople.com.cn/test", "http://cpc.people.com.cn/test"]) {
    assert.throws(() => allowedClauses({ ...config, sourceUrl }), /原文出处/);
  }
});

test("Markdown加粗条号可解析且保持逐字原文，仍拒绝重复编号", () => {
  const source = { ...config, fullText: config.fullText.replace(/(第[一二三]条)/g, "**$1**") };
  assert.deepEqual(allowedClauses(source), allowedClauses(config));
  assert.throws(() => allowedClauses({ ...source, fullText: source.fullText.replace("第二条", "第一条") }), /编号重复/);
});

test("民法典使用施行日期，章节引导语不误识别为正文", () => {
  const numbers = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"];
  const source = { ...config, id: "law-1", documentTitle: "中华人民共和国民法典", effectiveDate: "2021-01-01",
    fullText: `《中华人民共和国民法典》第一编下的第一章和第二章原文如下：\n### 第一章 基本规定\n${numbers.map((number) => `**第${number}条** 测试条文用于验证格式解析，不用于正式业务命题。`).join("\n")}\n### 第二章 自然人\n**第十三条** 不属于命题范围。` };
  assert.equal(allowedClauses(source).length, 12);
  assert.throws(() => allowedClauses({ ...source, effectiveDate: "2020-05-28" }), /通过日期/);
  assert.throws(() => allowedClauses({ ...source, confirmed: false }), /确认已核验/);
});
