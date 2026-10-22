import { createHash } from "node:crypto";

import type { PoolConnection, RowDataPacket } from "mysql2/promise";

import { withTransaction } from "@/shared/database/mysql";
import { createUlid } from "@/shared/database/ulid";

const levels = ["level_5", "level_4", "level_3", "level_2", "level_1"] as const;
type LevelCode = (typeof levels)[number];

export type SkillAssessmentPoint = {
  code: string; name: string; range: string; weight: number; importance: "low" | "medium" | "high" | "critical";
  level1Code: string; level1Name: string; level2Code: string; level2Name: string; level3Code: string; level3Name: string;
  ordinal: number; abilityLevel: string; targetCount: number; selection: string; method: string; minutes: number;
  standardText: string; citation: string; knowledgeMaterial: string; knowledgePoints: string;
};
export class SkillOutlineError extends Error {}

export async function getCurrentSkillAssessmentPoints(occupationId: string, levelCode: string) {
  const level = validateLevel(levelCode);
  return withTransaction(async (connection) => {
    const projectId = await getProject(connection, occupationId);
    const [rows] = await connection.execute<(RowDataPacket & { current_version_id: string | null })[]>(
      `SELECT current_version_id FROM blueprints
       WHERE project_id = ? AND occupation_id = ? AND level_code = ?
         AND blueprint_kind = 'skill_outline' AND assessment_mode = 'skill'
       LIMIT 1`,
      [projectId, occupationId, level]
    );
    const versionId = rows[0]?.current_version_id;
    return versionId ? readPoints(connection, versionId) : [];
  });
}

export async function saveSkillAssessmentPoint(occupationId: string, levelCode: string, point: SkillAssessmentPoint, actorId: string) {
  const level = validateLevel(levelCode);
  validate(point);
  return withTransaction(async (connection) => {
    const projectId = await getProject(connection, occupationId);
    const blueprintId = await getBlueprint(connection, projectId, occupationId, level);
    const [currentRows] = await connection.execute<(RowDataPacket & { current_version_id: string | null })[]>("SELECT current_version_id FROM blueprints WHERE id = ? FOR UPDATE", [blueprintId]);
    const previousId = currentRows[0]?.current_version_id;
    const existing = previousId ? await readPoints(connection, previousId) : [];
    if (existing.some((item) => item.code === point.code)) throw new SkillOutlineError("该考评点代码已存在，请调整层级代码或序号。");
    const points = [...existing, point];
    const [versionRows] = await connection.execute<(RowDataPacket & { version_no: number })[]>("SELECT COALESCE(MAX(version_no), 0) AS version_no FROM blueprint_versions WHERE blueprint_id = ? FOR UPDATE", [blueprintId]);
    const versionId = createUlid();
    const versionNo = Number(versionRows[0].version_no) + 1;
    await connection.execute(`INSERT INTO blueprint_versions (id, blueprint_id, version_no, status, content_hash, snapshot_json, published_at, created_by) VALUES (?, ?, ?, 'published', ?, ?, UTC_TIMESTAMP(3), ?)`, [versionId, blueprintId, versionNo, createHash("sha256").update(JSON.stringify(points)).digest("hex"), JSON.stringify({ levelCode: level, points }), actorId]);
    for (const [index, item] of points.entries()) await insertPoint(connection, versionId, item, index + 1);
    await connection.execute("UPDATE blueprints SET current_version_id = ?, status = 'published', row_version = row_version + 1 WHERE id = ?", [versionId, blueprintId]);
    await connection.execute(`INSERT INTO audit_logs (id, project_id, actor_id, action, object_type, object_id, after_json, result) VALUES (?, ?, ?, 'blueprint.skill_outline.add_point', 'blueprint_version', ?, ?, 'success')`, [createUlid(), projectId, actorId, versionId, JSON.stringify({ versionNo, code: point.code, name: point.name }),]);
    return { point, versionId, versionNo };
  });
}

