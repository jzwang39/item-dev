import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvConfig } from "@next/env";
import { createConnection, type RowDataPacket } from "mysql2/promise";
import { createUlid } from "../src/shared/database/ulid";

async function main() {
  loadEnvConfig(process.cwd());
  const prefix = `tw_${Date.now()}_`;
  const tables = ["projects", "project_occupations", "project_occupation_directions", "file_objects",
    "sources", "source_versions", "source_scopes", "source_segments", "blueprints", "blueprint_versions",
    "blueprint_nodes", "blueprint_imports", "blueprint_version_sources", "audit_logs",
    "occupation_standard_requirement_scopes", "occupation_standard_requirement_nodes"];
  const db = await createConnection(process.env.DATABASE_URL!);
  const directory = await mkdtemp(join(tmpdir(), "theory-standard-test-"));
  const previousDirectory = process.env.UPLOAD_DIR;
  process.env.UPLOAD_DIR = directory;
  const rewrite = (sql: string) => sql.replace(new RegExp(`\\b(${tables.join("|")})\\b`, "g"), (name) => `${prefix}${name}`);
  const raw = db.query.bind(db);
  const execute = db.execute.bind(db);
  const { getPool } = await import("../src/shared/database/mysql");
  const pool = getPool();
  let failAudit = false;
  try {
    for (const table of tables) await raw(`CREATE TABLE \`${prefix}${table}\` LIKE \`${table}\``);
    db.execute = ((sql: string, values?: Parameters<typeof db.execute>[1]) => execute(rewrite(sql), values)) as typeof db.execute;
    const poolExecute = pool.execute.bind(pool);
    pool.execute = ((sql: string, values?: Parameters<typeof pool.execute>[1]) => poolExecute(rewrite(sql), values)) as typeof pool.execute;
    const getConnection = pool.getConnection.bind(pool);
    pool.getConnection = async () => {
      const connection = await getConnection();
      const wrapped = connection as typeof connection & { theoryTestWrapped?: boolean };
      if (!wrapped.theoryTestWrapped) {
        const original = connection.execute.bind(connection);
        connection.execute = ((sql: string, values?: Parameters<typeof connection.execute>[1]) => {
          if (failAudit && sql.startsWith("INSERT INTO audit_logs")) throw new Error("injected final audit failure");
          return original(rewrite(sql), values);
        }) as typeof connection.execute;
        wrapped.theoryTestWrapped = true;
      }
      return connection;
    };
    const { importTheoryWeights, getCurrentTheoryWeights } = await import("../src/modules/blueprints/theory-weights/service");
    const project = createUlid(), occupation = createUlid(), actor = createUlid();
    await db.execute("INSERT INTO projects(id,code,name) VALUES(?,'theory-check','理论标准验证')", [project]);
    await db.execute("INSERT INTO project_occupations(id,project_id,code,name) VALUES(?,?,'3-01-01-05','劝募员')", [occupation, project]);
    const bytes = await readFile("docs/测试真实数据/劝募员-标准（技能水平和理论知识&一级到五级）.pdf");
    const file = new File([bytes], "劝募员标准.pdf", { type: "application/pdf" });
    const imported = await importTheoryWeights(occupation, { file }, actor);
    assert.equal(imported.versionNo, 1);
    assert.equal(imported.items.length, 6);
    assert.equal(imported.requirementScopeCount, 5);
    const [skills] = await db.execute<(RowDataPacket & { n: number })[]>(
      "SELECT COUNT(*) AS n FROM occupation_standard_requirement_nodes WHERE node_kind='skill_requirement'",
    );
    assert.equal(Number(skills[0].n), 88);
    const [parentage] = await db.execute<RowDataPacket[]>(
      `SELECT s.name AS skill, c.name AS content, f.name AS fn
         FROM occupation_standard_requirement_nodes s
         JOIN occupation_standard_requirement_nodes c ON c.id=s.parent_id
         JOIN occupation_standard_requirement_nodes f ON f.id=c.parent_id
        WHERE s.name='能宣讲募捐工作基本理念' AND s.node_kind='skill_requirement'`,
    );
    assert.equal(parentage[0].content, "理念宣传");
    assert.equal(parentage[0].fn, "公益慈善宣讲");
    const before = await getCurrentTheoryWeights(occupation);
    failAudit = true;
    await assert.rejects(importTheoryWeights(occupation, { file }, actor), /injected/);
    failAudit = false;
    assert.deepEqual(await getCurrentTheoryWeights(occupation), before);
    assert.equal((await readdir(directory)).length, 1);
    const count = async (table: string) => Number((await db.execute<(RowDataPacket & { n: number })[]>(`SELECT COUNT(*) AS n FROM ${table}`))[0][0].n);
    assert.equal(await count("blueprint_versions"), 1);
    assert.equal(await count("occupation_standard_requirement_scopes"), 5);
    const directionalOccupation = createUlid(), ordinary = createUlid(), cnc = createUlid();
    await db.execute("INSERT INTO project_occupations(id,project_id,code,name) VALUES(?,?,'6-18-01-01','车工')", [directionalOccupation, project]);
    await db.execute("INSERT INTO project_occupation_directions(id,occupation_id,ordinal,name) VALUES(?,?,1,'普通车床'),(?,?,2,'数控车床')",
      [ordinary, directionalOccupation, cnc, directionalOccupation]);
    const labels = ["五级/初级工", "四级/中级工", "三级/高级工", "二级/技师", "一级/高级技师"];
    const work = `3. 工作要求\n${labels.map((label, index) => `3.${index + 1} ${label}
职业功能 工作内容 技能要求 相关知识要求
1. 工件加工 1.1 作业准备 1.1.1 能选择刀具 1.1.1 刀具类型`).join("\n")}`;
    const weightText = `4.1 理论知识权重表
五级/初级工 四级/中级工 普通车床 数控车床 三级/高级工 普通车床 数控车床 二级/技师 普通车床 数控车床 一级/高级技师 普通车床 数控车床
基本要求 职业道德 5 5 5 5 5 5 5 5 5
相关知识要求 工件加工 95 95 85 95 85 95 85 95 85
设备维护 0 0 10 0 10 0 10 0 10
合计 100 100 100 100 100 100 100 100 100`;
    const directional = await importTheoryWeights(directionalOccupation, {
      file: new File([`${work}\n${weightText}`], "车工标准.txt", { type: "text/plain" }),
    }, actor);
    assert.equal(directional.scopes?.length, 2);
    assert.equal(directional.scopes?.[0].directionId, ordinary);
    assert.equal(directional.scopes?.[1].directionId, cnc);
    assert.equal(directional.scopes?.[0].items[1].weights.level_4, 95);
    assert.equal(directional.scopes?.[1].items[1].weights.level_4, 85);
    assert.equal(directional.items.length, 0);
    assert.deepEqual((await getCurrentTheoryWeights(directionalOccupation))?.scopes, directional.scopes);
    const [savedDirections] = await db.execute<RowDataPacket[]>(
      "SELECT requirement_json FROM blueprint_nodes WHERE blueprint_version_id=? ORDER BY ordinal", [directional.versionId],
    );
    assert.ok(savedDirections.some((row) => (typeof row.requirement_json === "string" ? JSON.parse(row.requirement_json) : row.requirement_json).directionId === cnc));
    await assert.rejects(importTheoryWeights(directionalOccupation, {
      file: new File([`${work}\n${weightText.replace(/数控车床/g, "其他方向")}`], "错误标准.txt"),
    }, actor), /无法可靠|未匹配/);
    assert.equal(await count("blueprint_versions"), 2);
    assert.equal((await readdir(directory)).length, 2);
    console.log("PASS: real PDF, 88 skills, parent hierarchy, directional snapshots, version preservation and database/file rollback");
  } finally {
    if (previousDirectory === undefined) delete process.env.UPLOAD_DIR;
    else process.env.UPLOAD_DIR = previousDirectory;
    for (const table of [...tables].reverse()) await raw(`DROP TABLE IF EXISTS \`${prefix}${table}\``);
    await db.end();
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
