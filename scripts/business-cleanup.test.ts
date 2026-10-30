import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createConnection, type Connection, type RowDataPacket } from "mysql2/promise";
import { cleanupTargets, deletionOrder, executeCleanup, previewCleanup, readCleanupSchema, type ForeignKey } from "./business-cleanup";
import { createUlid } from "../src/shared/database/ulid";

test("基础资料与配置不属于清理目标", () => {
  const tables = new Set(cleanupTargets.map((target) => target.table));
  for (const table of [
    "accounts", "projects", "project_occupations", "sources", "source_versions",
    "file_objects", "occupation_standard_requirement_scopes", "occupation_standard_requirement_nodes",
    "system_settings", "model_configs", "model_config_versions", "model_connection_settings", "audit_logs",
  ]) assert.equal(tables.has(table), false, table);
  assert.match(cleanupTargets.find((target) => target.table === "blueprints")!.where,
    /'theory_outline','skill_outline'/);
  assert.equal(tables.size, cleanupTargets.length);
});

test("按外键从子表到父表排序，忽略待置空的自关联", () => {
  const key = (child: string, parent: string): ForeignKey => ({
    child, parent, name: `${child}_${parent}`, columns: ["parent_id"], parentColumns: ["id"], nullable: true,
  });
  assert.deepEqual(deletionOrder(["parent", "version", "child"].map((table) => ({ table, where: "1=1" })),
    [key("version", "parent"), key("child", "version"), key("version", "version")]),
  ["child", "version", "parent"]);
  assert.throws(() => deletionOrder(["a", "b"].map((table) => ({ table, where: "1=1" })),
    [key("a", "b"), key("b", "a")]), /循环外键/);
});

test("命令行在连接前拒绝错误数据库、未停服备份、管道执行及双重配置", () => {
  const run = (args: string[]) => spawnSync(process.execPath, [
    "--import", "tsx", "scripts/clean-business-data.ts", ...args,
  ], { encoding: "utf8", env: { ...process.env, DATABASE_URL: "mysql://unused@127.0.0.1/cleanup_cli_test" } });
  for (const [args, message] of [
    [["--execute", "--database", "wrong"], /数据库名称完全一致/],
    [["--execute", "--database", "cleanup_cli_test", "--operator", "测试"], /停服/],
    [["--execute", "--database", "cleanup_cli_test", "--operator", "测试",
      "--maintenance-confirmed", "--backup-confirmed"], /交互终端/],
    [["--config-file", "/not-an-env-file"], /不能同时指定/],
  ] as [string[], RegExp][]) {
    const result = run(args);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, message);
    assert.doesNotMatch(result.stderr, /unused|ECONNREFUSED/);
  }
});

