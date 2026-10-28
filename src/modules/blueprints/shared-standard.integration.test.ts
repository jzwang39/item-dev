import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadEnvConfig } from "@next/env";
import type { Pool, RowDataPacket } from "mysql2/promise";
import { getPool } from "@/shared/database/mysql";
import { createUlid } from "@/shared/database/ulid";
import { getCurrentTheoryWeights, importTheoryWeights } from "./theory-weights/service";
import { getSkillStandard, importSkillStandard } from "./skill-standard-import";
import { ensureSharedOccupationStandard } from "./shared-standard";
import { runSkillGeneration, startSkillGeneration } from "./skill-outline-generation";
import { skillOutlineWorkerVersion } from "./skill-generation-policy";

const grades = ["五级/初级工", "四级/中级工", "三级/高级工", "二级/技师", "一级/高级技师"];
const text = `共享标准集成验证素材
3. 工作要求
${grades.map((grade, index) => `3.${index + 1} ${grade}
职业功能 工作内容 技能要求 相关知识要求
1. 加工 1.1 作业准备
1.1.1 能选择刀具 1.1.1 刀具类型`).join("\n")}
4.1 理论知识权重表 ${grades.join(" ")}
基本要求 职业道德 5 5 5 5 5
基础知识 20 20 20 15 15
相关知识要求 加工 75 75 75 80 80
合计 100 100 100 100 100
4.2 技能要求权重表
项目 ${grades.join(" ")}
技能要求 加工 100 100 100 100 100
合计 100 100 100 100 100`;

