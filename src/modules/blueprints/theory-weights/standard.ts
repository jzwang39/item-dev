import type { OccupationDirection } from "@/modules/authoring/occupations/directions";

export const theoryWeightLevels = ["level_5", "level_4", "level_3", "level_2", "level_1"] as const;
export type TheoryWeightLevel = (typeof theoryWeightLevels)[number];
export type TheoryWeightItem = { category: string; name: string; weights: Record<TheoryWeightLevel, number | null> };
export type TheoryWeightScope = {
  directionId: string | null;
  directionName: string;
  directionCode: string | null;
  occupationCode: string;
  items: TheoryWeightItem[];
};
export type StandardRequirement = {
  code: string;
  name: string;
  evidence: string;
  kind: "skill_requirement" | "related_knowledge";
};
export type StandardWorkContent = { code: string; name: string; requirements: StandardRequirement[] };
export type StandardFunction = { code: string; name: string; contents: StandardWorkContent[] };
export type StandardRequirementScope = {
  directionId: string | null;
  directionName: string;
  levelCode: TheoryWeightLevel;
  functions: StandardFunction[];
};
export type WeightColumnHint = { levelCode: TheoryWeightLevel; directionName: string | null };
export class TheoryWeightImportError extends Error {}

const gradePattern = /([五四三二一])级\s*\/\s*(初级工|中级工|高级工|高级技师|技师)/g;
const levelByGrade: Record<string, TheoryWeightLevel> = {
  五: "level_5", 四: "level_4", 三: "level_3", 二: "level_2", 一: "level_1",
};
const cellPattern = "(?:—|--|-|\\d+(?:\\.\\d+)?%?)";
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const compact = (text: string) => text.replace(/\s+/g, "");

export function normalizeStandardText(text: string): string {
  let result = text.normalize("NFKC").replace(/[－–―─]/g, "—").replace(/—+/g, "—").replace(/\r/g, "\n");
  for (const heading of ["理论知识权重表", "技能要求权重表", "职业功能", "工作内容", "技能要求", "相关知识要求", "工作要求", "基本要求", "相关知识要求", "合计", "初级工", "中级工", "高级工", "高级技师", "技师"]) {
    result = result.replace(new RegExp(Array.from(heading).join("\\s*"), "g"), heading);
  }
  result = result.replace(/([五四三二一])\s*级/g, "$1级").replace(/(\d)\s*[.．]\s*(?=\d)/g, "$1.");
  return result;
}

function directionMatches(text: string, directions: readonly OccupationDirection[]) {
  const matches: { direction: OccupationDirection; index: number; end: number }[] = [];
  for (const direction of directions) {
    const pattern = new RegExp(Array.from(compact(direction.name)).map(escape).join("\\s*"), "g");
    for (const match of text.matchAll(pattern)) {
      matches.push({ direction, index: match.index!, end: match.index! + match[0].length });
    }
  }
  // Overlapping direction names cannot safely identify a table column.
  matches.sort((a, b) => a.index - b.index || b.end - a.end);
  if (matches.some((item, index) => matches.slice(index + 1).some((other) => other.index < item.end && other.direction.id !== item.direction.id))) {
    throw new TheoryWeightImportError("职业方向名称相互包含，无法唯一匹配标准列，请使用标准中的完整方向名称。");
  }
  return matches;
}

