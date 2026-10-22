import { createPool, type RowDataPacket } from "mysql2/promise";

import { hashPassword } from "../src/modules/auth/passwords";
import { createUlid } from "../src/shared/database/ulid";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const username = process.env.BOOTSTRAP_ADMIN_USERNAME?.trim();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const displayName = process.env.BOOTSTRAP_ADMIN_DISPLAY_NAME?.trim() || "系统管理员";

  if (!databaseUrl || !username || !password) {
    throw new Error(
      "管理员 Seed 需要 DATABASE_URL、BOOTSTRAP_ADMIN_USERNAME 和 BOOTSTRAP_ADMIN_PASSWORD。"
    );
  }

  const pool = createPool(databaseUrl);
  try {
    const [rows] = await pool.query<(RowDataPacket & { id: string })[]>(
      `SELECT id
         FROM accounts
        WHERE role = 'admin'
          AND status = 'active'
          AND deleted_at IS NULL
        LIMIT 1`
    );

    if (rows.length > 0) {
      console.info("已存在启用管理员，跳过初始化 Seed。");
      return;
    }

    const passwordHash = await hashPassword(password);
    await pool.execute(
      `INSERT INTO accounts (
        id, username, display_name, role, password_hash, status, must_change_password
      ) VALUES (?, ?, ?, 'admin', ?, 'active', 1)`,
      [createUlid(), username, displayName, passwordHash]
    );
    console.info("初始管理员已创建，首次登录后请修改密码。");
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
