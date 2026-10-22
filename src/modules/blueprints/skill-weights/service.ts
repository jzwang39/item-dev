import { createHash } from "node:crypto";

import type { PoolConnection, RowDataPacket } from "mysql2/promise";

import { createUlid } from "@/shared/database/ulid";
import { withTransaction } from "@/shared/database/mysql";

const levels = ["level_5", "level_4", "level_3", "level_2", "level_1"] as const;

type LevelCode = (typeof levels)[number];
type ProjectRow = RowDataPacket & { id: string };
type BlueprintRow = RowDataPacket & { id: string };
type Snapshot = { sourceName: string; items: SkillWeightItem[] };

export type SkillWeightItem = {
  name: string;
  weights: Record<LevelCode, number>;
};

export type SkillWeightSnapshot = Snapshot & {
  versionId: string;
  versionNo: number;
  importedAt: string;
};

export class SkillWeightError extends Error {}

export async function getCurrentSkillWeights(occupationId: string): Promise<SkillWeightSnapshot | null> {
  return withTransaction(async (connection) => {
    const projectId = await getProjectForOccupation(connection, occupationId);
    const [rows] = await connection.execute<(RowDataPacket & {
      id: string;
      version_no: number;
      snapshot_json: Snapshot | string;
      created_at: Date;
    })[]>(
      `SELECT bv.id, bv.version_no, bv.snapshot_json, bv.created_at
         FROM blueprints b
         INNER JOIN blueprint_versions bv ON bv.id = b.current_version_id
        WHERE b.project_id = ? AND b.occupation_id = ?
          AND b.blueprint_kind = 'theory_weight' AND b.assessment_mode = 'skill'
        LIMIT 1`,
      [projectId, occupationId]
    );
    const current = rows[0];
    if (!current) return null;
    const snapshot = typeof current.snapshot_json === "string"
      ? JSON.parse(current.snapshot_json) as Snapshot
      : current.snapshot_json;
    return { ...snapshot, versionId: current.id, versionNo: current.version_no, importedAt: current.created_at.toISOString() };
  });
}

export async function saveSkillWeights(
  occupationId: string,
  items: SkillWeightItem[],
  actorId: string
): Promise<SkillWeightSnapshot> {
  const normalizedItems = items.filter((item) =>
    item.name.trim() || levels.some((level) => item.weights[level] !== 0)
  );
  validateItems(normalizedItems);
  return withTransaction(async (connection) => {
    const projectId = await getProjectForOccupation(connection, occupationId);
    const blueprintId = await getOrCreateSkillWeightBlueprint(connection, projectId, occupationId);
    const [versionRows] = await connection.execute<(RowDataPacket & { version_no: number })[]>(
      "SELECT COALESCE(MAX(version_no), 0) AS version_no FROM blueprint_versions WHERE blueprint_id = ? FOR UPDATE",
      [blueprintId]
    );
    const versionNo = Number(versionRows[0].version_no) + 1;
    const versionId = createUlid();
    const snapshot: Snapshot = { sourceName: "人工维护", items: normalizedItems };

    await connection.execute(
      `INSERT INTO blueprint_versions (
        id, blueprint_id, version_no, status, content_hash, snapshot_json, published_at, created_by
      ) VALUES (?, ?, ?, 'published', ?, ?, UTC_TIMESTAMP(3), ?)`,
      [versionId, blueprintId, versionNo, createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"), JSON.stringify(snapshot), actorId]
    );
    for (const [index, item] of normalizedItems.entries()) {
      await connection.execute(
        `INSERT INTO blueprint_nodes (
          id, blueprint_version_id, parent_id, node_kind, node_code, name, ordinal, weight, requirement_json, source_ref_json
        ) VALUES (?, ?, NULL, 'weight_item', ?, ?, ?, NULL, ?, ?)`,
        [
          createUlid(),
          versionId,
          `skill-weight-${String(index + 1).padStart(3, "0")}`,
          item.name,
          index + 1,
          JSON.stringify({ category: "技能要求", weights: item.weights }),
          JSON.stringify({ sourceName: snapshot.sourceName })
        ]
      );
    }
    await connection.execute(
      "UPDATE blueprints SET current_version_id = ?, status = 'published', row_version = row_version + 1 WHERE id = ?",
      [versionId, blueprintId]
    );
    await connection.execute(
      `INSERT INTO audit_logs (id, project_id, actor_id, action, object_type, object_id, after_json, result)
       VALUES (?, ?, ?, 'blueprint.skill_weight.save', 'blueprint_version', ?, ?, 'success')`,
      [createUlid(), projectId, actorId, versionId, JSON.stringify({ versionNo, itemCount: normalizedItems.length, totals: calculateTotals(normalizedItems) })]
    );
    return { ...snapshot, versionId, versionNo, importedAt: new Date().toISOString() };
  });
}

function validateItems(items: SkillWeightItem[]) {
  if (!items.length || items.length > 20) throw new SkillWeightError("请至少填写一条、最多保留二十条考评范围。");
  const names = new Set<string>();
  for (const item of items) {
    item.name = item.name.trim();
    if (!item.name) throw new SkillWeightError("考评范围不能为空。");
    if (names.has(item.name)) throw new SkillWeightError(`考评范围“${item.name}”重复。`);
    names.add(item.name);
    for (const level of levels) {
      const value = item.weights[level];
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        throw new SkillWeightError("每个等级的权重必须为 0 到 100 之间的数字。");
      }
    }
  }
  const totals = calculateTotals(items);
  for (const level of levels) {
    if (totals[level] !== 0 && Math.abs(totals[level] - 100) > 0.0001) {
      throw new SkillWeightError(`${level} 的权重合计为 ${totals[level]}%，应为 100% 或 0%。`);
    }
  }
}

function calculateTotals(items: SkillWeightItem[]) {
  return Object.fromEntries(levels.map((level) => [
    level,
    items.reduce((total, item) => total + item.weights[level], 0)
  ])) as Record<LevelCode, number>;
}

async function getProjectForOccupation(connection: PoolConnection, occupationId: string) {
  const [rows] = await connection.execute<ProjectRow[]>(
    `SELECT p.id FROM projects p
      INNER JOIN project_occupations po ON po.project_id = p.id
     WHERE po.id = ? AND po.status = 'active' AND p.status = 'active' FOR UPDATE`,
    [occupationId]
  );
  if (!rows[0]) throw new SkillWeightError("职业不存在、已归档或不属于当前启用项目。");
  return rows[0].id;
}

async function getOrCreateSkillWeightBlueprint(connection: PoolConnection, projectId: string, occupationId: string) {
  const [rows] = await connection.execute<BlueprintRow[]>(
    `SELECT id FROM blueprints
      WHERE project_id = ? AND occupation_id = ? AND blueprint_kind = 'theory_weight'
        AND assessment_mode = 'skill' AND level_code = 'level_5'
      LIMIT 1 FOR UPDATE`,
    [projectId, occupationId]
  );
  if (rows[0]) return rows[0].id;
  const id = createUlid();
  await connection.execute(
    `INSERT INTO blueprints (
      id, project_id, name, blueprint_kind, occupation_id, level_code, assessment_mode, status
    ) VALUES (?, ?, '职业技能要求权重表', 'theory_weight', ?, 'level_5', 'skill', 'draft')`,
    [id, projectId, occupationId]
  );
  return id;
}
