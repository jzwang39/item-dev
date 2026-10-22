import { createHash } from "node:crypto";

import type { PoolConnection, RowDataPacket } from "mysql2/promise";

import { createUlid } from "@/shared/database/ulid";
import { withTransaction } from "@/shared/database/mysql";

const levels = ["level_5", "level_4", "level_3", "level_2", "level_1"] as const;
type LevelCode = (typeof levels)[number];
type ProjectRow = RowDataPacket & { id: string };
type BlueprintRow = RowDataPacket & { id: string };

export type SkillStructureRow = {
  code: string;
  name: string;
  selection: "required" | "optional";
  score: number;
  minutes: number;
  method: string;
};
export type SkillStructureSnapshot = {
  versionId: string;
  versionNo: number;
  name: string;
  levelCode: LevelCode;
  ruleBasis: string;
  pathway: string;
  totalMinutes: number;
  rows: SkillStructureRow[];
  importedAt: string;
};
type StoredSnapshot = Omit<SkillStructureSnapshot, "versionId" | "versionNo" | "importedAt">;

export class SkillStructureError extends Error {}

export async function getCurrentSkillStructure(occupationId: string, levelCode: string) {
  const level = validateLevel(levelCode);
  return withTransaction(async (connection) => {
    const projectId = await getProjectForOccupation(connection, occupationId);
    const [rows] = await connection.execute<(RowDataPacket & { id: string; version_no: number; snapshot_json: StoredSnapshot | string; created_at: Date })[]>(
      `SELECT bv.id, bv.version_no, bv.snapshot_json, bv.created_at FROM blueprints b
       INNER JOIN blueprint_versions bv ON bv.id = b.current_version_id
       WHERE b.project_id = ? AND b.occupation_id = ? AND b.level_code = ?
         AND b.blueprint_kind = 'skill_structure' AND b.assessment_mode = 'skill' LIMIT 1`,
      [projectId, occupationId, level]
    );
    const current = rows[0];
    if (!current) return null;
    const snapshot = typeof current.snapshot_json === "string" ? JSON.parse(current.snapshot_json) as StoredSnapshot : current.snapshot_json;
    return { ...snapshot, versionId: current.id, versionNo: current.version_no, importedAt: current.created_at.toISOString() };
  });
}

export async function saveSkillStructure(
  occupationId: string,
  input: Omit<StoredSnapshot, "levelCode"> & { levelCode: string },
  actorId: string
) {
  const level = validateLevel(input.levelCode);
  validateInput(input);
  return withTransaction(async (connection) => {
    const projectId = await getProjectForOccupation(connection, occupationId);
    const blueprintId = await getOrCreateBlueprint(connection, projectId, occupationId, level);
    const [versions] = await connection.execute<(RowDataPacket & { version_no: number })[]>(
      "SELECT COALESCE(MAX(version_no), 0) AS version_no FROM blueprint_versions WHERE blueprint_id = ? FOR UPDATE", [blueprintId]
    );
    const versionNo = Number(versions[0].version_no) + 1;
    const versionId = createUlid();
    const snapshot: StoredSnapshot = { ...input, levelCode: level };
    await connection.execute(
      `INSERT INTO blueprint_versions (id, blueprint_id, version_no, status, content_hash, snapshot_json, published_at, created_by)
       VALUES (?, ?, ?, 'published', ?, ?, UTC_TIMESTAMP(3), ?)`,
      [versionId, blueprintId, versionNo, createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"), JSON.stringify(snapshot), actorId]
    );
    for (const [index, row] of input.rows.entries()) {
      await connection.execute(
        `INSERT INTO blueprint_nodes (id, blueprint_version_id, parent_id, node_kind, node_code, name, ordinal, weight, requirement_json, source_ref_json)
         VALUES (?, ?, NULL, 'structure_item', ?, ?, ?, ?, ?, ?)`,
        [createUlid(), versionId, row.code, row.name, index + 1, row.score, JSON.stringify({ selection: row.selection, minutes: row.minutes, method: row.method }), JSON.stringify({ ruleBasis: input.ruleBasis })]
      );
    }
    await connection.execute("UPDATE blueprints SET current_version_id = ?, status = 'published', row_version = row_version + 1 WHERE id = ?", [versionId, blueprintId]);
    await connection.execute(
      `INSERT INTO audit_logs (id, project_id, actor_id, action, object_type, object_id, after_json, result)
       VALUES (?, ?, ?, 'blueprint.skill_structure.save', 'blueprint_version', ?, ?, 'success')`,
      [createUlid(), projectId, actorId, versionId, JSON.stringify({ versionNo, levelCode: level, name: input.name, rowCount: input.rows.length }),]
    );
    return { ...snapshot, versionId, versionNo, importedAt: new Date().toISOString() };
  });
}

function validateInput(input: Omit<StoredSnapshot, "levelCode"> & { levelCode: string }) {
  if (!input.name.trim()) throw new SkillStructureError("请填写结构名称。");
  if (!input.ruleBasis.trim() || !input.pathway.trim()) throw new SkillStructureError("请填写规则依据和技能考核路径。");
  if (!Number.isFinite(input.totalMinutes) || input.totalMinutes <= 0) throw new SkillStructureError("考试时间必须大于 0。");
  if (!input.rows.length) throw new SkillStructureError("请至少保留一个考评范围。");
  const codes = new Set<string>();
  let score = 0;
  let minutes = 0;
  for (const row of input.rows) {
    if (!row.code || !row.name || !row.method || !Number.isFinite(row.score) || row.score < 0 || !Number.isFinite(row.minutes) || row.minutes < 0) throw new SkillStructureError("请完整填写每个考评范围的结构信息。");
    if (codes.has(row.code)) throw new SkillStructureError("考评范围代码不能重复。");
    codes.add(row.code); score += row.score; minutes += row.minutes;
  }
  if (Math.abs(score - 100) > 0.0001) throw new SkillStructureError(`鉴定比重合计为 ${score}%，应为 100%。`);
  if (minutes !== input.totalMinutes) throw new SkillStructureError(`各范围考试时间合计为 ${minutes} 分钟，应等于总考试时间 ${input.totalMinutes} 分钟。`);
}

function validateLevel(value: string): LevelCode {
  if (!levels.includes(value as LevelCode)) throw new SkillStructureError("技能等级无效。");
  return value as LevelCode;
}
async function getProjectForOccupation(connection: PoolConnection, occupationId: string) {
  const [rows] = await connection.execute<ProjectRow[]>(`SELECT p.id FROM projects p INNER JOIN project_occupations po ON po.project_id = p.id WHERE po.id = ? AND po.status = 'active' AND p.status = 'active' FOR UPDATE`, [occupationId]);
  if (!rows[0]) throw new SkillStructureError("职业不存在、已归档或不属于当前启用项目。");
  return rows[0].id;
}
async function getOrCreateBlueprint(connection: PoolConnection, projectId: string, occupationId: string, level: LevelCode) {
  const [rows] = await connection.execute<BlueprintRow[]>(`SELECT id FROM blueprints WHERE project_id = ? AND occupation_id = ? AND level_code = ? AND blueprint_kind = 'skill_structure' AND assessment_mode = 'skill' LIMIT 1 FOR UPDATE`, [projectId, occupationId, level]);
  if (rows[0]) return rows[0].id;
  const id = createUlid();
  await connection.execute(`INSERT INTO blueprints (id, project_id, name, blueprint_kind, occupation_id, level_code, assessment_mode, status) VALUES (?, ?, '操作技能考评内容结构表', 'skill_structure', ?, ?, 'skill', 'draft')`, [id, projectId, occupationId, level]);
  return id;
}
