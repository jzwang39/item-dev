import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createConnection, type RowDataPacket } from "mysql2/promise";

function getMigrationConnectionUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.pathname = "/";
  return url.toString();
}

function getDatabaseName(databaseUrl: string): string {
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
  if (!databaseName) throw new Error("DATABASE_URL 缺少数据库名称。");
  return databaseName;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL 未配置，无法执行迁移。");
  }

  const databaseName = getDatabaseName(databaseUrl);
  const migrationsDirectory = join(process.cwd(), "database", "migrations");
  const migrationFiles = (await readdir(migrationsDirectory))
    .filter((file) => /^\d+_.+\.sql$/.test(file))
    .sort();
  const connection = await createConnection({
    uri: getMigrationConnectionUrl(databaseUrl),
    multipleStatements: true,
  });

  try {
    await connection.query(`USE \`${databaseName.replace(/`/g, "``")}\``);
    const [migrationTableRows] = await connection.query<RowDataPacket[]>(
      `SELECT TABLE_NAME
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = 'itembank' AND TABLE_NAME = 'schema_migrations'
        LIMIT 1`,
    );
    let trackingTableExists = migrationTableRows.length > 0;

    for (const file of migrationFiles) {
      const source = await readFile(join(migrationsDirectory, file), "utf8");

      if (trackingTableExists) {
        const [rows] = await connection.query<RowDataPacket[]>(
          "SELECT file_name FROM itembank.schema_migrations WHERE file_name = ? LIMIT 1",
          [file],
        );
        if (rows.length > 0) {
          console.info(`跳过已执行迁移：${file}`);
          continue;
        }
      }

      await connection.query(source);
      if (file === "0001_initial_schema.sql") {
        await connection.query(`
          CREATE TABLE IF NOT EXISTS itembank.schema_migrations (
            file_name VARCHAR(255) NOT NULL,
            executed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            PRIMARY KEY (file_name)
          ) ENGINE=InnoDB
        `);
        trackingTableExists = true;
      }
      await connection.query(
        "INSERT IGNORE INTO itembank.schema_migrations (file_name) VALUES (?)",
        [file],
      );
      console.info(`已执行迁移：${file}`);
    }
  } finally {
    await connection.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