export function parseDirectionalTheoryWeights(
  input: string,
  occupation: { name: string; code: string; directions: readonly OccupationDirection[] },
  columnHints?: readonly WeightColumnHint[],
): TheoryWeightScope[] {
  const text = normalizeStandardText(input);
  const title = /(?:4\s*[.、]?\s*1\s*)?理论知识权重表/.exec(text);
  if (!title) throw new TheoryWeightImportError("未找到“理论知识权重表”，请上传完整国家职业标准。");
  const afterTitle = text.slice(title.index + title[0].length);
  const section = afterTitle.split(/(?:4\s*[.、]?\s*2\s*)?技能要求权重表/)[0];
  const blocks: string[] = [];
  let blockStart = 0;
  for (const total of section.matchAll(/合计/g)) {
    blocks.push(section.slice(blockStart, total.index));
    const afterTotal = section.slice(total.index! + total[0].length);
    const cells = new RegExp(`^\\s*${cellPattern}(?:\\s+${cellPattern})*`).exec(afterTotal);
    blockStart = total.index! + total[0].length + (cells?.[0].length ?? 0);
  }
  if (!blocks.length) throw new TheoryWeightImportError("理论知识权重表缺少“合计”行，无法核验完整性。");
  const scopes = new Map<string, TheoryWeightScope>();

  for (const block of blocks) {
    const first = new RegExp(`(${cellPattern}(?:\\s+${cellPattern}){4,})(?=\\s|$)`).exec(block);
    if (!first) continue;
    const count = first[1].trim().split(/\s+/).length;
    const header = block.slice(0, first.index);
    const foundDirections = directionMatches(header, occupation.directions);
    const distinct = [...new Map(foundDirections.map((match) => [match.direction.id, match.direction])).values()];
    let columns: WeightColumnHint[];
    if (count === 5 && distinct.length <= 1) {
      if (occupation.directions.length && distinct.length !== 1) {
        throw new TheoryWeightImportError("该职业已设置职业方向，但权重表未标明匹配的方向名称，本次不保存。");
      }
      columns = theoryWeightLevels.map((levelCode) => ({ levelCode, directionName: distinct[0]?.name ?? null }));
    } else {
      const grades = [...header.matchAll(gradePattern)];
      const direct = grades.flatMap<WeightColumnHint>((grade, index) => {
        const names = foundDirections.filter((match) => match.index >= grade.index! + grade[0].length &&
          match.index < (grades[index + 1]?.index ?? header.length));
        const levelCode = levelByGrade[grade[1]];
        return names.length
          ? names.map((match) => ({ levelCode, directionName: match.direction.name }))
          : [{ levelCode, directionName: null }];
      });
      columns = direct.length === count ? direct : [...(columnHints ?? [])];
      if (columns.length !== count || columns.some((column) => column.directionName !== null &&
        !occupation.directions.some((direction) => compact(direction.name) === compact(column.directionName!)))) {
        throw new TheoryWeightImportError(`识别到 ${count} 列权重，无法可靠对应等级和已配置职业方向，本次不保存。`);
      }
    }
    const targetDirections = occupation.directions.length ? occupation.directions.filter((direction) =>
      columns.some((column) => compact(column.directionName ?? "") === compact(direction.name))) : [null];
    if (!targetDirections.length) throw new TheoryWeightImportError("权重表没有匹配的职业方向，请核对方向名称。");
    const rows = readWeightRows(block, count);
    for (const direction of targetDirections) {
      const key = direction?.id ?? "";
      if (scopes.has(key)) throw new TheoryWeightImportError(`“${direction?.name ?? occupation.name}”存在重复权重表，无法确定使用哪个版本。`);
      const items = rows.map((row) => ({
        category: row.category, name: row.name,
        weights: Object.fromEntries(theoryWeightLevels.map((level) => {
          const specific = columns.map((column, index) => ({ ...column, index })).filter((column) =>
            column.levelCode === level && compact(column.directionName ?? "") === compact(direction?.name ?? ""));
          const shared = columns.map((column, index) => ({ ...column, index })).filter((column) =>
            column.levelCode === level && column.directionName === null);
          const candidates = specific.length ? specific : shared;
          if (candidates.length > 1) throw new TheoryWeightImportError("等级和方向列重复，不能可靠匹配权重。");
          return [level, candidates.length ? row.values[candidates[0].index] : null];
        })) as TheoryWeightItem["weights"],
      }));
      validateTheoryWeights(items, direction?.name ?? occupation.name);
      scopes.set(key, {
        directionId: direction?.id ?? null, directionName: direction?.name ?? occupation.name,
        directionCode: direction?.directionCode ?? null, occupationCode: direction?.code ?? occupation.code, items,
      });
    }
  }
  const targets = occupation.directions.length ? occupation.directions : [null];
  const missing = targets.filter((direction) => !scopes.has(direction?.id ?? ""));
  if (missing.length) throw new TheoryWeightImportError(`未匹配到职业方向：${missing.map((direction) => direction?.name ?? occupation.name).join("、")}，本次不保存。`);
  return targets.map((direction) => scopes.get(direction?.id ?? "")!);
}

