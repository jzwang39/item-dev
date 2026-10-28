import { normalizeStandardText } from "../theory-weights/standard";

export type StandardBasicItem = {
  code: string;
  name: string;
  category: string;
  parentName: string;
  evidence: string;
};

export type StandardBasicSource = StandardBasicItem & {
  blueprintVersionId: string;
  fileObjectId: string;
  sourceVersionId: string | null;
};

const basicNames = new Set(["基本要求", "基本知识", "基本信息", "基础知识"]);

export function parseStandardBasicItems(input: string): StandardBasicItem[] {
  let text = normalizeStandardText(input)
    .replace(/\s+(?:\d+\s+)*职\s*业\s*编\s*码\s*[:：][^\n]*/g, "\n");
  for (const name of basicNames) text = text.replace(new RegExp([...name].join("\\s*"), "g"), name);
  const boundary = /(?:^|\s)\d+\s*[.、]?\s*(?:工作要求|理论知识权重表|技能要求权重表)/.exec(text);
  const body = boundary ? text.slice(0, boundary.index) : text;
  const tokens = [...body.matchAll(/(?:^|\s)(\d+(?:\.\d+){0,5})\s*[.、]?\s*(?=[\u4e00-\u9fff])/g)];
  const headings = tokens.map((token, index) => {
    const evidence = body.slice(token.index! + token[0].length, tokens[index + 1]?.index ?? body.length).trim();
    const name = evidence.split(/[（(]\s*\d+\s*[）)]|\n\s*\n/)[0].replace(/\s+/g, "").trim();
    return { code: token[1], depth: token[1].split(".").length, name, evidence };
  });
  const roots = headings.filter((heading) => basicNames.has(heading.name) &&
    !headings.some((parent) => basicNames.has(parent.name) && heading.code.startsWith(`${parent.code}.`)));
  const result: StandardBasicItem[] = [];
  for (const root of roots) {
    const start = headings.indexOf(root);
    let end = start + 1;
    while (end < headings.length && headings[end].depth > root.depth) end += 1;
    const children = headings.slice(start + 1, end);
    if (!children.length) throw new Error(`标准“${root.name}”未识别到编号条目，请核对上传文件。`);
    for (const [index, item] of children.entries()) {
      if (!item.code.startsWith(`${root.code}.`) || !item.name) throw new Error("标准基本条目层级不完整，无法可靠提取。");
      // Only numbered leaf headings are counted. Parent headings and (1)/(2) body lists are evidence.
      if (children.slice(index + 1).some((child) => child.code.startsWith(`${item.code}.`))) continue;
      const parentCode = item.code.split(".").slice(0, -1).join(".");
      const parent = headings.slice(start, end).find((heading) => heading.code === parentCode);
      if (!parent) throw new Error(`基本条目${item.code}缺少父级名称。`);
      result.push({
        code: item.code, name: item.name, category: root.name, parentName: parent.name,
        evidence: `${item.code} ${item.evidence}`,
      });
    }
  }
  if (!result.length) throw new Error("职业标准未提取到基本要求／基本知识／基本信息／基础知识编号条目，请上传完整标准。");
  if (new Set(result.map((item) => item.code)).size !== result.length) throw new Error("职业标准公共基本条目编号重复，无法确定依据。");
  return result;
}
