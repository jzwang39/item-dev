import type { PoolConnection, RowDataPacket } from "mysql2/promise";

import { withTransaction } from "@/shared/database/mysql";
import { createUlid } from "@/shared/database/ulid";
import { hashPassword, verifyPassword } from "@/modules/auth/passwords";

type CountRow = RowDataPacket & { total: number };
type AccountRow = RowDataPacket & {
  id: string;
  username: string;
  display_name: string;
  phone: string | null;
  email: string | null;
  role: "admin" | "expert";
  status: "active" | "disabled" | "deleted";
};
type AccountListRow = RowDataPacket & {
  id: string;
  username: string;
  display_name: string;
  role: "admin" | "expert";
  phone: string | null;
  email: string | null;
  status: "active" | "disabled" | "deleted";
  created_at: Date;
};

export class AccountDeletionBlockedError extends Error {}
export class AccountOperationError extends Error {}

export type AccountUpdateInput = Readonly<{
  displayName: string;
  phone?: string;
  email?: string;
  status: "active" | "disabled";
}>;

export async function listAccounts(): Promise<AccountListRow[]> {
  const { query } = await import("@/shared/database/mysql");
  return query<AccountListRow[]>(
    `SELECT id, username, display_name, role, phone, email, status, created_at
       FROM accounts
      WHERE deleted_at IS NULL
      ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, created_at DESC`
  );
}

export async function createExpertAccount(
  input: Readonly<{
    username: string;
    displayName: string;
    password: string;
    phone?: string;
    email?: string;
  }>,
  actorId: string
): Promise<void> {
  if (!/^[a-zA-Z0-9_.-]{3,64}$/.test(input.username)) {
    throw new AccountOperationError("账号须为 3 至 64 位字母、数字或 . _ -。");
  }
  if (input.displayName.trim().length < 1 || input.displayName.trim().length > 128) {
    throw new AccountOperationError("请输入 1 至 128 个字符的姓名。");
  }
  if (input.password.length < 8 || input.password.length > 128) {
    throw new AccountOperationError("初始密码长度须为 8 至 128 个字符。");
  }

  const passwordHash = await hashPassword(input.password);
  await withTransaction(async (connection) => {
    try {
      const accountId = createUlid();
      await connection.execute(
        `INSERT INTO accounts (
          id, username, display_name, role, password_hash, phone, email, status, must_change_password
        ) VALUES (?, ?, ?, 'expert', ?, ?, ?, 'active', 1)`,
        [
          accountId,
          input.username,
          input.displayName.trim(),
          passwordHash,
          input.phone?.trim() || null,
          input.email?.trim() || null
        ]
      );
      await connection.execute(
        `INSERT INTO audit_logs (
          id, actor_id, action, object_type, object_id, after_json, result
        ) VALUES (?, ?, 'account.create', 'account', ?, ?, 'success')`,
        [
          createUlid(),
          actorId,
          accountId,
          JSON.stringify({ username: input.username, role: "expert" })
        ]
      );
    } catch (error: unknown) {
      if (isDuplicateError(error)) {
        throw new AccountOperationError("该登录账号已存在。");
      }
      throw error;
    }
  });
}

export async function changeOwnPassword(
  accountId: string,
  input: Readonly<{ currentPassword: string; newPassword: string }>
): Promise<void> {
  if (input.newPassword.length < 8 || input.newPassword.length > 128) {
    throw new AccountOperationError("新密码长度须为 8 至 128 个字符。");
  }

  await withTransaction(async (connection) => {
    const [rows] = await connection.execute<(RowDataPacket & { password_hash: string })[]>(
      "SELECT password_hash FROM accounts WHERE id = ? AND status = 'active' AND deleted_at IS NULL FOR UPDATE",
      [accountId]
    );
    const account = rows[0];
    if (!account || !(await verifyPassword(input.currentPassword, account.password_hash))) {
      throw new AccountOperationError("当前密码不正确。");
    }

    const passwordHash = await hashPassword(input.newPassword);
    await connection.execute(
      `UPDATE accounts
          SET password_hash = ?, password_changed_at = UTC_TIMESTAMP(3), must_change_password = 0,
              row_version = row_version + 1
        WHERE id = ?`,
      [passwordHash, accountId]
    );
    await connection.execute(
      "UPDATE auth_sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE account_id = ? AND revoked_at IS NULL",
      [accountId]
    );
    await connection.execute(
      `INSERT INTO audit_logs (
        id, actor_id, action, object_type, object_id, result
      ) VALUES (?, ?, 'account.change_password', 'account', ?, 'success')`,
      [createUlid(), accountId, accountId]
    );
  });
}

