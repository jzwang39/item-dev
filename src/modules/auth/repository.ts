import { createHash, randomBytes } from "node:crypto";
import type { RowDataPacket } from "mysql2";

import { query } from "@/shared/database/mysql";
import { createUlid } from "@/shared/database/ulid";

export type AccountRole = "admin" | "expert";

export type AccountRecord = {
  id: string;
  username: string;
  display_name: string;
  role: AccountRole;
  password_hash: string;
  status: "active" | "disabled" | "deleted";
  must_change_password: 0 | 1;
};

type AccountRow = AccountRecord & RowDataPacket;

export async function findActiveAccountByUsername(username: string): Promise<AccountRecord | null> {
  const rows = await query<AccountRow[]>(
    `SELECT id, username, display_name, role, password_hash, status, must_change_password
       FROM accounts
      WHERE username = ?
        AND status = 'active'
        AND deleted_at IS NULL
      LIMIT 1`,
    [username]
  );

  return rows[0] ?? null;
}

export async function createSession(accountId: string): Promise<{ id: string; token: string }> {
  const token = randomBytes(32).toString("base64url");
  const sessionHash = hashSessionToken(token);
  const sessionId = createUlid();
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);

  await query(
    `INSERT INTO auth_sessions (id, account_id, session_hash, expires_at)
     VALUES (?, ?, ?, ?)`,
    [sessionId, accountId, sessionHash, expiresAt]
  );

  await query(
    "UPDATE accounts SET last_login_at = UTC_TIMESTAMP(3) WHERE id = ?",
    [accountId]
  );

  return { id: sessionId, token };
}

export async function isSessionActive(sessionId: string, accountId: string): Promise<boolean> {
  const rows = await query<RowDataPacket[]>(
    `SELECT session.id
       FROM auth_sessions AS session
       INNER JOIN accounts AS account ON account.id = session.account_id
      WHERE session.id = ?
        AND session.account_id = ?
        AND session.revoked_at IS NULL
        AND session.expires_at > UTC_TIMESTAMP(3)
        AND account.status = 'active'
        AND account.deleted_at IS NULL
      LIMIT 1`,
    [sessionId, accountId]
  );

  return Boolean(rows[0]);
}

export async function revokeSession(sessionId: string): Promise<void> {
  await query(
    "UPDATE auth_sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE id = ? AND revoked_at IS NULL",
    [sessionId]
  );
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
