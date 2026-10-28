import type { PoolConnection, RowDataPacket } from "mysql2/promise";

import { createUlid } from "@/shared/database/ulid";
import { query, withTransaction } from "@/shared/database/mysql";
import {
  OccupationOperationError,
  planOccupationDirections,
  toOccupationDirection,
  type OccupationDirection,
  type OccupationDirectionInput,
  type StoredOccupationDirection,
} from "./directions";

export { OccupationOperationError } from "./directions";

type ProjectRow = RowDataPacket & { id: string };
// The generic legal bank is an internal storage/review scope, not an occupation project.
const activeOccupationProjectsSql =
  "SELECT id FROM projects WHERE status = 'active' AND code <> 'SYSTEM-GENERIC-LEGAL' ORDER BY created_at";
type OccupationRow = RowDataPacket & {
  id: string;
  name: string;
  code: string;
  status: "active" | "archived";
};

type DirectionRow = RowDataPacket & StoredOccupationDirection & { occupation_id: string };
type OccupationInput = Readonly<{ name: string; code: string; directions?: OccupationDirectionInput[] }>;
export type Occupation = Pick<OccupationRow, "id" | "name" | "code" | "status"> & {
  directions: OccupationDirection[];
  nextDirectionNumber: number;
};

export async function listActiveOccupations(): Promise<Occupation[]> {
  const projectId = await getActiveProjectId();
  if (!projectId) {
    return [];
  }
  const occupations = await query<OccupationRow[]>(
    `SELECT id, name, code, status
       FROM project_occupations
      WHERE project_id = ? AND status = 'active'
      ORDER BY created_at DESC`,
    [projectId]
  );
  const directions = await query<DirectionRow[]>(
    `SELECT d.id, d.occupation_id, d.name, d.ordinal, d.status
       FROM project_occupation_directions d
       JOIN project_occupations o ON o.id = d.occupation_id
      WHERE o.project_id = ? AND o.status = 'active'
      ORDER BY d.ordinal`,
    [projectId],
  );
  const byOccupation = new Map<string, DirectionRow[]>();
  for (const direction of directions) {
    const items = byOccupation.get(direction.occupation_id) ?? [];
    items.push(direction);
    byOccupation.set(direction.occupation_id, items);
  }
  return occupations.map((occupation) => withDirections(occupation, byOccupation.get(occupation.id) ?? []));
}

export async function createOccupation(
  input: OccupationInput,
  actorId: string
): Promise<Occupation> {
  const name = input.name.trim();
  const code = input.code.trim();

  if (!name || name.length > 200) {
    throw new OccupationOperationError("职业名称须为 1 至 200 个字符。");
  }
  if (!code || code.length > 64) {
    throw new OccupationOperationError("职业代码须为 1 至 64 个字符。");
  }

  return withTransaction(async (connection) => {
    const projectId = await getOrCreateDefaultProject(connection, actorId);
    const occupation: Occupation = { id: createUlid(), name, code, status: "active", directions: [], nextDirectionNumber: 1 };

    try {
      await connection.execute(
        `INSERT INTO project_occupations (id, project_id, code, name, status)
         VALUES (?, ?, ?, ?, 'active')`,
        [occupation.id, projectId, occupation.code, occupation.name]
      );
    } catch (error: unknown) {
      if (isDuplicateError(error)) {
        throw new OccupationOperationError("该职业代码已存在，请检查后重试。");
      }
      throw error;
    }

    const directions = await saveDirections(connection, occupation.id, input.directions ?? [], []);
    const created = withDirections(occupation, directions);
    await connection.execute(
      `INSERT INTO audit_logs (
        id, project_id, actor_id, action, object_type, object_id, after_json, result
      ) VALUES (?, ?, ?, 'occupation.create', 'project_occupation', ?, ?, 'success')`,
      [
        createUlid(),
        projectId,
        actorId,
        occupation.id,
        JSON.stringify(created)
      ]
    );

    return created;
  });
}

export async function updateOccupation(
  occupationId: string,
  input: OccupationInput,
  actorId: string
): Promise<Occupation> {
  const name = input.name.trim();
  const code = input.code.trim();

  if (!name || name.length > 200) {
    throw new OccupationOperationError("职业名称须为 1 至 200 个字符。");
  }
  if (!code || code.length > 64) {
    throw new OccupationOperationError("职业代码须为 1 至 64 个字符。");
  }

  return withTransaction(async (connection) => {
    const projectId = await getActiveProjectIdForUpdate(connection);
    if (!projectId) {
      throw new OccupationOperationError("当前项目不存在，无法修改职业。");
    }

    const [rows] = await connection.execute<OccupationRow[]>(
      `SELECT id, name, code, status
         FROM project_occupations
        WHERE id = ? AND project_id = ? AND status = 'active'
        FOR UPDATE`,
      [occupationId, projectId]
    );
    const existing = rows[0];
    if (!existing) {
      throw new OccupationOperationError("职业不存在或已归档。");
    }
    const [existingDirections] = await connection.execute<DirectionRow[]>(
      `SELECT id, occupation_id, name, ordinal, status
         FROM project_occupation_directions WHERE occupation_id = ? ORDER BY ordinal FOR UPDATE`,
      [occupationId],
    );
    const before = withDirections(existing, existingDirections);

    try {
      await connection.execute(
        `UPDATE project_occupations
            SET name = ?, code = ?, row_version = row_version + 1
          WHERE id = ?`,
        [name, code, occupationId]
      );
    } catch (error: unknown) {
      if (isDuplicateError(error)) {
        throw new OccupationOperationError("该职业代码已存在，请检查后重试。");
      }
      throw error;
    }

    const directions = input.directions === undefined
      ? existingDirections
      : await saveDirections(connection, occupationId, input.directions, existingDirections);
    const updated = withDirections({ id: existing.id, name, code, status: existing.status }, directions);
    await connection.execute(
      `INSERT INTO audit_logs (
        id, project_id, actor_id, action, object_type, object_id, before_json, after_json, result
      ) VALUES (?, ?, ?, 'occupation.update', 'project_occupation', ?, ?, ?, 'success')`,
      [
        createUlid(),
        projectId,
        actorId,
        occupationId,
        JSON.stringify(before),
        JSON.stringify(updated)
      ]
    );

    return updated;
  });
}