function readWeightRows(block: string, count: number) {
  const flat = block.replace(/\s+/g, " ").trim();
  const pattern = new RegExp(`(${cellPattern}(?:\\s+${cellPattern}){${count - 1}})(?!\\s+${cellPattern}(?:\\s|$))`, "g");
  const rows: { category: string; name: string; values: (number | null)[] }[] = [];
  let end = 0, category = "未分类";
  for (const match of flat.matchAll(pattern)) {
    const prefix = flat.slice(end, match.index);
    end = match.index! + match[0].length;
    if (/基本要求/.test(prefix)) category = "基本要求";
    if (/相关知识要求/.test(prefix)) category = "相关知识要求";
    const rowPrefix = prefix.replace(/^.*(?:基本要求|相关知识要求)/, "").replace(/^\s*\d+[.、]\s*/, "").trim();
    const name = rows.length || /基本要求|相关知识要求/.test(prefix)
      ? compact(rowPrefix)
      : rowPrefix.split(/\s+/).at(-1) ?? "";
    if (!name || /等级|初级工|中级工|高级工|技师|百分比|权重|合计/.test(name)) continue;
    const values = match[1].split(/\s+/).map((value) => /^(—|--|-)$/.test(value) ? null : Number(value.replace("%", "")));
    if (values.some((value) => value !== null && (value < 0 || value > 100))) throw new TheoryWeightImportError(`“${name}”权重超出 0 至 100%。`);
    rows.push({ category, name, values });
  }
  if (!rows.length || new Set(rows.map((row) => `${row.category}/${row.name}`)).size !== rows.length) {
    throw new TheoryWeightImportError("权重项目为空或名称重复，本次不保存。");
  }
  return rows;
}

export function theoryWeightTotals(items: readonly TheoryWeightItem[]): Record<TheoryWeightLevel, number> {
  return Object.fromEntries(theoryWeightLevels.map((level) => [
    level, items.reduce((total, item) => total + (item.weights[level] ?? 0), 0),
  ])) as Record<TheoryWeightLevel, number>;
}

export function validateTheoryWeights(items: readonly TheoryWeightItem[], label: string) {
  const totals = theoryWeightTotals(items);
  for (const level of theoryWeightLevels) {
    const applicable = items.some((item) => item.weights[level] !== null);
    if (applicable && Math.abs(totals[level] - 100) > 0.0001) {
      throw new TheoryWeightImportError(`${label} ${level} 权重合计为 ${totals[level]}%，不等于 100%，本次不会覆盖已有权重表。`);
    }
  }
  if (!Object.values(totals).some((total) => total > 0)) throw new TheoryWeightImportError("权重表全部为空，本次不保存。");
}

export function parseStandardRequirements(input: string, weights: readonly TheoryWeightScope[]): StandardRequirementScope[] {
  const normalized = normalizeStandardText(input);
  const start = /(?:^|\s)3\s*[.、]?\s*工作要求/.exec(normalized);
  if (!start) throw new TheoryWeightImportError("未找到“3. 工作要求”，无法保存技能要求层级，请上传完整职业标准。");
  const body = normalized.slice(start.index + start[0].length).split(/(?:^|\s)4\s*[.、]?\s*(?:权重表|理论知识权重表|比重表)|4\s*[.、]?\s*1\s*理论知识权重表/)[0];
  const headings = [...body.matchAll(/(?:^|\s)3\.\s*\d+\s+([五四三二一])级\s*\/\s*(?:初级工|中级工|高级工|高级技师|技师)/g)];
  if (!headings.length) throw new TheoryWeightImportError("工作要求未识别到明确的技能等级，本次不保存。");
  const directions = weights.filter((scope) => scope.directionId).map((scope) => ({
    id: scope.directionId!, name: scope.directionName, code: scope.occupationCode, directionCode: scope.directionCode!,
  }));
  const result: StandardRequirementScope[] = [];
  for (const [index, heading] of headings.entries()) {
    const levelCode = levelByGrade[heading[1]];
    const section = body.slice(heading.index! + heading[0].length, headings[index + 1]?.index ?? body.length);
    const matches = directionMatches(section, directions).filter((match) => {
      const after = section.slice(match.end);
      return /^\s*[)）:：]?\s*职业功能/.test(after);
    });
    const grouped = matches.length ? matches.map((match, scopeIndex) => ({
      directionId: match.direction.id, directionName: match.direction.name,
      text: section.slice(match.end, matches[scopeIndex + 1]?.index ?? section.length),
    })) : [{ directionId: null, directionName: "通用", text: section }];
    for (const group of grouped) {
      if (!/职业功能[\s\S]*工作内容[\s\S]*技能要求/.test(group.text)) {
        throw new TheoryWeightImportError(`${levelCode} ${group.directionName} 缺少工作要求表头，无法核验层级。`);
      }
      const functions = parseWorkFunctions(group.text);
      if (!functions.length) throw new TheoryWeightImportError(`${levelCode} ${group.directionName} 未识别到完整的职业功能、工作内容和技能要求。`);
      result.push({ directionId: group.directionId, directionName: group.directionName, levelCode, functions });
    }
  }
  for (const weight of weights) {
    for (const levelCode of theoryWeightLevels.filter((level) => weight.items.some((item) => (item.weights[level] ?? 0) > 0))) {
      if (!result.some((scope) => scope.levelCode === levelCode && (scope.directionId === weight.directionId || scope.directionId === null))) {
        throw new TheoryWeightImportError(`${weight.directionName} ${levelCode} 缺少对应工作要求，本次不保存。`);
      }
    }
  }
  return result;
}