export async function updateSkillAssessmentPoint(occupationId: string, levelCode: string, originalCode: string, point: SkillAssessmentPoint, actorId: string) {
  const level = validateLevel(levelCode);
  validate(point);
  return withTransaction(async (connection) => {
    const projectId = await getProject(connection, occupationId);
    const blueprintId = await getBlueprint(connection, projectId, occupationId, level);
    const [currentRows] = await connection.execute<(RowDataPacket & { current_version_id: string | null })[]>("SELECT current_version_id FROM blueprints WHERE id = ? FOR UPDATE", [blueprintId]);
    const previousId = currentRows[0]?.current_version_id;
    const existing = previousId ? await readPoints(connection, previousId) : [];
    if (!existing.some((item) => item.code === originalCode)) throw new SkillOutlineError("待编辑的考评点不存在或已被更新。");
    if (point.code !== originalCode && existing.some((item) => item.code === point.code)) throw new SkillOutlineError("修改后的考评点代码已存在。");
    const points = existing.map((item) => item.code === originalCode ? point : item);
    const [versionRows] = await connection.execute<(RowDataPacket & { version_no: number })[]>("SELECT COALESCE(MAX(version_no), 0) AS version_no FROM blueprint_versions WHERE blueprint_id = ? FOR UPDATE", [blueprintId]);
    const versionId = createUlid();
    const versionNo = Number(versionRows[0].version_no) + 1;
    await connection.execute(`INSERT INTO blueprint_versions (id, blueprint_id, version_no, status, content_hash, snapshot_json, published_at, created_by) VALUES (?, ?, ?, 'published', ?, ?, UTC_TIMESTAMP(3), ?)`, [versionId, blueprintId, versionNo, createHash("sha256").update(JSON.stringify(points)).digest("hex"), JSON.stringify({ levelCode: level, points }), actorId]);
    for (const [index, item] of points.entries()) await insertPoint(connection, versionId, item, index + 1);
    await connection.execute("UPDATE blueprints SET current_version_id = ?, status = 'published', row_version = row_version + 1 WHERE id = ?", [versionId, blueprintId]);
    await connection.execute(`INSERT INTO audit_logs (id, project_id, actor_id, action, object_type, object_id, after_json, result) VALUES (?, ?, ?, 'blueprint.skill_outline.update_point', 'blueprint_version', ?, ?, 'success')`, [createUlid(), projectId, actorId, versionId, JSON.stringify({ versionNo, originalCode, code: point.code, name: point.name }),]);
    return { point, versionId, versionNo };
  });
}

function validate(point: SkillAssessmentPoint) {
  if (!point.name.trim() || !point.level1Name.trim() || !point.level2Name.trim() || !point.level3Name.trim()) throw new SkillOutlineError("请填写考评点名称及三级职业功能名称。");
  if (![point.level1Code, point.level2Code, point.level3Code].every((code) => /^[A-Za-z0-9-]+$/.test(code))) throw new SkillOutlineError("三级代码仅支持字母、数字和连字符。");
  if (!Number.isInteger(point.ordinal) || point.ordinal < 1 || !Number.isFinite(point.weight) || point.weight < 0 || !Number.isInteger(point.minutes) || point.minutes < 0) throw new SkillOutlineError("请检查考评点序号、权重和考核时间。");
}
function validateLevel(value: string): LevelCode { if (!levels.includes(value as LevelCode)) throw new SkillOutlineError("技能等级无效。"); return value as LevelCode; }
async function getProject(connection: PoolConnection, occupationId: string) {
  const [rows] = await connection.execute<(RowDataPacket & { id: string })[]>(`SELECT p.id FROM projects p INNER JOIN project_occupations po ON po.project_id = p.id WHERE po.id = ? AND po.status = 'active' AND p.status = 'active' FOR UPDATE`, [occupationId]);
  if (!rows[0]) throw new SkillOutlineError("职业不存在或已归档。"); return rows[0].id;
}
async function getBlueprint(connection: PoolConnection, projectId: string, occupationId: string, level: LevelCode) {
  const [rows] = await connection.execute<(RowDataPacket & { id: string })[]>(`SELECT id FROM blueprints WHERE project_id = ? AND occupation_id = ? AND level_code = ? AND blueprint_kind = 'skill_outline' AND assessment_mode = 'skill' LIMIT 1 FOR UPDATE`, [projectId, occupationId, level]);
  if (rows[0]) return rows[0].id;
  const id = createUlid();
  await connection.execute(`INSERT INTO blueprints (id, project_id, name, blueprint_kind, occupation_id, level_code, assessment_mode) VALUES (?, ?, '操作技能考评要素细目表', 'skill_outline', ?, ?, 'skill')`, [id, projectId, occupationId, level]);
  return id;
}
async function readPoints(connection: PoolConnection, versionId: string) {
  const [rows] = await connection.execute<(RowDataPacket & { node_code: string; name: string; weight: number; importance: SkillAssessmentPoint["importance"]; requirement_json: SkillAssessmentPoint | string })[]>("SELECT node_code, name, weight, importance, requirement_json FROM blueprint_nodes WHERE blueprint_version_id = ? AND node_kind = 'assessment_point' ORDER BY ordinal", [versionId]);
  return rows.map((row) => ({ ...(typeof row.requirement_json === "string" ? JSON.parse(row.requirement_json) : row.requirement_json), code: row.node_code, name: row.name, weight: Number(row.weight), importance: row.importance }));
}
async function insertPoint(connection: PoolConnection, versionId: string, point: SkillAssessmentPoint, ordinal: number) {
  await connection.execute(`INSERT INTO blueprint_nodes (id, blueprint_version_id, node_kind, node_code, name, ordinal, weight, importance, requirement_json) VALUES (?, ?, 'assessment_point', ?, ?, ?, ?, ?, ?)`, [createUlid(), versionId, point.code, point.name, ordinal, point.weight, point.importance, JSON.stringify(point)]);
}
