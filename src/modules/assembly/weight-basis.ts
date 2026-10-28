import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { baseQuestionType, inventoryKey, rangeTargets, scaleRubric, type WeightRange } from "./weight-policy";

export const decode = <T,>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;
const normalize = (value: string) => value.normalize("NFKC").replace(/^\s*\d+(?:\.\d+)*[.、]?\s*/, "").replace(/\s+/g, "").trim();
type WeightItem = { category?: string; name: string; weights: Record<string, number | null>; columnWeights?: Record<string, number | null> };
type WeightSnapshot = {
  items: WeightItem[];
  scopes?: Array<{ directionId?: string | null; directionName?: string; items?: WeightItem[] }>;
  columns?: Array<{ key: string; levelCode: string; direction: string }>;
};
export type WeightBasis = {
  versionId: string; versionNo: number; direction: string; ranges: WeightRange[];
};

export async function loadWeightBasis(db: PoolConnection, context: {
  project_id: string; occupation_id: string; level_code: string; assessment_mode: string;
}, direction?: string): Promise<WeightBasis> {
  const [rows] = await db.execute<(RowDataPacket & { id: string; version_no: number; snapshot_json: unknown })[]>(
    `SELECT v.id,v.version_no,v.snapshot_json FROM blueprints b JOIN blueprint_versions v ON v.id=b.current_version_id
     WHERE b.project_id=? AND b.occupation_id=? AND b.assessment_mode=? AND b.blueprint_kind='theory_weight'
       AND v.status<>'archived' FOR UPDATE`,
    [context.project_id, context.occupation_id, context.assessment_mode],
  );
  if (rows.length !== 1) throw new Error("缺少唯一的有效权重表，不能严格按权重组卷；请先确认国家职业标准。");
  const snapshot = decode<WeightSnapshot>(rows[0].snapshot_json);
  let scopes: Array<{ direction: string; items: Array<{ category: string; name: string; weight: number }> }>;
  if (context.assessment_mode === "skill" && snapshot.columns?.length) {
    const columns = snapshot.columns.filter((column) => column.levelCode === context.level_code);
    if (columns.length > 1 && snapshot.items.some((item) => !item.columnWeights ||
      columns.some((column) => !(column.key in item.columnWeights!)))) {
      throw new Error("多方向技能权重缺少完整方向列，不能用等级汇总权重替代，请重新确认标准。");
    }
    scopes = columns.map((column) => ({
      direction: column.direction,
      items: snapshot.items.map((item) => ({
        category: "技能要求", name: item.name,
        weight: Number((item.columnWeights && column.key in item.columnWeights
          ? item.columnWeights[column.key] : item.weights[context.level_code]) ?? 0),
      })),
    }));
  } else {
    if ((snapshot.scopes?.length ?? 0) > 1 && snapshot.scopes!.some((scope) => !scope.items)) {
      throw new Error("多方向理论权重缺少方向范围数据，请重新确认标准。");
    }
    scopes = (snapshot.scopes?.length ? snapshot.scopes : [{ directionName: "通用", items: snapshot.items }]).map((scope) => ({
      direction: scope.directionId ? scope.directionName ?? scope.directionId : "通用",
      items: (scope.items ?? snapshot.items).map((item) => ({
        category: item.category ?? (context.assessment_mode === "skill" ? "技能要求" : ""),
        name: item.name, weight: Number(item.weights[context.level_code] ?? 0),
      })),
    }));
  }
  scopes = scopes.filter((scope) => scope.items.some((item) => item.weight > 0));
  const selected = direction ? scopes.filter((scope) => normalize(scope.direction) === normalize(direction)) : scopes;
  if (selected.length !== 1) throw new Error(`无法确定唯一职业方向，请在组卷计划填写权重表方向：${scopes.map((scope) => scope.direction).join("、") || "当前等级不适用"}。`);
  const scope = selected[0];
  if (scope.items.some((item) => item.weight < 0 || !Number.isFinite(item.weight))) throw new Error("权重数值无效。");
  const ranges = scope.items.filter((item) => item.weight > 0).map((item) => ({
    ...item, key: `${normalize(item.category)}:${normalize(item.name)}`,
  }));
  rangeTargets(ranges, 100);
  return { versionId: rows[0].id, versionNo: Number(rows[0].version_no), direction: scope.direction, ranges };
}

