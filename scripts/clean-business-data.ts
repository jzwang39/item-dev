import { createInterface } from "node:readline/promises";
import { loadEnvFile } from "node:process";
import { parseArgs } from "node:util";
import { createConnection } from "mysql2/promise";
import { executeCleanup, previewCleanup, readCleanupSchema } from "./business-cleanup";

const help = `
业务数据清理工具（默认仅预览，不删除）

预览：
  npm run db:clean:business -- --config-file .env.production

执行（必须先停止所有应用实例、后台进程并完成数据库备份）：
  npm run db:clean:business -- --config-file .env.production --execute \\
    --database itembank --operator 张三 --maintenance-confirmed --backup-confirmed

执行时还须在终端输入：清空业务数据:<数据库名称>
不支持自动确认。清理所有项目，包括通用法规试题和已入库试题。
保留账号、项目、职业、资料原件、权重表、技能结构表、模型配置及历史审计。
要求 Node.js >= 20.12；也可预先设置 DATABASE_URL，省略 --config-file。
`;

async function main() {
  const { values } = parseArgs({
    options: {
      help: { type: "boolean", short: "h" },
      "config-file": { type: "string" },
      execute: { type: "boolean" },
      database: { type: "string" },
      operator: { type: "string" },
      "maintenance-confirmed": { type: "boolean" },
      "backup-confirmed": { type: "boolean" },
    },
    allowPositionals: false,
  });
  if (values.help) {
    console.info(help);
    return;
  }
  if (values["config-file"]) {
    // Prevent an inherited URL from silently overriding the requested env file.
    if (process.env.DATABASE_URL) {
      throw new Error("已设置 DATABASE_URL，不能同时指定 --config-file。请明确选择一种配置来源。");
    }
    loadEnvFile(values["config-file"]);
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("请指定 --config-file 或设置 DATABASE_URL。");
  const url = new URL(databaseUrl);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!database || !["mysql:", "mysql2:"].includes(url.protocol)) {
    throw new Error("DATABASE_URL 必须指定 MySQL 数据库名称。");
  }
  const operator = values.operator?.trim();
  if (values.execute) {
    if (values.database !== database) throw new Error("--database 必须与连接配置中的数据库名称完全一致。");
    if (!operator || operator.length > 100) throw new Error("请通过 --operator 填写操作人（1-100 字）。");
    if (!values["maintenance-confirmed"] || !values["backup-confirmed"]) {
      throw new Error("执行前须停服、停止后台进程并完成备份，然后提供 --maintenance-confirmed --backup-confirmed。");
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("清理必须在交互终端人工确认，不支持管道或无人值守执行。");
    }
  }
  console.info(`目标服务器：${url.hostname}:${url.port || "3306"}，数据库：${database}`);
  console.info("保留：账号、项目、职业、教材/职业标准原件及解析资料、权重表、技能结构表、配置、历史审计、上传文件。");
  console.info("删除：所有项目的试卷、试题（含已入库）、细目表及关联命题、审核、组卷、导出记录。");
  const db = await createConnection({ uri: databaseUrl, multipleStatements: false });
  try {
    const schema = await readCleanupSchema(db);
    const counts = await previewCleanup(db);
    console.table(counts.map((item) => ({ 数据表: item.table, 待清理记录数: item.count })));
    console.info(`合计 ${counts.reduce((sum, item) => sum + item.count, 0)} 条记录（含关联明细）。`);
    if (!values.execute) {
      console.info("预览完成，未修改任何数据。执行方式见 --help。");
      return;
    }
    const expected = `清空业务数据:${database}`;
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    let answer: string;
    try {
      answer = await prompt.question(`此操作不可撤销。确认已停服并备份后，输入 ${expected}：`);
    } finally {
      prompt.close();
    }
    if (answer !== expected) throw new Error("确认内容不匹配，未执行清理。");
    const result = await executeCleanup(db, schema, { database, operator: operator! });
    console.info(`清理完成，实际删除 ${result.counts.reduce((sum, item) => sum + item.count, 0)} 条记录。`);
    console.info(`审计记录：${result.auditId}。可先重新运行预览，再启动应用。`);
  } finally {
    await db.end();
  }
}

main().catch((error: unknown) => {
  // Driver errors can contain SQL and connection details. Do not print the URL.
  console.error(`清理工具退出：${error instanceof Error ? error.message : "未知错误"}`);
  process.exitCode = 1;
});
