import type { PoolConnection, RowDataPacket } from "mysql2/promise";

import { createUlid } from "@/shared/database/ulid";
import { query, withTransaction } from "@/shared/database/mysql";

type ProjectRow = RowDataPacket & { id: string };
type OccupationRow = RowDataPacket & {
  id: string;
  name: string;
  code: string;
  status: "active" | "archived";
};

export type Occupation = Pick<OccupationRow, "id" | "name" | "code" | "status">;

export class OccupationOperationError extends Error {}

export async function listActiveOccupations(): Promise<Occupation[]> {
  const projectId = await getActiveProjectId();
  if (!projectId) {
    return [];
  }
  return query<OccupationRow[]>(
    `SELECT id, name, code, status
       FROM project_occupations
      WHERE project_id = ? AND status = 'active'
      ORDER BY created_at DESC`,
    [projectId]
  );
}

export async function createOccupation(
  input: Readonly<{ name: string; code: string }>,
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
    const occupation: Occupation = { id: createUlid(), name, code, status: "active" };

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

    await connection.execute(
      `INSERT INTO audit_logs (
        id, project_id, actor_id, action, object_type, object_id, after_json, result
      ) VALUES (?, ?, ?, 'occupation.create', 'project_occupation', ?, ?, 'success')`,
      [
        createUlid(),
        projectId,
        actorId,
        occupation.id,
        JSON.stringify({ name: occupation.name, code: occupation.code, status: occupation.status })
      ]
    );

    return occupation;
  });
}

export async function updateOccupation(
  occupationId: string,
  input: Readonly<{ name: string; code: string }>,
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

    const updated: Occupation = { id: existing.id, name, code, status: existing.status };
    await connection.execute(
      `INSERT INTO audit_logs (
        id, project_id, actor_id, action, object_type, object_id, before_json, after_json, result
      ) VALUES (?, ?, ?, 'occupation.update', 'project_occupation', ?, ?, ?, 'success')`,
      [
        createUlid(),
        projectId,
        actorId,
        occupationId,
        JSON.stringify({ name: existing.name, code: existing.code, status: existing.status }),
        JSON.stringify({ name: updated.name, code: updated.code, status: updated.status })
      ]
    );

    return updated;
  });
}

async function getActiveProjectId(): Promise<string | null> {
  const rows = await query<ProjectRow[]>(
    "SELECT id FROM projects WHERE status = 'active' ORDER BY created_at"
  );
  if (rows.length > 1) {
    throw new OccupationOperationError("当前存在多个启用项目，请先选择项目后再维护职业。");
  }
  return rows[0]?.id ?? null;
}

async function getActiveProjectIdForUpdate(connection: PoolConnection): Promise<string | null> {
  const [rows] = await connection.execute<ProjectRow[]>(
    "SELECT id FROM projects WHERE status = 'active' ORDER BY created_at FOR UPDATE"
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
    "SELECT id FROM projects WHERE status = 'active' ORDER BY created_at FOR UPDATE"
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
