export const skillLevels = ["level_5", "level_4", "level_3", "level_2", "level_1"] as const;
export type SkillColumn = { key: string; levelCode: string; label: string; direction: string };
export type StandardWeight = { name: string; weights: Record<string, number>; columnWeights: Record<string, number | null> };
export type StandardScope = {
  column: SkillColumn; totalMinutes: number | null;
  assessmentRules?: SkillAssessmentRules;
  rows: { code: string; name: string; score: number; selection: string | null; minutes: number | null; method: string | null }[];
};
export type SkillAssessmentRules = {
  minimumMinutes: number | null;
  method: string | null;
  timeEvidence: string | null;
  methodEvidence: string | null;
};
export type SkillStandardData = { columns: SkillColumn[]; items: StandardWeight[]; scopes: StandardScope[]; warnings: string[] };
const labels = ["五级/初级工", "四级/中级工", "三级/高级工", "二级/技师", "一级/高级技师"];
const cell = "(?:—|--|-|\\d+(?:\\.\\d+)?%?)";

export function parseSkillAssessmentRules(input: string): SkillAssessmentRules {
  const text = input.normalize("NFKC").replace(/\s+/g, "");
  // Read only the official assessment sections, not training hours or theory exams.
  const section = (title: string) => {
    const heading = new RegExp(`1\\.9\\.\\d+${title}`).exec(text);
    return heading ? text.slice(heading.index + heading[0].length).split(/1\.9\.\d+/)[0] : "";
  };
  const methodSection = section("鉴定方式");
  const timeSection = section("鉴定时间");
  const method = methodSection.match(/技能考核(?:主要)?(?:采用|以)([^;。]+?)(?:等方式(?:为主|进行)?|方式(?:为主|进行))/);
  const time = timeSection.match(/技能考核时间不少于(\d+(?:\.\d+)?)(?:min|分钟)/i);
  return {
    minimumMinutes: time ? Number(time[1]) : null,
    method: method ? method[1].replace(/[,，]$/, "") : null,
    timeEvidence: time?.[0] ?? null,
    methodEvidence: method?.[0] ?? null,
  };
}