test("隔离 MySQL：预览、保留标准、外键保护、事务回滚、清空及重复执行", {
  skip: process.env.RUN_CLEANUP_INTEGRATION !== "1",
}, async () => {
  assert.ok(process.env.DATABASE_URL, "请提供本地 DATABASE_URL");
  const url = new URL(process.env.DATABASE_URL);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "集成测试仅允许本机 MySQL");
  const database = decodeURIComponent(url.pathname.slice(1));
  const prefix = `bc_${Date.now().toString(36)}_${process.pid}_`;
  assert.match(prefix, /^bc_[a-z0-9]+_\d+_$/);
  const migrations = await Promise.all(
    (await readdir(join(process.cwd(), "database/migrations"))).filter((name) => name.endsWith(".sql")).sort()
      .map((name) => readFile(join(process.cwd(), "database/migrations", name), "utf8")),
  );
  const tables = migrations.flatMap((sql) => [...sql.matchAll(/CREATE TABLE (\w+)/g)].map((match) => match[1]));
  const pattern = new RegExp(`\\b(${[...tables, "cleanup_preserved_reference"].join("|")})\\b`, "g");
  const rewrite = (sql: string) => sql.replace(pattern, (table) => prefix + table)
    .replace(/CONSTRAINT (\w+)/g, (_, name: string) => `CONSTRAINT ${prefix}${name}`);
  const raw = await createConnection({ uri: url.toString(), multipleStatements: true });
  const db = new Proxy(raw, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (key === "query" || key === "execute") return async (sql: string, parameters?: unknown[]) => {
        const result = await value.call(target, rewrite(sql), parameters);
        if (sql.includes("information_schema.")) {
          result[0] = result[0].filter((row: RowDataPacket) =>
            String(row.child ?? row.name).startsWith(prefix)).map((row: RowDataPacket) => {
              const mapped = { ...row };
              for (const field of ["name", "child", "parent"]) {
                if (typeof mapped[field] === "string" && mapped[field].startsWith(prefix)) {
                  mapped[field] = mapped[field].slice(prefix.length);
                }
              }
              return mapped;
            });
        }
        return result;
      };
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Connection;
  const insert = async (table: string, data: Record<string, string | number | null>) => {
    const keys = Object.keys(data);
    await db.execute(`INSERT INTO \`${table}\` (${keys.map((key) => `\`${key}\``).join(",")})
      VALUES (${keys.map(() => "?").join(",")})`, Object.values(data));
  };
  const count = async (table: string) => {
    const [rows] = await db.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM \`${table}\``);
    return Number(rows[0].n);
  };
  try {
    for (const sql of migrations) {
      await db.query(sql.replace(/CREATE DATABASE IF NOT EXISTS itembank[\s\S]*?;/, "").replace(/USE itembank;/, ""));
    }
    const project = createUlid(), occupation = createUlid();
    await insert("projects", { id: project, code: "CLEANUP-TEST", name: "清理测试" });
    await insert("project_occupations", { id: occupation, project_id: project, code: "TEST", name: "测试职业" });
    const weight = createUlid(), outline = createUlid(), skillStructure = createUlid();
    const weightVersion = createUlid(), outlineVersion = createUlid();
    for (const [id, kind] of [[weight, "theory_weight"], [outline, "theory_outline"], [skillStructure, "skill_structure"]]) {
      await insert("blueprints", { id, project_id: project, name: kind, blueprint_kind: kind,
        occupation_id: occupation, level_code: "level_5", assessment_mode: kind === "skill_structure" ? "skill" : "theory" });
    }
    for (const [id, blueprint] of [[weightVersion, weight], [outlineVersion, outline]]) {
      await insert("blueprint_versions", { id, blueprint_id: blueprint, version_no: 1, snapshot_json: "{}" });
    }
    const weightNode = createUlid(), root = createUlid(), child = createUlid();
    for (const [id, version, parent] of [[weightNode, weightVersion, null], [root, outlineVersion, null], [child, outlineVersion, root]]) {
      await insert("blueprint_nodes", { id, blueprint_version_id: version, parent_id: parent,
        node_kind: "assessment_point", node_code: id, name: "测试节点", ordinal: 1 });
    }
    const question = createUlid(), version1 = createUlid(), version2 = createUlid();
    await insert("questions", { id: question, project_id: project, question_no: "TEST-1",
      assessment_mode: "theory", question_type: "single", current_status: "stored" });
    for (const [id, version, parent] of [[version1, 1, null], [version2, 2, version1]]) {
      await insert("question_versions", { id, question_id: question, version_no: version, parent_version_id: parent,
        stem: "测试题干", content_json: "{}", answer_json: "[]", source_snapshot_json: "{}",
        content_hash: String(version).repeat(64) });
    }
    await insert("question_assessment_points", { question_version_id: version2, blueprint_node_id: child });
    const structure = createUlid(), structureVersion = createUlid(), plan = createUlid();
    const planVersion = createUlid(), run = createUlid(), paper = createUlid();
    await insert("paper_structures", { id: structure, project_id: project, name: "测试结构",
      occupation_id: occupation, level_code: "level_5", assessment_mode: "theory" });
    await insert("paper_structure_versions", { id: structureVersion, paper_structure_id: structure, version_no: 1,
      template_code: "TEST", total_items: 1, total_score: 1, snapshot_json: "{}" });
    await insert("assembly_plans", { id: plan, project_id: project, name: "测试计划",
      occupation_id: occupation, level_code: "level_5", assessment_mode: "theory" });
    await insert("assembly_plan_versions", { id: planVersion, assembly_plan_id: plan, version_no: 1,
      paper_structure_version_id: structureVersion, candidate_filter_json: "{}", snapshot_json: "{}" });
    await insert("assembly_runs", { id: run, project_id: project, assembly_plan_version_id: planVersion });
    await insert("papers", { id: paper, project_id: project, paper_no: "P1", assembly_run_id: run,
      assembly_plan_version_id: planVersion, paper_structure_version_id: structureVersion,
      title: "测试卷", snapshot_hash: "0".repeat(64) });
    const exportId = createUlid(), jobId = createUlid();
    await insert("jobs", { id: jobId, project_id: project, queue_name: "export", job_type: "export",
      business_type: "paper", business_id: paper, idempotency_key: jobId });
    await insert("exports", { id: exportId, project_id: project, export_type: "paper", source_type: "paper",
      source_id: paper, snapshot_json: "{}", template_version: "1", job_id: jobId });
    await insert("system_settings", { setting_key: "cleanup.test", setting_value_json: "{}" });
    await insert("audit_logs", { id: createUlid(), action: "test.existing", object_type: "project",
      object_id: project, result: "success" });
    const schema = await readCleanupSchema(db);
    const before = await previewCleanup(db);
    assert.equal(before.find((item) => item.table === "blueprints")!.count, 1);
    assert.equal(await count("questions"), 1, "预览不修改数据");
    await db.query(`CREATE TABLE cleanup_preserved_reference (
      id INT PRIMARY KEY, question_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin,
      FOREIGN KEY(question_id) REFERENCES questions(id)) ENGINE=InnoDB`);
    await insert("cleanup_preserved_reference", { id: 1, question_id: question });
    await assert.rejects(executeCleanup(db, await readCleanupSchema(db), { database, operator: "测试" }), /保留数据/);
    await db.query("DROP TABLE cleanup_preserved_reference");
    const failing = new Proxy(db, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (key === "execute") return (sql: string, parameters: unknown[]) => {
          if (sql.includes("'maintenance.business_cleanup'")) throw new Error("injected audit failure");
          return value.call(target, sql, parameters);
        };
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Connection;
    await assert.rejects(executeCleanup(failing, schema, { database, operator: "测试" }), /injected audit failure/);
    assert.equal(await count("questions"), 1, "删除及版本自关联修改必须整体回滚");
    assert.deepEqual(await previewCleanup(db), before);
    const [parents] = await db.query<RowDataPacket[]>("SELECT parent_version_id FROM question_versions WHERE id=?", [version2]);
    assert.equal(parents[0].parent_version_id, version1);
    const result = await executeCleanup(db, schema, { database, operator: "测试" });
    assert.ok(result.auditId);
    assert.ok((await previewCleanup(db)).every((item) => item.count === 0));
    assert.equal(await count("blueprints"), 2);
    assert.equal(await count("blueprint_nodes"), 1);
    assert.equal(await count("system_settings"), 1);
    assert.equal(await count("project_occupations"), 1);
    assert.equal(await count("audit_logs"), 2);
    const repeated = await executeCleanup(db, schema, { database, operator: "测试" });
    assert.ok(repeated.counts.every((item) => item.count === 0));
  } finally {
    // Only these newly created disposable tables are removed. The application
    // tables are never passed to DROP or any write statement.
    await raw.query("SET FOREIGN_KEY_CHECKS=0");
    try {
      await raw.query(`DROP TABLE IF EXISTS ${[...tables, "cleanup_preserved_reference"]
        .map((table) => `\`${prefix}${table}\``).join(",")}`);
    } finally {
      await raw.query("SET FOREIGN_KEY_CHECKS=1");
      await raw.end();
    }
  }
});