export async function updateAccount(
  accountId: string,
  input: AccountUpdateInput,
  actorId: string
): Promise<void> {
  validateAccountProfile(input);

  await withTransaction(async (connection) => {
    const account = await getAccountForUpdate(connection, accountId);
    if (!account || account.status === "deleted") {
      throw new AccountOperationError("账号不存在或已删除。");
    }

    if (account.status !== input.status) {
      if (account.id === actorId && input.status === "disabled") {
        throw new AccountOperationError("不能停用当前登录账号。");
      }

      if (account.role === "admin" && input.status === "disabled") {
        const [adminRows] = await connection.execute<CountRow[]>(
          `SELECT COUNT(*) AS total
             FROM accounts
            WHERE role = 'admin' AND status = 'active' AND deleted_at IS NULL`
        );
        if (adminRows[0].total <= 1) {
          throw new AccountOperationError("至少需要保留一名启用管理员。");
        }
      }
    }

    const phone = input.phone?.trim() || null;
    const email = input.email?.trim() || null;
    await connection.execute(
      `UPDATE accounts
          SET display_name = ?, phone = ?, email = ?, status = ?, row_version = row_version + 1
        WHERE id = ?`,
      [input.displayName.trim(), phone, email, input.status, accountId]
    );

    if (account.status !== input.status && input.status === "disabled") {
      await connection.execute(
        "UPDATE auth_sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE account_id = ? AND revoked_at IS NULL",
        [accountId]
      );
    }

    await connection.execute(
      `INSERT INTO audit_logs (
        id, actor_id, action, object_type, object_id, before_json, after_json, result
      ) VALUES (?, ?, 'account.update', 'account', ?, ?, ?, 'success')`,
      [
        createUlid(),
        actorId,
        accountId,
        JSON.stringify({ displayName: account.display_name, phone: account.phone, email: account.email, status: account.status }),
        JSON.stringify({ displayName: input.displayName.trim(), phone, email, status: input.status })
      ]
    );
  });
}

export async function softDeleteAccount(accountId: string, actorId: string): Promise<void> {
  await withTransaction(async (connection) => {
    const account = await getAccountForUpdate(connection, accountId);
    if (!account || account.status === "deleted") {
      throw new AccountDeletionBlockedError("账号不存在或已删除。");
    }
    if (account.id === actorId) {
      throw new AccountDeletionBlockedError("不能删除当前登录账号。");
    }

    if (account.role === "admin") {
      const [adminRows] = await connection.execute<CountRow[]>(
        `SELECT COUNT(*) AS total
           FROM accounts
          WHERE role = 'admin' AND status = 'active' AND deleted_at IS NULL`
      );
      if (adminRows[0].total <= 1) {
        throw new AccountDeletionBlockedError("至少需要保留一名启用管理员。");
      }
    }

    const [assignmentRows] = await connection.execute<CountRow[]>(
      `SELECT COUNT(*) AS total
         FROM review_assignments
        WHERE expert_id = ? AND status = 'assigned' AND active_token = 'ACTIVE'`,
      [accountId]
    );
    if (assignmentRows[0].total > 0) {
      throw new AccountDeletionBlockedError("该专家存在待审任务，请先改派或取消任务。");
    }

    await connection.execute(
      `UPDATE accounts
          SET status = 'deleted',
              deleted_at = UTC_TIMESTAMP(3),
              row_version = row_version + 1
        WHERE id = ?`,
      [accountId]
    );
    await connection.execute(
      "UPDATE project_members SET status = 'disabled', row_version = row_version + 1 WHERE account_id = ?",
      [accountId]
    );
    await connection.execute(
      "UPDATE auth_sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE account_id = ? AND revoked_at IS NULL",
      [accountId]
    );
    await connection.execute(
      `INSERT INTO audit_logs (
        id, actor_id, action, object_type, object_id, before_json, after_json, result
      ) VALUES (?, ?, 'account.soft_delete', 'account', ?, ?, ?, 'success')`,
      [
        createUlid(),
        actorId,
        accountId,
        JSON.stringify({ username: account.username, role: account.role, status: account.status }),
        JSON.stringify({ status: "deleted" })
      ]
    );
  });
}

async function getAccountForUpdate(
  connection: PoolConnection,
  accountId: string
): Promise<AccountRow | null> {
  const [rows] = await connection.execute<AccountRow[]>(
    "SELECT id, username, display_name, phone, email, role, status FROM accounts WHERE id = ? FOR UPDATE",
    [accountId]
  );
  return rows[0] ?? null;
}

function validateAccountProfile(input: AccountUpdateInput): void {
  if (input.displayName.trim().length < 1 || input.displayName.trim().length > 128) {
    throw new AccountOperationError("请输入 1 至 128 个字符的姓名。");
  }
  if ((input.phone?.trim().length ?? 0) > 32) {
    throw new AccountOperationError("联系电话不能超过 32 个字符。");
  }
  if (input.email?.trim() && (input.email.trim().length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim()))) {
    throw new AccountOperationError("请输入正确的邮箱地址。");
  }
}

function isDuplicateError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ER_DUP_ENTRY";
}
