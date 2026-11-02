import { createHash } from "node:crypto";
import { z } from "zod";
import type { QuotaPoint } from "./generation/contracts";

export const commonLevels = ["level_5", "level_4", "level_3"] as const;
export const decodeCommon = <T,>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value ?? {}) as T;
export type CommonNode = { id: string; node_code: string; name: string; requirement_json: unknown; source_ref_json: unknown };
export function basicIdentity(node: Pick<CommonNode, "requirement_json" | "source_ref_json" | "name">) {
  const point = decodeCommon<{ sectionKind?: string; primaryName?: string; sharedPointKey?: string }>(node.requirement_json);
  const source = decodeCommon<{ sharedPointKey?: string; chapterIds?: string[]; standardBasic?: unknown }>(node.source_ref_json);
  const basic = point.sectionKind === "basic" || point.primaryName === "基本要求";
  if (!basic) return null;
  const key = point.sharedPointKey ?? source.sharedPointKey;
  if (!key) throw new Error(`基本要求“${node.name}”缺少共用标识，请核对或重新确认细目表，不能按名称猜测对应关系。`);
  return { key: createHash("sha256").update(key).digest("hex"), sharedPointKey: key,
    signature: createHash("sha256").update(JSON.stringify({
      name: node.name.normalize("NFKC").trim(), chapters: [...(source.chapterIds ?? [])].sort(), standardBasic: source.standardBasic ?? null,
    })).digest("hex") };
}
export type CommonPoint = { key: string; sharedPointKey: string; signature: string; name: string;
  nodes: Record<string, { id: string; code: string }> };
export function matchCommonPoints(levelNodes: Record<string, CommonNode[]>): CommonPoint[] {
  const all = commonLevels.map((level) => (levelNodes[level] ?? []).flatMap((node) => {
    const identity = basicIdentity(node);
    return identity ? [{ ...identity, node }] : [];
  }));
  if (!all[0].length) throw new Error("未找到可共用的基本要求考评点。");
  for (const rows of all) {
    if (rows.length !== all[0].length || new Set(rows.map((row) => row.key)).size !== rows.length) {
      throw new Error("五四三级基本要求考评点数量不一致或标识重复，请先核对细目表。");
    }
  }
  return all[0].map((row) => {
    const matches = all.map((rows) => rows.find((other) => other.key === row.key));
    if (matches.some((other) => !other || other.signature !== row.signature)) {
      throw new Error(`基本要求“${row.node.name}”在五四三级的来源或内容不一致，不能共用。`);
    }
    return { key: row.key, sharedPointKey: row.sharedPointKey, signature: row.signature, name: row.node.name,
      nodes: Object.fromEntries(commonLevels.map((level, index) => [level, { id: matches[index]!.node.id, code: matches[index]!.node.node_code }])) };
  });
}
export const commonQuotaSchema = z.array(z.object({
  key: z.string().length(64), single: z.number().int().min(0).max(100),
  multiple: z.number().int().min(0).max(100), judgement: z.literal(0).default(0),
}).refine((point) => point.single + point.multiple + point.judgement > 0, "每个公共考评点至少配置1题。")).min(1);
// Historical snapshots can still contain judgement quotas; only new writes
// are restricted by the schema above.
export type CommonQuota = Array<{ key: string; single: number; multiple: number; judgement: number }>;
export function validateCommonQuota(points: CommonPoint[], value: unknown): CommonQuota {
  const quota = commonQuotaSchema.parse(value);
  if (quota.length !== points.length || new Set(quota.map((point) => point.key)).size !== quota.length
    || quota.some((point) => !points.some((item) => item.key === point.key))) throw new Error("公共配额须逐考评点完整配置且不能重复。");
  return quota;
}
export function commonQuotaPoints(points: CommonPoint[], quota: CommonQuota, level: string): QuotaPoint[] {
  return points.map((point) => {
    const counts = quota.find((item) => item.key === point.key)!;
    return { code: point.nodes[level].code, name: point.name, single: counts.single, multiple: counts.multiple,
      judgement: counts.judgement, total: counts.single + counts.multiple + counts.judgement };
  });
}
export function commonQuestionType(type: string) {
  return /单.*选/.test(type) ? "single" : /多.*选/.test(type) ? "multiple" : /判断/.test(type) ? "judgement" : null;
}
export function commonCoverage(quota: CommonQuota, members: Array<{ point_key: string; question_type: string }>) {
  return quota.flatMap((point) => (["single", "multiple", "judgement"] as const).map((type) => ({
    key: point.key, type, target: point[type],
    count: members.filter((item) => item.point_key === point.key && commonQuestionType(item.question_type) === type).length,
  })));
}

// This condition excludes old independent basic questions only after public
// publication. Historical plans/papers continue to read their original rows.
export function legacyBasicExclusion(alias = "q") {
  return `NOT (${alias}.assessment_mode='theory' AND ${alias}.level_code IN ('level_5','level_4','level_3')
    AND EXISTS (SELECT 1 FROM common_question_groups cg WHERE cg.occupation_id=${alias}.occupation_id AND cg.current_release_id IS NOT NULL)
    AND EXISTS (SELECT 1 FROM question_assessment_points cap JOIN blueprint_nodes cbn ON cbn.id=cap.blueprint_node_id
      WHERE cap.question_version_id=${alias}.current_version_id
      AND (JSON_UNQUOTE(JSON_EXTRACT(cbn.requirement_json,'$.sectionKind'))='basic'
        OR JSON_UNQUOTE(JSON_EXTRACT(cbn.requirement_json,'$.primaryName'))='基本要求')))`;
}

export const formalQuestionSource = `(SELECT q.id,q.project_id,q.question_no,q.occupation_id,q.level_code,q.assessment_mode,
  q.question_type,q.current_version_id,q.current_status,q.difficulty,q.archived_at,q.row_version,q.created_at,q.updated_at,
  NULL AS common_group_id,NULL AS common_release_id,NULL AS blueprint_node_id
  FROM questions q WHERE NOT EXISTS(SELECT 1 FROM common_question_members cm WHERE cm.question_id=q.id)
    AND ${legacyBasicExclusion("q")}
  UNION ALL SELECT * FROM common_published_questions)`;

export function commonEditorialLevelFilter(alias = "q") {
  return `(${alias}.level_code=? OR (${alias}.level_code IS NULL AND ${alias}.assessment_mode='theory'
    AND EXISTS(SELECT 1 FROM common_question_members cm JOIN common_question_points cp ON cp.group_id=cm.group_id
      AND cp.point_key=cm.point_key WHERE cm.question_id=${alias}.id AND cp.level_code=?)))`;
}
