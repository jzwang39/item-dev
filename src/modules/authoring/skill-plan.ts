import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import type { Scope } from "./generation/contracts";
import { parseSkillAssessmentRules, type SkillAssessmentRules } from "@/modules/blueprints/skill-standard";

type Version = { id: string; versionNo: number };
type SkillNode = RowDataPacket & {
  id: string; node_code: string; name: string; requirement_json: unknown; source_ref_json: unknown;
};
type StructureScope = {
  column: { direction: string; levelCode: string };
  rows: Array<{ name: string; score: number; minutes?: number | null; method?: string | null; selection?: string | null }>;
  totalMinutes?: number | null;
  assessmentRules?: SkillAssessmentRules;
};
export type SkillStructureBasis = {
  rows?: StructureScope["rows"];
  standardScopes?: StructureScope[];
  totalMinutes?: number | null;
  sourceVersionId?: string;
};
export function decode<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

export function validateSkillStructure(structure: SkillStructureBasis, nodes: Array<{ name: string; requirement_json: unknown }>, level: string) {
  const scopes = structure.standardScopes?.length
    ? structure.standardScopes
    : [{ column: { levelCode: level, direction: "通用" }, rows: structure.rows ?? [], totalMinutes: structure.totalMinutes }];
  if (!scopes.length || scopes.some((scope) => scope.column.levelCode !== level || !scope.rows.length ||
    scope.rows.some((row) => !row.name || !Number.isFinite(row.score) || row.score < 0) ||
    Math.abs(scope.rows.reduce((sum, row) => sum + row.score, 0) - 100) > 0.001)) {
    throw new Error("操作技能内容结构缺失或各方向鉴定比重合计不为100%，请先核对内容结构表。");
  }
  for (const node of nodes) {
    const point = decode<{ direction?: string; level2Name?: string; sourceStandardRequirement?: { functionName: string } }>(node.requirement_json) ?? {};
    const direction = point.direction ?? "通用";
    const functionName = point.sourceStandardRequirement?.functionName ?? point.level2Name;
    const matching = scopes.filter((scope) => scope.column.direction === direction && scope.rows.some((row) => row.name === functionName));
    if (matching.length !== 1) throw new Error(`“${node.name}”无法唯一对应本技能等级和方向的内容结构，请先核对细目表归属。`);
  }
  return scopes;
}

// Read either current versions during confirmation, or the immutable versions of an already frozen plan.
export async function loadSkillPlanBasis(db: PoolConnection, occupationId: string, level: string, frozen?: Scope["blueprintVersions"]) {
  if (!["level_5", "level_4", "level_3"].includes(level)) throw new Error("操作技能命题当前仅处理五级、四级、三级。");
  const rows: Array<RowDataPacket & { id: string; version_no: number; blueprint_kind: string; snapshot_json: unknown }> = [];
  for (const [kind, version] of [
    ["skill_outline", frozen?.outline], ["theory_weight", frozen?.weights], ["skill_structure", frozen?.structure],
  ] as const) {
    if (frozen && !version) throw new Error("历史操作技能计划缺少内容结构版本，请重新生成计划。");
    const [result] = await db.execute<typeof rows>(
      `SELECT v.id,v.version_no,b.blueprint_kind,v.snapshot_json FROM blueprints b
       JOIN blueprint_versions v ON v.blueprint_id=b.id AND v.id=${frozen ? "?" : "b.current_version_id"}
       JOIN project_occupations po ON po.id=b.occupation_id AND po.status='active'
       JOIN projects p ON p.id=b.project_id AND p.id=po.project_id AND p.status='active'
       WHERE b.occupation_id=? AND b.assessment_mode='skill' AND b.blueprint_kind=?
       ${kind === "theory_weight" ? "" : "AND b.level_code=?"} AND v.status<>'archived' FOR UPDATE`,
      [...(frozen ? [version!.id] : []), occupationId, kind, ...(kind === "theory_weight" ? [] : [level])],
    );
    if (result.length !== 1) throw new Error(`当前职业和等级尚无可用的${kind === "skill_outline" ? "操作技能细目表" : kind === "skill_structure" ? "操作技能内容结构表" : "技能要求权重表"}，计划不能确认。`);
    rows.push(result[0]);
  }
  const version = (kind: string): Version => {
    const row = rows.find((item) => item.blueprint_kind === kind)!;
    return { id: row.id, versionNo: Number(row.version_no) };
  };
  const versions = { outline: version("skill_outline"), weights: version("theory_weight"), structure: version("skill_structure") };
  const [nodes] = await db.execute<SkillNode[]>(
    "SELECT id,node_code,name,requirement_json,source_ref_json FROM blueprint_nodes WHERE blueprint_version_id=? AND node_kind='assessment_point' ORDER BY ordinal",
    [versions.outline.id],
  );
  if (!nodes.length) throw new Error("操作技能细目表没有鉴定点，计划不能确认。");
  const weights = decode<{ items: Array<{ weights: Record<string, number | null> }> }>(rows[1].snapshot_json);
  const weightTotal = weights.items.reduce((sum, row) => sum + (row.weights[level] ?? 0), 0);
  if (Math.abs(weightTotal - 100) > 0.001) throw new Error(`技能要求权重合计为${weightTotal}%，应为100%。`);
  const structure = decode<SkillStructureBasis>(rows[2].snapshot_json);
  if (structure.sourceVersionId) {
    const [segments] = await db.execute<(RowDataPacket & { content_excerpt: string })[]>(
      "SELECT content_excerpt FROM source_segments WHERE source_version_id=? ORDER BY ordinal", [structure.sourceVersionId],
    );
    const rules = parseSkillAssessmentRules(segments.map((segment) => segment.content_excerpt).join("\n"));
    // Enrich from the frozen source only; never substitute current administrator settings.
    for (const scope of structure.standardScopes ?? []) {
      scope.assessmentRules ??= rules;
      for (const row of scope.rows) row.method ??= scope.assessmentRules.method;
    }
  }
  const scopes = validateSkillStructure(structure, nodes, level);
  for (const node of nodes) {
    const point = decode<{ standardText?: string; sourceStandardRequirement?: { evidence?: string }; sourceKnowledgePoint?: { evidence?: string } }>(node.requirement_json) ?? {};
    if (!(point.standardText || point.sourceStandardRequirement?.evidence || point.sourceKnowledgePoint?.evidence)?.trim()) {
      throw new Error(`“${node.name}”缺少可核验的标准或教材依据，请先补齐细目表来源。`);
    }
  }
  const needsReview = scopes.some((scope) => !scope.totalMinutes || scope.rows.some((row) => !row.method || !row.minutes || !row.selection));
  return { versions, nodes, structure, weightTotal, needsReview };
}
