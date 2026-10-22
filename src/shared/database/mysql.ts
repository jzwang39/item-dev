import mysql, {
  type Pool,
  type PoolConnection,
  type RowDataPacket,
} from "mysql2/promise";

declare global {
  // Next.js development hot reload can re-evaluate this module. Keep the pool
  // on the process global so each reload reuses one bounded connection pool.
  // eslint-disable-next-line no-var
  var __itembankMysqlPool: Pool | undefined;
}

type SqlParameter =
  string | number | bigint | boolean | Date | Buffer | Uint8Array | null;
type SqlParameters = SqlParameter[];

export function getPool(): Pool {
  if (!globalThis.__itembankMysqlPool) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL 未配置。");
    }

    globalThis.__itembankMysqlPool = mysql.createPool({
      uri: databaseUrl,
      waitForConnections: true,
      connectionLimit: 3,
      maxIdle: 3,
      idleTimeout: 30_000,
      queueLimit: 0,
    });
  }

  return globalThis.__itembankMysqlPool;
}

export async function query<T extends RowDataPacket[]>(
  sql: string,
  parameters: SqlParameters = [],
): Promise<T> {
  const [rows] = await getPool().execute<T>(sql, parameters);
  return rows;
}

export async function withTransaction<T>(
  action: (connection: PoolConnection) => Promise<T>,
): Promise<T> {
  const connection = await getPool().getConnection();

  try {
    await connection.beginTransaction();
    const result = await action(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
