import { z } from "zod";
import type { StandardScope } from "./skill-standard";
import type { ModelCaller } from "./theory-outline-generation/generation-batch";

export type KnowledgeChunk = { chapterId: string | null; locator: string; text: string };
const entrySchema = z.object({
  knowledgeName: z.string().trim().min(2).max(500),
  evidence: z.string().trim().min(4).max(4000),
  name: z.string().trim().min(2).max(500).regex(/[\u4e00-\u9fff]/),
  scopeKey: z.string().trim().min(1),
  rowName: z.string().trim().min(1),
  importance: z.enum(["X", "Y", "Z"]),
});
export type SkillKnowledgeEntry = z.infer<typeof entrySchema>;
export function splitKnowledgeText(text: string, chapterId: string | null, locator: string): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + 6000, text.length);
    if (end < text.length) {
      const breakAt = Math.max(text.lastIndexOf("\n", end), text.lastIndexOf("。", end));
      if (breakAt > start + 3000) end = breakAt + 1;
    }
    const content = text.slice(start, end);
    if (content.trim()) chunks.push({ chapterId, locator: `${locator} · 字符${start + 1}～${end}`, text: content });
    start = end;
  }
  return chunks;
}
const normalize = (text: string) => text.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
export function knowledgeEntryKey(entry: Pick<SkillKnowledgeEntry, "knowledgeName" | "scopeKey">) {
  return normalize(entry.knowledgeName);
}
export function parseKnowledgeEntries(content: string, text: string, scopes: StandardScope[]) {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const payload = JSON.parse(cleaned);
  const record = payload.data ?? payload;
  if ((record.completed ?? record.提取完成) !== true) throw new Error("知识点提取未完整完成，不发布截断结果。");
  const raw = record.knowledgePoints ?? record.知识点;
  if (!Array.isArray(raw)) throw new Error("AI响应缺少知识点列表。");
  const seen = new Set<string>();
  return raw.map((value): SkillKnowledgeEntry => {
    const entry = entrySchema.parse({
      knowledgeName: value.knowledgeName ?? value.知识点名称,
      evidence: value.evidence ?? value.原文依据,
      name: value.name ?? value.鉴定点名称,
      scopeKey: value.scopeKey ?? value.等级方向标识,
      rowName: value.rowName ?? value.二级范围名称,
      importance: value.importance ?? value.重要程度,
    });
    const scope = scopes.find((item) => item.column.key === entry.scopeKey);
    if (!scope?.rows.some((row) => row.name === entry.rowName)) throw new Error("知识点的等级、方向或考评范围不属于当前内容结构。");
    if (!normalize(text).includes(normalize(entry.evidence))) throw new Error("知识点原文依据无法在教材或标准中核验。");
    if (/^(?:考评点|鉴定点|知识点|测试|示例)\s*\d*$/u.test(entry.name)) throw new Error("知识点返回了占位鉴定点名称。");
    const key = knowledgeEntryKey(entry);
    if (seen.has(key)) throw new Error("同一知识点返回了多个鉴定点，请重新提取。");
    seen.add(key);
    return entry;
  });
}

export async function extractSkillKnowledge(
  chunk: KnowledgeChunk, scopes: StandardScope[], mode: "textbook" | "model", existing: string[], model: ModelCaller,
) {
  const instruction = `你是操作技能教材与职业标准分析专家。${mode === "textbook" ? "提取正文中的全部独立知识点" : "仅提取国家职业标准中的明确技能要求条目，排除权重表、目录、理论知识和示例"}。
一个独立知识点（或一条技能要求）严格对应一个可实操考核的鉴定点，不能把同一点扩写成多条，也不能为了权重、题量或覆盖等级而补造知识点。
每条选择最适合的一个等级方向scopeKey和二级范围rowName，不复制到其他等级或方向；共有技能选最低适用等级。无法归入给定结构的内容跳过。
evidence必须逐字引用本段原文；knowledgeName保持独立知识点原意，name转换为动宾结构的实操任务。跳过目录、页码、重复知识点和已经提取的项目。
只有完整读取本段后completed才填true。只返回JSON：{"completed":true,"knowledgePoints":[{"knowledgeName":"知识点名称","evidence":"逐字原文依据","name":"实操鉴定点名称","scopeKey":"给定的等级方向标识","rowName":"给定的二级范围名称","importance":"X"}]}。没有适用条目时返回空列表，不得填占位内容。importance只允许X/Y/Z。`;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const content = await model(instruction, JSON.stringify({
        来源位置: chunk.locator, 正文: chunk.text,
        可用考评范围: scopes.map((scope) => ({ scopeKey: scope.column.key, 等级: scope.column.label, 职业方向: scope.column.direction, 二级范围: scope.rows.map((row) => row.name) })),
        已提取知识点: existing,
      }), 0);
      return parseKnowledgeEntries(content, chunk.text, scopes);
    } catch (error) { lastError = error; }
  }
  throw new Error(`${chunk.locator}知识点提取失败：${lastError instanceof Error ? lastError.message : "模型调用失败"}`);
}
