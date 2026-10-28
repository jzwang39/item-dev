import { createHash } from "node:crypto";
import { z } from "zod";
import { parseQuestions, type GeneratedQuestion } from "./generation/contracts";
import { legalQuestionQuota, legalTopics } from "./legal-topics";

export const legalConfigSchema = z.object({
  id: z.enum(legalTopics.map((topic) => topic.id) as [string, ...string[]]),
  prompt: z.string().trim().min(20).max(12000),
  documentTitle: z.string().trim().max(200),
  documentVersion: z.string().trim().max(200),
  effectiveDate: z.string().max(10),
  sourceUrl: z.string().trim().max(2000),
  fullText: z.string().trim().max(300000),
  confirmed: z.boolean(),
});
export type LegalConfigInput = z.infer<typeof legalConfigSchema>;
export type LegalConfig = LegalConfigInput & { revision: number; contentHash: string };
export type LegalClause = { id: string; text: string };
export type LegalQuestion = GeneratedQuestion & {
  evidence: { clauseId: string; quote: string };
  knowledge: string;
  difficulty: "easy";
};
export function compactLegalText(text: string) {
  return text.normalize("NFKC").replace(/\s+/g, "");
}
export function documentHash(text: string) {
  return createHash("sha256").update(text).digest("hex");
}
export function allowedClauses(config: LegalConfigInput): LegalClause[] {
  const topic = legalTopics.find((item) => item.id === config.id)!;
  if (!topic) throw new Error("未知法规主题。");
  if (!config.confirmed || !config.documentTitle || !config.documentVersion || !config.fullText || !config.effectiveDate || !config.sourceUrl) {
    throw new Error(`${topic.title}：须填写正式原文、版本、施行日期、权威出处，并确认已核验现行有效。`);
  }
  const url = new URL(config.sourceUrl);
  if (url.protocol !== "https:" || !/(?:^|\.)gov\.cn$|(?:^|\.)cnis\.ac\.cn$|(?:^|\.)people\.com\.cn$|(?:^|\.)xinhuanet\.com$|(?:^|\.)news\.cn$/.test(url.hostname)) {
    throw new Error("原文出处须为 HTTPS 政府、权威标准机构、人民网或新华社链接。");
  }
  const date = new Date(`${config.effectiveDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(config.effectiveDate) || !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== config.effectiveDate || date.getTime() > Date.now()) throw new Error("施行日期无效或尚未施行。");
  if (config.id === "law-1" && config.effectiveDate !== "2021-01-01") {
    throw new Error("民法典施行日期应为2021-01-01；2020-05-28是通过日期，不是施行日期。");
  }
  const text = compactLegalText(config.fullText);
  const title = compactLegalText(config.documentTitle).replace(/[《》]/g, "");
  if (config.id !== "law-10" && title !== topic.title) throw new Error(`文件名称必须为《${topic.title}》。`);
  if (!text.includes(title)) throw new Error("原文未出现填写的正式文件名称，请核对文件。");
  // Strip Markdown presentation markers without rewriting the quoted legal text.
  const readable = config.fullText.normalize("NFKC")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\*\*(第\s*[一二三四五六七八九十百零〇\d\s]+?\s*条)\*\*/g, "$1")
    .replace(/第\s*一\s*章/g, "第一章").replace(/第\s*二\s*章/g, "第二章");
  if (config.id === "law-10") {
    if (title === topic.title || !/(?:GB|GB\/T|[A-Z]{1,5}\/T)\s*\d+[-—]\d{4}/i.test(config.documentVersion)) throw new Error("标准须填写真实具体名称及标准编号和年份，不能使用泛称。");
    const candidates = [...readable.matchAll(/第一章|(?:^|[\s。；：])1[.、]?\s*(?:适用\s*范围|范\s*围|总\s*则)/g)]
      .map((start) => {
        const after = readable.slice(start.index! + start[0].length);
        const end = /第二章|(?:^|[\s。；：])2[.、]?\s*(?:规范性\s*引用\s*文件|术\s*语|总\s*则)/.exec(after);
        return end ? readable.slice(start.index!, start.index! + start[0].length + end.index).trim() : "";
      }).filter((section) => section.length >= 12);
    if (candidates.length !== 1) throw new Error("标准未唯一识别第一章／第1节及下一章节边界，请提供完整可提取文本并核对目录。");
    return [{ id: "第1节", text: candidates[0] }];
  }
  let scope = readable;
  if (config.id !== "law-6") {
    const starts = [...readable.matchAll(/第一章/g)];
    const candidates = starts.map((match) => {
      const after = readable.slice(match.index!);
      const end = after.indexOf("第二章");
      return end < 0 ? "" : after.slice(0, end);
    }).filter((section) => /第\s*一\s*条/.test(section));
    if (candidates.length !== 1) throw new Error("无法唯一识别第一章条文及第二章边界，请核对目录和正文。");
    scope = candidates[0];
  }
  const matches = [...scope.matchAll(/(?:^|\s)(第\s*[一二三四五六七八九十百零〇\d\s]+?\s*条)(?=\s)/g)];
  const clauses = matches.map((match, index) => ({
    id: compactLegalText(match[1]), text: scope.slice(match.index!, matches[index + 1]?.index ?? scope.length).trim(),
  }));
  const first = clauses.findIndex((clause) => clause.id === "第一条" || clause.id === "第1条");
  if (first !== 0 || !clauses.length || new Set(clauses.map((clause) => clause.id)).size !== clauses.length) throw new Error("条文缺失或编号重复，不能命题。");
  const selected = topic.maxArticle === null ? clauses : clauses.slice(0, topic.maxArticle);
  if (topic.maxArticle !== null && selected.length !== topic.maxArticle) throw new Error(`原文未完整覆盖前${topic.maxArticle}条。`);
  const chinese = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"];
  if (selected.some((clause, index) => index < chinese.length &&
    ![`第${chinese[index]}条`, `第${index + 1}条`].includes(clause.id))) throw new Error("条文编号不连续，不能可靠匹配依据。");
  if (selected.some((clause) => clause.text.length < 12)) throw new Error("原文条文内容不足，不能凑题。");
  return selected;
}

export function validateLegalQuestions(payload: string, code: string, clauses: LegalClause[]): LegalQuestion[] {
  const raw = JSON.parse(payload.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")) as { questions?: unknown[] };
  if (!Array.isArray(raw.questions) || raw.questions.length !== legalQuestionQuota.total) throw new Error("每个法规必须恰好6道题，不得凑题或多出。");
  const parsed = parseQuestions(JSON.stringify(raw), code, "mixed");
  if (parsed.valid.length !== legalQuestionQuota.total || parsed.invalid) throw new Error(`试题结构不合法：${parsed.invalidReasons[0] ?? "重复或缺失"}`);
  if (parsed.valid.filter((item) => item.questionType === "single").length !== legalQuestionQuota.single ||
    parsed.valid.filter((item) => item.questionType === "judgement").length !== legalQuestionQuota.judgement) throw new Error("每个法规须4道单选、2道判断。");
  return parsed.valid.map((question, index) => {
    const row = raw.questions![index] as Record<string, unknown>;
    const evidence = z.object({ clauseId: z.string(), quote: z.string().min(12).max(10000) }).parse(row.evidence);
    const clause = clauses.find((item) => item.id === evidence.clauseId);
    if (!clause || compactLegalText(evidence.quote).length < 12 || !compactLegalText(clause.text).includes(compactLegalText(evidence.quote))) throw new Error("原文引用虚构、过短或超出允许章条。");
    if (row.difficulty !== "easy" || typeof row.knowledge !== "string" || !row.knowledge.trim()) throw new Error("须提供知识点及易难度。");
    if (/以上都正确|以上都不正确/.test(JSON.stringify(question.options))) throw new Error("不允许取巧选项。");
    if (compactLegalText(question.analysis).length < 30 || compactLegalText(question.analysis).length > 80) throw new Error("解析须为30—80字。");
    return { ...question, evidence, knowledge: row.knowledge, difficulty: "easy" };
  });
}