export function mapPointRange(point: Record<string, unknown>, basis: WeightBasis, mode: string) {
  const standard = point.sourceStandardRequirement as { functionName?: string; direction?: string; levelCode?: string } | undefined;
  const theoryStandard = point.standardSource as { functionName?: string; directionName?: string } | undefined;
  const basic = point.standardBasicSource as { category?: string; parentName?: string } | undefined;
  const direction = String(point.direction ?? point.directionName ?? standard?.direction ?? theoryStandard?.directionName ?? "通用");
  if (normalize(direction) !== normalize(basis.direction) && normalize(basis.direction) !== "通用" &&
    !(mode === "theory" && point.sectionKind === "basic")) return null;
  if (normalize(basis.direction) === "通用" && normalize(direction) !== "通用") return null;
  const names = mode === "skill"
    ? [standard?.functionName, point.level2Name]
    : [theoryStandard?.functionName, String(point.primaryName ?? "").replace(/^相关知识要求\s*[·:：]\s*/, ""),
      point.secondaryName, basic?.category, basic?.parentName];
  const categories = mode === "skill" ? ["技能要求"] : point.sectionKind === "basic"
    ? ["基本要求"] : point.sectionKind === "related_knowledge" ? ["相关知识要求"] : [];
  const matches = basis.ranges.filter((range) =>
    (!categories.length || categories.some((category) => normalize(category) === normalize(range.category))) &&
    names.some((name) => typeof name === "string" && normalize(name) === normalize(range.name)));
  return matches.length === 1 ? matches[0].key : null;
}

export type WeightedQuestion = {
  id: string; versionId: string; number: string; type: string; stem: string;
  content: unknown; answer: unknown; rubric: unknown; rangeKey: string; nodeIds: string[]; evaluationPoint: string;
};

export async function loadWeightedQuestions(db: PoolConnection, context: {
  project_id: string; occupation_id: string; level_code: string; assessment_mode: string;
}, basis: WeightBasis) {
  const [rows] = await db.execute<(RowDataPacket & {
    id: string; version_id: string; question_no: string; question_type: string; stem: string;
    content_json: unknown; answer_json: unknown; score_rubric_json: unknown; node_id: string | null; node_name: string; requirement_json: unknown;
  })[]>(
    `SELECT q.id,q.current_version_id AS version_id,q.question_no,q.question_type,v.stem,v.content_json,v.answer_json,
      v.score_rubric_json,IF(b.id IS NULL,NULL,n.id) AS node_id,n.name AS node_name,n.requirement_json
     FROM questions q JOIN question_versions v ON v.id=q.current_version_id
     LEFT JOIN question_assessment_points qp ON qp.question_version_id=v.id
     LEFT JOIN blueprint_nodes n ON n.id=qp.blueprint_node_id AND n.node_kind='assessment_point'
     LEFT JOIN blueprint_versions bv ON bv.id=n.blueprint_version_id
     LEFT JOIN blueprints b ON b.id=bv.blueprint_id AND b.project_id=q.project_id AND b.occupation_id=q.occupation_id
       AND b.level_code=q.level_code AND b.assessment_mode=q.assessment_mode
     WHERE q.project_id=? AND q.occupation_id=? AND q.level_code=? AND q.assessment_mode=? AND q.current_status='stored'
     ORDER BY q.id,n.id FOR UPDATE`,
    [context.project_id, context.occupation_id, context.level_code, context.assessment_mode],
  );
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) grouped.set(row.id, [...(grouped.get(row.id) ?? []), row]);
  const questions: WeightedQuestion[] = [];
  let excluded = 0;
  for (const group of grouped.values()) {
    const first = group[0];
    const keys = group.map((row) => row.node_id ? mapPointRange(decode<Record<string, unknown>>(row.requirement_json) ?? {}, basis, context.assessment_mode) : null);
    if (keys.some((key) => !key) || new Set(keys).size !== 1) { excluded++; continue; }
    if (baseQuestionType(first.question_type) === "实操题") {
      try { scaleRubric(first.score_rubric_json, 100); } catch { excluded++; continue; }
    }
    questions.push({
      id: first.id, versionId: first.version_id, number: first.question_no, type: baseQuestionType(first.question_type),
      stem: first.stem, content: decode(first.content_json), answer: decode(first.answer_json), rubric: decode(first.score_rubric_json),
      rangeKey: keys[0]!, nodeIds: group.map((row) => row.node_id!),
      evaluationPoint: [...new Set(group.map((row) => row.node_name).filter(Boolean))].join("、"),
    });
  }
  const inventory: Record<string, number> = {};
  for (const question of questions) {
    const key = inventoryKey(question.rangeKey, question.type);
    inventory[key] = (inventory[key] ?? 0) + 1;
  }
  return { questions, inventory, excluded };
}