export function parseSkillStandard(input: string): SkillStandardData {
  let text = input.normalize("NFKC").replace(/[－–―─]/g, "—").replace(/—+/g, "—").replace(/\r/g, "\n");
  // PDF text can split table headings into individual characters.
  for (const heading of ["技能要求权重表", "技能要求", "普通车床", "数控车床", "高级技师", "初级工", "中级工", "高级工"]) {
    text = text.replace(new RegExp(Array.from(heading).join("\\s*"), "g"), heading);
  }
  const start = text.search(/技能要求权重表/);
  if (start < 0) throw new Error("未找到“技能要求权重表”，请上传完整国家职业技能标准。");
  const section = text.slice(start + "技能要求权重表".length).split(/合\s*计/)[0];
  const first = section.match(new RegExp(`([^\\d\\n]+?)\\s+(${cell}(?:\\s+${cell}){4,})`));
  if (!first) throw new Error("未识别到完整技能权重行，请检查PDF文本或先完成OCR。");
  const count = first[2].trim().split(/\s+/).length;
  const header = section.slice(0, (first.index ?? 0) + first[1].length);
  let columns: SkillColumn[];
  if (count === 5) {
    columns = skillLevels.map((levelCode, index) => ({ key: levelCode, levelCode, label: labels[index], direction: "通用" }));
  } else if (count === 9 && /普通车床/.test(header) && /数控车床/.test(header)) {
    columns = skillLevels.flatMap((levelCode, index) => (index === 0 ? ["通用"] : ["普通车床", "数控车床"]).map((direction) => ({
      key: `${levelCode}:${direction}`, levelCode, label: labels[index], direction,
    })));
  } else {
    throw new Error(`识别到${count}列权重，但无法可靠对应等级和职业方向，本次不保存。`);
  }
  const flat = section.replace(/\s+/g, " ").trim();
  const pattern = new RegExp(`(${cell}(?:\\s+${cell}){${count - 1}})(?!\\s+${cell}(?:\\s|$))`, "g");
  const items: StandardWeight[] = [];
  let end = 0;
  for (const match of flat.matchAll(pattern)) {
    const prefix = flat.slice(end, match.index);
    end = match.index! + match[0].length;
    // Ignore prose mentioning the table and its repeated title before the header.
    const tablePrefix = prefix.slice(prefix.lastIndexOf("技能要求权重表") < 0 ? 0 : prefix.lastIndexOf("技能要求权重表") + "技能要求权重表".length);
    const projectPrefix = items.length === 0 ? tablePrefix
      .replace(/^.*技能要求\s*/, "")
      .replace(/[一二三四五]级\s*[/／]?\s*(?:高级技师|初级工|中级工|高级工|技师)\s*(?:\(%\))?/g, "")
      .replace(/(?:普通车床|数控车床|通用)(?=\s|$)/g, "")
      .replace(/项目分类|技能项目\s*[/／]\s*职业功能|^\s*项\s*目\s+|技能等级|等级|百分比|\(\s*%\s*\)/g, "") : prefix;
    const name = projectPrefix
      .replace(/技能\s*要求/g, "")
      .replace(/^\s*\d+[.、]\s*/, "")
      .replace(/\s+/g, "");
    if (!name || /等级|初级工|中级工|高级工|技师|百分比|权重|通用|车床$/.test(name)) continue;
    const values = match[1].split(/\s+/).map((value) => /^(—|--|-)$/.test(value) ? null : Number(value.replace("%", "")));
    if (values.some((value) => value !== null && (!Number.isFinite(value) || value < 0 || value > 100))) throw new Error(`“${name}”权重超出0～100%。`);
    const columnWeights = Object.fromEntries(columns.map((column, index) => [column.key, values[index]]));
    // Legacy single-direction consumers use the first direction, never sum
    // mutually exclusive career directions into a misleading percentage.
    const weights = Object.fromEntries(skillLevels.map((level) => [level, columnWeights[columns.find((column) => column.levelCode === level)!.key] ?? 0]));
    items.push({ name, weights, columnWeights });
  }
  if (!items.length || new Set(items.map((item) => item.name)).size !== items.length) throw new Error("技能项目为空或名称重复，本次不保存。");
  for (const column of columns) {
    const total = items.reduce((sum, item) => sum + (item.columnWeights[column.key] ?? 0), 0);
    if (total !== 0 && Math.abs(total - 100) > 0.0001) throw new Error(`${column.label} ${column.direction}合计${total}%，应为100%，本次不保存。`);
  }
  if (!columns.some((column) => items.some((item) => (item.columnWeights[column.key] ?? 0) > 0))) throw new Error("技能权重全部为空，本次不保存。");
  const assessmentRules = parseSkillAssessmentRules(text);
  const scopes: StandardScope[] = columns.filter((column) => items.some((item) => (item.columnWeights[column.key] ?? 0) > 0)).map((column) => ({
    assessmentRules,
    column, totalMinutes: null as number | null, rows: items.map((item, index) => ({
      code: `S-${String(index + 1).padStart(3, "0")}`, name: item.name, score: item.columnWeights[column.key] ?? 0,
      selection: null as string | null, minutes: null as number | null, method: assessmentRules.method,
    })).filter((row) => row.score > 0),
  }));
  // Explicit long-form structure rows are read only within the structure table:
  // grade [direction] project selection weight minutes method.
  const structureStart = text.search(/操作技能考评内容结构表/);
  const structure = structureStart < 0 ? "" : text.slice(structureStart);
  for (const scope of scopes) {
    for (const row of scope.rows) {
      const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("/", "\\s*[/／]?\\s*");
      const direction = scope.column.direction === "通用" ? "(?:通用\\s*)?" : `${escaped(scope.column.direction)}\\s*`;
      const expression = new RegExp(`${escaped(scope.column.label)}\\s*${direction}${escaped(row.name)}\\s+(必考|必考项|选考)\\s+(\\d+(?:\\.\\d+)?)%?\\s+(\\d+(?:\\.\\d+)?)\\s*(?:分钟|min)?\\s*(实操与口试|实操|实操考核|模拟|口试|笔试)`, "i");
      const match = structure.match(expression);
      if (match) {
        if (Number(match[2]) !== row.score) throw new Error(`内容结构“${row.name}”权重与技能权重表不一致。`);
        row.selection = match[1]; row.minutes = Number(match[3]); row.method = match[4];
      }
    }
    // Matrix tables are accepted only when every project cell is present.
    // Unknown layouts remain unverified rather than shifting values across columns.
    const grade = new RegExp(scope.column.label.replace("/", "\\s*[/／]\\s*"), "g");
    const directions = columns.filter((column) => column.levelCode === scope.column.levelCode).map((column) => column.direction);
    const match = Array.from(structure.matchAll(grade)).find((candidate) => {
      const candidateBlock = structure.slice(candidate.index! + candidate[0].length).split(/[一二三四五]级\s*[/／]/)[0];
      return /选考方式|考核权重|考试时间|考核方式/.test(candidateBlock)
        && (directions.length === 1 || candidateBlock.trimStart().startsWith(scope.column.direction));
    });
    if (match) {
      const block = structure.slice(match.index! + match[0].length).split(/[一二三四五]级\s*[/／]/)[0];
      const applicable = directions.length === 1 || block.trimStart().startsWith(scope.column.direction);
      if (applicable) {
        const readCells = (marker: RegExp, valuePattern: string) => {
          const markerMatch = marker.exec(block);
          if (!markerMatch) return null;
          const tail = block.slice(markerMatch.index + markerMatch[0].length).trimStart();
          const values = tail.match(new RegExp(`^(?:${valuePattern})(?:\\s+(?:${valuePattern})){${items.length - 1}}(?=\\s|$)`));
          return values ? values[0].split(/\s+/) : null;
        };
        const selections = readCells(/选考方式\s*/, "必考|选考|—|--|-");
        const minutes = readCells(/考试时间\s*(?:\((?:min|分钟)\))?\s*/i, cell);
        const methods = readCells(/考核方式\s*/, "实操与口试|实操|模拟|口试|笔试|—|--|-");
        const scores = readCells(/考核权重\s*(?:\(%\))?\s*/, cell);
        for (const row of scope.rows) {
          const index = items.findIndex((item) => item.name === row.name);
          if (scores && Number(scores[index].replace("%", "")) !== row.score) throw new Error(`内容结构“${row.name}”权重与技能权重表不一致。`);
          if (selections && /^(必考|选考)$/.test(selections[index])) row.selection = selections[index];
          if (minutes && /^\d/.test(minutes[index])) row.minutes = Number(minutes[index].replace("%", ""));
          if (methods && !/^(—|--|-)$/.test(methods[index])) row.method = methods[index];
        }
      }
    }
    if (scope.rows.every((row) => row.minutes !== null)) scope.totalMinutes = scope.rows.reduce((sum, row) => sum + row.minutes!, 0);
  }
  const incomplete = scopes.some((scope) => scope.rows.some((row) => row.selection === null || row.minutes === null || row.method === null));
  return { columns, items, scopes, warnings: incomplete ? ["内容结构已按权重形成。标准未明确或无法可靠识别的选考方式、考试时间、考核方式显示“待核对”，未自动均分时间或设为必考。"] : [] };
}