function withDirections(
  occupation: Pick<OccupationRow, "id" | "name" | "code" | "status">,
  directions: readonly StoredOccupationDirection[],
): Occupation {
  return {
    id: occupation.id, name: occupation.name, code: occupation.code, status: occupation.status,
    directions: directions.filter((direction) => direction.status === "active")
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((direction) => toOccupationDirection(direction, occupation.code)),
    nextDirectionNumber: Math.max(0, ...directions.map((direction) => direction.ordinal)) + 1,
  };
}

async function saveDirections(
  connection: PoolConnection,
  occupationId: string,
  input: readonly OccupationDirectionInput[],
  existing: readonly StoredOccupationDirection[],
): Promise<StoredOccupationDirection[]> {
  const plan = planOccupationDirections(input, existing);
  try {
    // Temporarily free active names so renames and name swaps are atomic.
    await connection.execute(
      `UPDATE project_occupation_directions SET status = 'archived'
        WHERE occupation_id = ? AND status = 'active'`,
      [occupationId],
    );
    for (const direction of plan.retained) {
      await connection.execute(
        `UPDATE project_occupation_directions
            SET name = ?, status = 'active', row_version = row_version + 1 WHERE id = ? AND occupation_id = ?`,
        [direction.name, direction.id, occupationId],
      );
    }
    const added: StoredOccupationDirection[] = [];
    for (const direction of plan.added) {
      const stored: StoredOccupationDirection = { ...direction, id: createUlid(), status: "active" };
      await connection.execute(
        `INSERT INTO project_occupation_directions (id, occupation_id, ordinal, name)
         VALUES (?, ?, ?, ?)`,
        [stored.id, occupationId, stored.ordinal, stored.name],
      );
      added.push(stored);
    }
    for (const id of plan.archivedIds) {
      await connection.execute(
        `UPDATE project_occupation_directions SET row_version = row_version + 1 WHERE id = ? AND occupation_id = ?`,
        [id, occupationId],
      );
    }
    return [
      ...existing.filter((direction) => direction.status === "archived" || plan.archivedIds.includes(direction.id))
        .map((direction) => ({ ...direction, status: "archived" as const })),
      ...plan.retained,
      ...added,
    ];
  } catch (error) {
    if (isDuplicateError(error)) {
      throw new OccupationOperationError("职业方向名称不能重复。");
    }
    throw error;
  }
}

async function getActiveProjectId(): Promise<string | null> {
  const rows = await query<ProjectRow[]>(
    activeOccupationProjectsSql
  );
  if (rows.length > 1) {
    throw new OccupationOperationError("当前存在多个启用项目，请先选择项目后再维护职业。");
  }
  return rows[0]?.id ?? null;
}

async function getActiveProjectIdForUpdate(connection: PoolConnection): Promise<string | null> {
  const [rows] = await connection.execute<ProjectRow[]>(
    `${activeOccupationProjectsSql} FOR UPDATE`
  );
  if (rows.length > 1) {
    throw new OccupationOperationError("当前存在多个启用项目，请先选择项目后再维护职业。");
  }
  return rows[0]?.id ?? null;
}

async function getOrCreateDefaultProject(
  connection?: PoolConnection,
  actorId?: string
): Promise<string> {
  if (!connection) {
    return withTransaction((transaction) => getOrCreateDefaultProject(transaction));
  }

  const [rows] = await connection.execute<ProjectRow[]>(
    `${activeOccupationProjectsSql} FOR UPDATE`
  );
  if (rows.length === 1) {
    if (actorId) {
      await connection.execute(
        `INSERT INTO project_members (id, project_id, account_id, status)
         VALUES (?, ?, ?, 'active')
         ON DUPLICATE KEY UPDATE status = 'active', row_version = row_version + 1`,
        [createUlid(), rows[0].id, actorId]
      );
    }
    return rows[0].id;
  }
  if (rows.length > 1) {
    throw new OccupationOperationError("当前存在多个启用项目，请先选择项目后再维护职业。");
  }

  const projectId = createUlid();
  await connection.execute(
    `INSERT INTO projects (id, code, name, status, created_by, updated_by)
     VALUES (?, 'default-authoring', '默认命题项目', 'active', ?, ?)`,
    [projectId, actorId ?? null, actorId ?? null]
  );
  if (actorId) {
    await connection.execute(
      "INSERT INTO project_members (id, project_id, account_id, status) VALUES (?, ?, ?, 'active')",
      [createUlid(), projectId, actorId]
    );
  }

  return projectId;
}

function isDuplicateError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ER_DUP_ENTRY";
}