function parseWorkFunctions(input: string): StandardFunction[] {
  const text = input.replace(/\s+(?:\d+\s+)*职业编码\s*[:：][^\n]*/g, "")
    .replace(/续表|职业功能|工作内容|技能要求|相关知识要求/g, " ");
  const tokens = [...text.matchAll(/(?:^|\s)(\d+(?:\.\d+){0,2})\s*[.、]?\s*(?=[★☆*]?\s*[\u4e00-\u9fff])/g)];
  const functions: StandardFunction[] = [];
  let currentFunction: StandardFunction | undefined;
  let currentContent: StandardWorkContent | undefined;
  let knowledgeColumn = false;
  for (const [index, token] of tokens.entries()) {
    const code = token[1];
    const depth = code.split(".").length;
    const evidence = text.slice(token.index! + token[0].length, tokens[index + 1]?.index ?? text.length).trim();
    const name = compact(evidence).replace(/^[★☆*]/, "");
    if (!name) continue;
    if (depth === 1) {
      currentFunction = functions.find((item) => item.code === code);
      if (currentFunction && currentFunction.name !== name) throw new TheoryWeightImportError(`职业功能 ${code} 名称冲突，无法核验原文。`);
      if (!currentFunction) {
        currentFunction = { code, name, contents: [] };
        functions.push(currentFunction);
      }
      currentContent = undefined;
    } else if (depth === 2) {
      if (!currentFunction || code.split(".")[0] !== currentFunction.code) throw new TheoryWeightImportError(`工作内容 ${code} 缺少职业功能父级。`);
      currentContent = currentFunction.contents.find((item) => item.code === code);
      if (currentContent && currentContent.name !== name) throw new TheoryWeightImportError(`工作内容 ${code} 名称冲突。`);
      if (!currentContent) {
        currentContent = { code, name, requirements: [] };
        currentFunction.contents.push(currentContent);
      }
      knowledgeColumn = false;
    } else {
      if (!currentContent) throw new TheoryWeightImportError(`技能要求 ${code} 缺少工作内容父级。`);
      if (currentContent.requirements.some((item) => item.code === code && item.kind === "skill_requirement")) knowledgeColumn = true;
      const kind = knowledgeColumn ? "related_knowledge" : "skill_requirement";
      if (!currentContent.requirements.some((item) => item.code === code && item.kind === kind && item.name === name)) {
        currentContent.requirements.push({ code, name, evidence: `${code} ${evidence}`, kind });
      }
    }
  }
  if (functions.some((item) => !item.contents.length || item.contents.some((content) =>
    !content.requirements.some((requirement) => requirement.kind === "skill_requirement")))) {
    throw new TheoryWeightImportError("工作要求层级不完整，不能可靠保存技能要求。");
  }
  return functions;
}
