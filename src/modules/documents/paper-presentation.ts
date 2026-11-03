export type PaperFormat = {
  id: "theory_sample_v1" | "skill_sample_v1";
  sampleName: string; sampleSha256: string; bodyFont: string; bodySize: number;
  page: { width: number; height: number; top: number; bottom: number; left: number; right: number };
};
export type PaperPresentation = {
  format: PaperFormat; occupationName: string; levelCode: string; assessmentMode: string; durationMinutes: number;
};
export type SkillExam = {
  title?: string; venuePreparation?: string; candidatePreparation?: string;
  minutes?: number; method?: string; requirements?: string; veto?: string;
};
export type SkillDisplay = {
  title: string; evaluationPoint: string; venuePreparation: string; candidatePreparation: string;
  time: string; method: string; requirements: string; veto: string;
};
const normalizeText = (value: string) => value.normalize("NFKC").replace(/\s+/g, "").trim();
export function paperFormat(mode: string): PaperFormat {
  if (mode !== "skill" && mode !== "theory") throw new Error("未知考核方式，无法确定试卷样式。");
  return mode === "skill" ? {
    id: "skill_sample_v1", sampleName: "劝募-技能-四级试题样例1.docx",
    sampleSha256: "583f6b1bc0969399d076af51f26d955ffb4c186a0373f8e2a0aca7aef6d09f02",
    bodyFont: "仿宋", bodySize: 21,
    page: { width: 11906, height: 16838, top: 1440, bottom: 1440, left: 1800, right: 1800 },
  } : {
    id: "theory_sample_v1", sampleName: "理论知识-五级试卷样例.doc",
    sampleSha256: "511e2e4b9ea61ed74ca391cf51f49ac4b008dcfbbb34d6fef2920cdc3bf77d4b",
    bodyFont: "宋体", bodySize: 21,
    page: { width: 11906, height: 16838, top: 1134, bottom: 1134, left: 2000, right: 1134 },
  };
}
export function parseRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const savedText = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;
const savedMinutes = (value: unknown) => {
  const number = typeof value === "number" ? value
    : typeof value === "string" && value.trim() && /^-?\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value.trim())
    : NaN;
  return Number.isFinite(number) && number > 0 ? number : undefined;
};
function skillExamFromStructure(
  structureValue: unknown,
  target: { direction?: string; names: string[] },
): { minutes?: number; method?: string } {
  const structure = parseRecord(structureValue);
  const normalizedNames = target.names.map((name) => normalizeText(name)).filter(Boolean);
  const normalizedDirection = normalizeText(target.direction ?? "通用");
  if (!normalizedNames.length) return {};
  const scopedRows = Array.isArray(structure.standardScopes) ? structure.standardScopes.flatMap((scopeValue) => {
    const scope = parseRecord(scopeValue);
    const column = parseRecord(scope.column);
    const scopeDirection = normalizeText(savedText(column.direction) ?? "通用");
    if (normalizedDirection && normalizedDirection !== scopeDirection && scopeDirection !== normalizeText("通用")) return [];
    const rules = parseRecord(scope.assessmentRules);
    return (Array.isArray(scope.rows) ? scope.rows : []).map((rowValue) => {
      const row = parseRecord(rowValue);
      const rowName = normalizeText(savedText(row.name) ?? "");
      return normalizedNames.includes(rowName)
        ? { minutes: savedMinutes(row.minutes), method: savedText(row.method) ?? savedText(rules.method) }
        : null;
    }).filter((row) => Boolean(row)) as Array<{ minutes?: number; method?: string }>;
  }) : [];
  if (scopedRows.length) return scopedRows[0];
  const flatRows = Array.isArray(structure.rows) ? structure.rows.map((rowValue) => {
    const row = parseRecord(rowValue);
    const rowName = normalizeText(savedText(row.name) ?? "");
    return normalizedNames.includes(rowName)
      ? { minutes: savedMinutes(row.minutes), method: savedText(row.method) }
      : null;
  }).filter((row) => Boolean(row)) as Array<{ minutes?: number; method?: string }> : [];
  return flatRows[0] ?? {};
}
function deriveSkillExamFromSource(value: unknown) {
  const source = parseRecord(value);
  const structure = parseRecord(source.skillStructure);
  const skillContext = parseRecord(source.skillContext);
  const point = parseRecord(skillContext.point);
  const standardRequirement = parseRecord(point.sourceStandardRequirement);
  const functionName = savedText(standardRequirement.functionName) ?? savedText(point.level2Name);
  const direction = savedText(point.direction) ?? "通用";
  if (!functionName) return {};
  const scopedRows = Array.isArray(structure.standardScopes) ? structure.standardScopes.flatMap((scopeValue) => {
    const scope = parseRecord(scopeValue);
    const column = parseRecord(scope.column);
    if (normalizeText(savedText(column.direction) ?? "通用") !== normalizeText(direction)) return [];
    const rules = parseRecord(scope.assessmentRules);
    return (Array.isArray(scope.rows) ? scope.rows : []).map((rowValue) => {
      const row = parseRecord(rowValue);
      return normalizeText(savedText(row.name) ?? "") === normalizeText(functionName)
        ? { minutes: savedMinutes(row.minutes), method: savedText(row.method) ?? savedText(rules.method) }
        : null;
    }).filter((row) => Boolean(row)) as Array<{ minutes?: number; method?: string }>;
  }) : [];
  if (scopedRows.length) return scopedRows[0];
  const flatRows = Array.isArray(structure.rows) ? structure.rows.map((rowValue) => {
    const row = parseRecord(rowValue);
    return normalizeText(savedText(row.name) ?? "") === normalizeText(functionName)
      ? { minutes: savedMinutes(row.minutes), method: savedText(row.method) }
      : null;
  }).filter((row) => Boolean(row)) as Array<{ minutes?: number; method?: string }> : [];
  return flatRows[0] ?? {};
}
export function paperItemContent(
  item: { content_snapshot_json: unknown; assessment_point_names?: unknown; source_snapshot_json?: unknown },
  fallback?: { structureSnapshot?: unknown },
) {
  const content = parseRecord(item.content_snapshot_json);
  let names = item.assessment_point_names;
  if (typeof names === "string") {
    try { names = JSON.parse(names); } catch { names = []; }
  }
  const evaluationPoint = Array.isArray(names) ? [...new Set(names.filter((value) => typeof value === "string"))].join("、") : undefined;
  const presentation = parseRecord(content.assemblyPresentation);
  const source = parseRecord(item.source_snapshot_json);
  const point = parseRecord(parseRecord(source.skillContext).point);
  const standardRequirement = parseRecord(point.sourceStandardRequirement);
  const range = parseRecord(content.assemblyWeightRange);
  const structureSkillExam = skillExamFromStructure(fallback?.structureSnapshot, {
    direction: savedText(point.direction) ?? savedText(range.direction) ?? "通用",
    names: [
      savedText(standardRequirement.functionName) ?? "",
      savedText(point.level2Name) ?? "",
      savedText(range.name) ?? "",
    ],
  });
  const derivedSkillExam = deriveSkillExamFromSource(item.source_snapshot_json);
  const skillExam: SkillExam = { ...derivedSkillExam, ...structureSkillExam, ...parseRecord(presentation.skillExam ?? content.skillExam) };
  return {
    ...content,
    assemblyPresentation: {
      ...presentation,
      evaluationPoint: savedText(presentation.evaluationPoint) ?? evaluationPoint,
      skillExam,
    },
  };
}
export function skillDisplay(item: { item_no: number; stem_snapshot: string; content_snapshot_json: unknown }): SkillDisplay {
  const content = parseRecord(item.content_snapshot_json);
  const frozen = parseRecord(content.assemblyPresentation);
  const details = parseRecord(frozen.skillExam ?? content.skillExam);
  const evaluationPoint = savedText(frozen.evaluationPoint) ?? "待核对（未保存评价点名称）";
  const exactMinutes = savedMinutes(details.minutes);
  return {
    title: savedText(details.title) ?? (savedText(frozen.evaluationPoint) ? evaluationPoint : `操作技能试题${item.item_no}`),
    evaluationPoint, venuePreparation: savedText(details.venuePreparation) ?? "待核对（题库未保存考场及设备设施准备要求）",
    candidatePreparation: savedText(details.candidatePreparation) ?? "待核对（题库未保存工具及其他准备要求）",
    time: exactMinutes ? `${exactMinutes}分钟` : "待核对（未保存单题考核时间，不按总时间或分值推算）",
    method: savedText(details.method) ?? "待核对（未保存具体考核形式）",
    requirements: savedText(details.requirements) ?? item.stem_snapshot,
    veto: savedText(details.veto) ?? "待核对（题库未保存否定项，不擅自设定零分规则）",
  };
}
export const paperLevels: Record<string, string> = {
  level_5: "五级/初级工", level_4: "四级/中级工", level_3: "三级/高级工", level_2: "二级/技师", level_1: "一级/高级技师",
};
export function chineseNumber(value: number): string {
  if (value < 1 || value > 99) return String(value);
  const digits = "零一二三四五六七八九";
  return value < 10 ? digits[value] : `${value >= 20 ? digits[Math.floor(value / 10)] : ""}十${value % 10 ? digits[value % 10] : ""}`;
}
export function sectionInstruction(items: Array<{ item_no: number; score: number | string; question_type: string }>, ordinal: number) {
  const type = items[0].question_type.replace(/^[A-Z]\s+/, "");
  const instructions = /多.*选/.test(type) ? "选择所有正确答案，将相应字母填入题内括号中。"
    : /选/.test(type) ? "选择一个正确答案，将相应字母填入题内括号中。"
    : /判断/.test(type) ? "将判断结果填入括号中，正确的填“√”，错误的填“×”。"
    : "请按题目要求，在规定位置作答。";
  const total = items.reduce((sum, item) => sum + Math.round(Number(item.score) * 100), 0) / 100;
  const each = new Set(items.map((item) => Number(item.score)));
  return `${chineseNumber(ordinal)}、${type}（第${items[0].item_no}题～第${items[items.length - 1].item_no}题。${instructions}${each.size === 1 ? `每题${Number(items[0].score)}分，` : "各题分值见题目，"}满分${total}分。）`;
}