test("隔离数据库：标准双向共享、技能逐条生成及失败原子回滚", {
  skip: process.env.RUN_SHARED_STANDARD_INTEGRATION !== "1",
}, async () => {
  loadEnvConfig(process.cwd());
  const pool = getPool();
  const directory = await mkdtemp(join(tmpdir(), "itemdev-shared-standard-"));
  const oldUploadDirectory = process.env.UPLOAD_DIR;
  const oldWorker = globalThis.__skillOutlineWorker;
  const oldWorkerVersion = globalThis.__skillOutlineWorkerVersion;
  const prefix = `ss_${Date.now().toString(36)}_`;
  const tables = [
    "projects", "project_occupations", "project_occupation_directions", "file_objects",
    "sources", "source_versions", "source_scopes", "source_segments",
    "blueprints", "blueprint_versions", "blueprint_nodes", "blueprint_version_sources",
    "blueprint_imports", "occupation_standard_requirement_scopes",
    "occupation_standard_requirement_nodes", "audit_logs",
    "theory_outline_generation_jobs", "skill_outline_generation_jobs",
  ];
  const created: string[] = [];
  const pattern = new RegExp(`\\b(${tables.join("|")})\\b`, "g");
  const rewrite = (sql: string) => sql.replace(pattern, (name) => prefix + name);
  let failSkillSave = false;
  let failOutlineSave = false, savedOutlinePoints = 0;
  const proxyConnection = (connection: object) => new Proxy(connection, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (key === "execute") return (sql: string, parameters: unknown[]) => {
        if (failSkillSave && sql.includes("'blueprint.skill_standard.import'")) throw new Error("injected skill save failure");
        if (failOutlineSave && sql.includes("'assessment_point'") && ++savedOutlinePoints === 2) throw new Error("injected outline save failure");
        return value.call(target, rewrite(sql), parameters);
      };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  try {
    for (const table of tables) {
      await pool.execute(`CREATE TABLE \`${prefix + table}\` LIKE \`${table}\``);
      created.push(table);
    }
    const [occupations] = await pool.execute<RowDataPacket[]>(
      `SELECT po.id,po.project_id FROM project_occupations po JOIN projects p ON p.id=po.project_id
       WHERE po.status='active' AND p.status='active' LIMIT 1`,
    );
    const [actors] = await pool.execute<RowDataPacket[]>("SELECT id FROM accounts WHERE role='admin' AND status='active' LIMIT 1");
    assert.ok(occupations[0] && actors[0], "需要本地启用职业和管理员作为隔离表的基础记录");
    const occupationId = occupations[0].id, actorId = actors[0].id;
    await pool.execute(`INSERT INTO ${prefix}projects SELECT * FROM projects WHERE id=?`, [occupations[0].project_id]);
    await pool.execute(`INSERT INTO ${prefix}project_occupations SELECT * FROM project_occupations WHERE id=?`, [occupationId]);
    globalThis.__itembankMysqlPool = new Proxy(pool, {
      get(target, key) {
        if (key === "getConnection") return async () => proxyConnection(await target.getConnection());
        if (key === "execute") return (sql: string, parameters: Parameters<Pool["execute"]>[1]) => target.execute(rewrite(sql), parameters);
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Pool;
    process.env.UPLOAD_DIR = directory;
    const count = async (table: string) => {
      const [rows] = await pool.execute<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${prefix + table}`);
      return Number(rows[0].n);
    };
    const assertShared = async () => {
      const theory = await getCurrentTheoryWeights(occupationId);
      const skill = await getSkillStandard(occupationId);
      assert.ok(theory?.scopes?.length && skill?.scopes?.length);
      assert.equal((theory as unknown as { fileObjectId: string }).fileObjectId, skill.fileObjectId);
      const [scopeRows] = await pool.execute<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${prefix}source_scopes WHERE source_version_id=?`, [skill.sourceVersionId]);
      assert.equal(Number(scopeRows[0].n), 10);
    };

    await importTheoryWeights(occupationId, { file: new File([text], "theory-upload.txt") }, actorId);
    await assertShared();
    assert.equal(await count("file_objects"), 1);
    assert.equal(await count("blueprint_versions"), 7);
    await importSkillStandard(occupationId, { file: new File([text], "skill-upload.txt") }, actorId);
    await assertShared();
    assert.equal((await getCurrentTheoryWeights(occupationId))?.sourceName, "skill-upload.txt");

    await pool.execute(`DELETE FROM ${prefix}blueprints WHERE assessment_mode='skill'`);
    await ensureSharedOccupationStandard(occupationId, actorId);
    await assertShared();
    await pool.execute(`DELETE FROM ${prefix}blueprints WHERE assessment_mode='theory'`);
    await ensureSharedOccupationStandard(occupationId, actorId);
    await assertShared();
    const versions = await count("blueprint_versions");
    await ensureSharedOccupationStandard(occupationId, actorId);
    assert.equal(await count("blueprint_versions"), versions);
    assert.equal(await count("file_objects"), 2, "历史同步不得重复保存原件");

    const sourceCount = await count("sources"), files = await readdir(directory);
    failSkillSave = true;
    await assert.rejects(importTheoryWeights(occupationId, { file: new File([text], "failed-upload.txt") }, actorId), /injected/);
    failSkillSave = false;
    assert.equal(await count("blueprint_versions"), versions);
    assert.equal(await count("sources"), sourceCount);
    assert.equal(await count("file_objects"), 2);
    assert.deepEqual(await readdir(directory), files);

    globalThis.__skillOutlineWorker = setInterval(() => undefined, 86400000);
    globalThis.__skillOutlineWorker.unref();
    globalThis.__skillOutlineWorkerVersion = skillOutlineWorkerVersion;
    const oldLevelVersions = new Map<string, string>();
    for (const level of ["level_2", "level_1"]) {
      const blueprintId = createUlid(), versionId = createUlid();
      await pool.execute(
        `INSERT INTO ${prefix}blueprints(id,project_id,occupation_id,level_code,name,blueprint_kind,assessment_mode,current_version_id)
         VALUES(?,?,?,?,'保留历史技能细目表','skill_outline','skill',?)`,
        [blueprintId, occupations[0].project_id, occupationId, level, versionId],
      );
      await pool.execute(
        `INSERT INTO ${prefix}blueprint_versions(id,blueprint_id,version_no,status,content_hash,snapshot_json,created_by)
         VALUES(?,?,1,'published',?,?,?)`,
        [versionId, blueprintId, "a".repeat(64), JSON.stringify({ levelCode: level, points: [], historical: true }), actorId],
      );
      oldLevelVersions.set(level, versionId);
    }
    await pool.execute(
      `UPDATE ${prefix}occupation_standard_requirement_nodes r JOIN ${prefix}occupation_standard_requirement_scopes s ON s.id=r.scope_id
       SET r.evidence_text='不处理技能等级的模拟无效依据' WHERE s.level_code IN ('level_2','level_1') AND r.node_kind='skill_requirement'`,
    );
    const model = async (_instruction: string, prompt: string) => JSON.stringify({
      completed: true, points: JSON.parse(prompt).技能要求.map((item: { requirementId: string; 技能要求: string }) => ({
        requirementId: item.requirementId, name: item.技能要求.replace(/^能/, ""), importance: "X",
      })),
    });
    const generated = await startSkillGeneration(occupationId, "model", 40, actorId);
    await runSkillGeneration(generated.id, model);
    const [jobRows] = await pool.execute<RowDataPacket[]>(`SELECT * FROM ${prefix}skill_outline_generation_jobs WHERE id=?`, [generated.id]);
    assert.equal(jobRows[0].status, "succeeded", jobRows[0].error_message);
    assert.equal(Number(jobRows[0].generated_point_count), 9);
    const basis = typeof jobRows[0].basis_snapshot_json === "string" ? JSON.parse(jobRows[0].basis_snapshot_json) : jobRows[0].basis_snapshot_json;
    assert.deepEqual(basis.generationLevels, ["level_5", "level_4", "level_3"]);
    assert.ok(basis.scopes.every((scope: { column: { levelCode: string } }) => !oldLevelVersions.has(scope.column.levelCode)));
    const [outlines] = await pool.execute<RowDataPacket[]>(
      `SELECT v.id,b.level_code,v.snapshot_json FROM ${prefix}blueprints b JOIN ${prefix}blueprint_versions v ON v.id=b.current_version_id WHERE b.blueprint_kind='skill_outline'`,
    );
    assert.equal(outlines.length, 5);
    for (const outline of outlines) {
      const snapshot = typeof outline.snapshot_json === "string" ? JSON.parse(outline.snapshot_json) : outline.snapshot_json;
      if (oldLevelVersions.has(outline.level_code)) {
        assert.equal(outline.id, oldLevelVersions.get(outline.level_code));
        assert.equal(snapshot.historical, true);
        continue;
      }
      assert.equal(snapshot.points.length, 3);
      assert.equal(snapshot.points.reduce((sum: number, point: { targetCount: number }) => sum + point.targetCount, 0), 40);
      assert.deepEqual(new Set(snapshot.points.map((point: { sourceStandardRequirement: { nodeKind: string } }) =>
        point.sourceStandardRequirement.nodeKind)), new Set(["skill_requirement", "work_content", "occupational_function"]));
      for (const point of snapshot.points) {
        assert.equal(point.sourceStandardRequirement.levelCode, snapshot.levelCode);
        assert.ok(point.standardText.includes("1.1.1 能选择刀具"));
      }
    }
    const publishedVersions = await count("blueprint_versions"), publishedNodes = await count("blueprint_nodes");
    const failedModel = await startSkillGeneration(occupationId, "model", 40, actorId);
    await runSkillGeneration(failedModel.id, async () => '{"completed":true,"points":[]}');
    assert.equal(await count("blueprint_versions"), publishedVersions);
    const [failedRows] = await pool.execute<RowDataPacket[]>(`SELECT status,draft_snapshot_json FROM ${prefix}skill_outline_generation_jobs WHERE id=?`, [failedModel.id]);
    assert.equal(failedRows[0].status, "failed");
    assert.equal(failedRows[0].draft_snapshot_json, null);
    const failedSave = await startSkillGeneration(occupationId, "model", 40, actorId);
    failOutlineSave = true;
    await runSkillGeneration(failedSave.id, model);
    failOutlineSave = false;
    assert.equal(await count("blueprint_versions"), publishedVersions);
    assert.equal(await count("blueprint_nodes"), publishedNodes);
    const [saveRows] = await pool.execute<RowDataPacket[]>(`SELECT status,error_message FROM ${prefix}skill_outline_generation_jobs WHERE id=?`, [failedSave.id]);
    assert.equal(saveRows[0].status, "failed");
    assert.match(saveRows[0].error_message, /injected outline save failure/);
  } finally {
    if (globalThis.__skillOutlineWorker && globalThis.__skillOutlineWorker !== oldWorker) clearInterval(globalThis.__skillOutlineWorker);
    globalThis.__skillOutlineWorker = oldWorker;
    globalThis.__skillOutlineWorkerVersion = oldWorkerVersion;
    globalThis.__itembankMysqlPool = pool;
    if (oldUploadDirectory === undefined) delete process.env.UPLOAD_DIR;
    else process.env.UPLOAD_DIR = oldUploadDirectory;
    for (const table of created.reverse()) await pool.execute(`DROP TABLE \`${prefix + table}\``);
    await rm(directory, { recursive: true, force: true });
    await pool.end();
  }
});
