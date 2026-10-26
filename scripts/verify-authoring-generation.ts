// Uses uniquely prefixed disposable tables and a fake model. No real rows or
// model credentials are copied. SQL rewriting is confined to this test process.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadEnvConfig } from "@next/env";
import { createConnection, type RowDataPacket } from "mysql2/promise";
import { createUlid } from "../src/shared/database/ulid";

async function main() {
  loadEnvConfig(process.cwd());
  const prefix = `vg_${Date.now()}_`;
  assert.match(prefix, /^vg_\d+_$/);
  const admin = await createConnection({ uri: process.env.DATABASE_URL!, multipleStatements: true });
  const baseTables = [
    "accounts", "projects", "project_occupations", "blueprints", "blueprint_versions",
    "blueprint_nodes", "blueprint_version_sources", "system_settings", "model_connection_settings",
    "authoring_plans", "questions", "question_versions", "question_options",
    "question_assessment_points", "question_quality_checks", "question_status_events", "audit_logs", "outline_point_reviews",
  ];
  const jobTables = ["authoring_generation_jobs", "authoring_generation_batches", "authoring_generation_units", "authoring_generation_slots", "authoring_generation_capacity"];
  const tables = [...baseTables, ...jobTables];
  const tablePattern = new RegExp(`\\b(${tables.join("|")})\\b`, "g");
  const rewrite = (sql: string) => sql.replace(tablePattern, (table) => `${prefix}${table}`);
  const rawQuery = admin.query.bind(admin);
  const originalFetch = globalThis.fetch;
  try {
    for (const table of baseTables) {
      await rawQuery(`CREATE TABLE \`${prefix}${table}\` LIKE \`${table}\``);
    }
    let constraint = 0;
    const migration = rewrite(await readFile(join(process.cwd(), "database/migrations/0009_authoring_generation_jobs.sql"), "utf8"))
      .replace(/CONSTRAINT \w+/g, () => `CONSTRAINT ${prefix}c${++constraint}`);
    await rawQuery(migration);
    await rawQuery(rewrite(await readFile(join(process.cwd(), "database/migrations/0010_authoring_mixed_requests.sql"), "utf8")));
    const execute = admin.execute.bind(admin);
    admin.execute = ((sql: string, values?: Parameters<typeof admin.execute>[1]) => execute(rewrite(sql), values)) as typeof admin.execute;
    process.env.AUTHORING_GENERATION_WORKER_DISABLED = "1";
    const { getPool } = await import("../src/shared/database/mysql");
    const pool = getPool();
    pool.on("connection", (connection) => {
      connection.query("SET SESSION sql_mode = CONCAT_WS(',', @@SESSION.sql_mode, 'ONLY_FULL_GROUP_BY')");
    });
    const poolExecute = pool.execute.bind(pool);
    pool.execute = ((sql: string, values?: Parameters<typeof pool.execute>[1]) => poolExecute(rewrite(sql), values)) as typeof pool.execute;
    const getConnection = pool.getConnection.bind(pool);
    pool.getConnection = async () => {
      const connection = await getConnection();
      const marked = connection as typeof connection & { __verificationWrapped?: boolean };
      if (!marked.__verificationWrapped) {
        const connectionExecute = connection.execute.bind(connection);
        connection.execute = ((sql: string, values?: Parameters<typeof connection.execute>[1]) => connectionExecute(rewrite(sql), values)) as typeof connection.execute;
        marked.__verificationWrapped = true;
      }
      return connection;
    };
    const { startGeneration, runGenerationTick, getGenerationState } = await import("../src/modules/authoring/generation/service");
    const { getPlanQuestionRows } = await import("../src/modules/authoring/generation/results");
    const [modes] = await pool.execute<(RowDataPacket & { mode: string })[]>("SELECT @@SESSION.sql_mode AS mode");
    assert.ok(modes[0].mode.split(",").includes("ONLY_FULL_GROUP_BY"));
    const actorId = createUlid(), projectId = createUlid(), occupationId = createUlid();
    const outlineId = createUlid(), weightId = createUlid(), planId = createUlid();
    await admin.execute("INSERT INTO accounts(id,username,display_name,role,password_hash) VALUES(?,?,?,'admin',?)", [actorId, "verify", "测试管理员", "not-a-login-password"]);
    await admin.execute("INSERT INTO projects(id,code,name) VALUES(?,'verify','隔离测试项目')", [projectId]);
    await admin.execute("INSERT INTO project_occupations(id,project_id,code,name) VALUES(?,?,'verify','测试职业')", [occupationId, projectId]);
    for (const [kind, versionId] of [["theory_outline", outlineId], ["theory_weight", weightId]]) {
      const blueprintId = createUlid();
      await admin.execute("INSERT INTO blueprints(id,project_id,name,blueprint_kind,occupation_id,level_code,assessment_mode) VALUES(?,?,'测试蓝图',?,?,'level_4','theory')", [blueprintId, projectId, kind, occupationId]);
      await admin.execute("INSERT INTO blueprint_versions(id,blueprint_id,version_no,snapshot_json) VALUES(?,?,1,'{}')", [versionId, blueprintId]);
    }
    const points = Array.from({ length: 200 }, (_, index) => ({ code: `P-${index + 1}`, name: `规范知识${index + 1}`, single: 4, multiple: 0, judgement: 2, total: 6 }));
    for (const [index, point] of points.entries()) {
      const nodeId = createUlid();
      await admin.execute("INSERT INTO blueprint_nodes(id,blueprint_version_id,node_kind,node_code,name,ordinal) VALUES(?,?,'assessment_point',?,?,?)",
        [nodeId, outlineId, point.code, point.name, index + 1]);
      await admin.execute("INSERT INTO outline_point_reviews(node_id,status,reviewed_by,confirmed_by) VALUES(?,'confirmed',?,?)", [nodeId, actorId, actorId]);
    }
    const scope = { occupationId, occupation: "测试职业", levelCode: "level_4", assessmentMode: "理论知识",
      blueprintVersions: { outline: { id: outlineId, versionNo: 1 }, weights: { id: weightId, versionNo: 1 } } };
    await admin.execute("INSERT INTO authoring_plans(id,project_id,name,raw_requirement,scope_json,quota_json,status,created_by) VALUES(?,?,'隔离验证','测试1200题',?,?,'confirmed',?)",
      [planId, projectId, JSON.stringify(scope), JSON.stringify({ points, minimumTotal: 1200, qualityRequirements: [] }), actorId]);
    assert.deepEqual(await getPlanQuestionRows(planId), []);
    assert.deepEqual(await getPlanQuestionRows(createUlid()), []);
    await admin.execute("INSERT INTO model_connection_settings(id,provider,base_url,model_name,api_key) VALUES(1,'mock','https://mock.invalid/v1','mock','not-a-real-key')");
    let fail = true;
    let calls = 0;
    let holdNext = false;
    let releaseHeld = () => {};
    let notifyHeld = () => {};
    let blockedCalls = 0;
    let blockTwo = false;
    let releaseTwo = () => {};
    let notifyTwo = () => {};
    const twoStarted = new Promise<void>((resolve) => { notifyTwo = resolve; });
    const twoRelease = new Promise<void>((resolve) => { releaseTwo = resolve; });
    const heldStarted = new Promise<void>((resolve) => { notifyHeld = resolve; });
    const heldRelease = new Promise<void>((resolve) => { releaseHeld = resolve; });
    globalThis.fetch = async (_, init) => {
      calls += 1;
      if (blockTwo) {
        blockedCalls += 1;
        if (blockedCalls === 2) notifyTwo();
        await twoRelease;
      }
      if (holdNext) {
        holdNext = false;
        notifyHeld();
        await heldRelease;
      }
      const request = JSON.parse(String(init?.body));
      const prompt = JSON.parse(request.messages[1].content);
      const code: string = prompt["考评点"].code;
      const quotas = prompt["本次题型配额"] as Record<string, number>;
      // Accept only half the first request for one unit. The second request must
      // ask for the missing count, not regenerate the previously saved records.
      const questions = Object.entries(quotas).flatMap(([type, count]) => {
        const size = code === "P-17" && type === "single" && fail ? 0
          : code === "P-3" && type === "single" && prompt["补齐次数"] === 1 ? 2 : count;
        return Array.from({ length: size }, (_, index) => ({
        assessmentPointCode: code, questionType: type,
        stem: `${code}范围${type}请求${prompt["补齐次数"]}知识规范${index + 1}应如何正确执行？`,
        options: type === "judgement" ? [] : ["A", "B", "C", "D"].map((key) => ({ key, content: `真实规范${key}` })),
        answers: [type === "judgement" ? "正确" : "A"], analysis: "按照知识范围规定的规范执行。",
        }));
      });
      return Response.json({ choices: [{ message: { content: JSON.stringify({ questions }) } }] });
    };
    const started = await startGeneration(planId, actorId);
    assert.equal(started.job?.target, 1200);
    assert.equal(started.job?.totalBatches, 13);
    const repeated = await startGeneration(planId, actorId);
    assert.equal(repeated.jobId, started.jobId);
    // An old worker returns after its lease was recovered by a new worker.
    // Only the new token may commit; the delayed response must be ignored.
    holdNext = true;
    const staleWorker = runGenerationTick();
    await heldStarted;
    await admin.execute(`UPDATE authoring_generation_units SET lease_until=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND)
      WHERE job_id=? AND status='running'`, [started.jobId]);
    assert.equal(await runGenerationTick(), true);
    releaseHeld();
    await staleWorker;
    assert.equal((await getGenerationState(planId)).job?.generated, 6);
    const initialResults = await getPlanQuestionRows(planId);
    assert.equal(initialResults.length, 6);
    assert.ok(initialResults.every((row) => row.point_name === points[0].name));
    blockTwo = true;
    const concurrentWorkers = [runGenerationTick(), runGenerationTick()];
    await twoStarted;
    assert.equal(await runGenerationTick(), false, "A third worker cannot exceed the database capacity.");
    const [active] = await admin.execute<(RowDataPacket & { count: number })[]>(
      "SELECT COUNT(*) AS count FROM authoring_generation_units WHERE status='running'",
    );
    assert.equal(Number(active[0].count), 2);
    blockTwo = false;
    releaseTwo();
    await Promise.all(concurrentWorkers);
    for (let iteration = 0; iteration < 450; iteration += 1) {
      await admin.execute("UPDATE authoring_generation_units SET next_attempt_at=UTC_TIMESTAMP(3) WHERE job_id=? AND status='queued'", [started.jobId]);
      if (!await runGenerationTick()) break;
    }
    const partial = await getGenerationState(planId);
    assert.equal(partial.job?.status, "partial");
    assert.equal(partial.job?.generated, 1196);
    assert.equal(partial.job?.failedUnits.length, 1);
    assert.equal(partial.job?.failedUnits[0].remaining, 4);
    assert.equal((await getPlanQuestionRows(planId)).length, 1196);
    const [before] = await admin.execute<(RowDataPacket & { id: string })[]>("SELECT id FROM questions ORDER BY id");
    fail = false;
    const callsBefore = calls;
    await startGeneration(planId, actorId, true);
    assert.equal(await runGenerationTick(), true);
    const complete = await getGenerationState(planId);
    assert.equal(complete.job?.status, "succeeded");
    assert.equal(complete.job?.generated, 1200);
    assert.equal(calls - callsBefore, 1);
    const [after] = await admin.execute<(RowDataPacket & { id: string })[]>("SELECT id FROM questions ORDER BY id");
    assert.ok(before.every((question) => after.some((current) => current.id === question.id)));
    const [counts] = await admin.execute<(RowDataPacket & { slots: number; hashes: number; unique_questions: number })[]>(
      "SELECT COUNT(question_id) AS slots,COUNT(DISTINCT stem_hash) AS hashes,COUNT(DISTINCT question_id) AS unique_questions FROM authoring_generation_slots WHERE job_id=?", [started.jobId]);
    assert.deepEqual([Number(counts[0].slots), Number(counts[0].hashes), Number(counts[0].unique_questions)], [1200, 1200, 1200]);
    const results = await getPlanQuestionRows(planId);
    assert.equal(results.length, 1200);
    assert.equal(new Set(results.map((row) => row.id)).size, 1200);
    // Extra point associations and historical versions must not duplicate a
    // question or replace the currently selected version in the result list.
    await admin.execute(`INSERT INTO question_assessment_points(question_version_id,blueprint_node_id)
      SELECT q.current_version_id,bn.id FROM questions q JOIN blueprint_nodes bn ON bn.node_code='P-2'
      WHERE q.id=?`, [results[0].id]);
    await admin.execute(`INSERT INTO question_versions
      (id,question_id,version_no,stem,content_json,answer_json,source_snapshot_json,content_hash)
      SELECT ?,question_id,2,'历史版本不应展示',content_json,answer_json,source_snapshot_json,?
      FROM question_versions WHERE question_id=? AND version_no=1`,
      [createUlid(), "a".repeat(64), results[0].id]);
    const withHistory = await getPlanQuestionRows(planId);
    assert.equal(withHistory.length, 1200);
    assert.equal(withHistory[0].stem, results[0].stem);
    assert.equal(withHistory[0].point_name, [points[0].name, points[1].name].sort()[0]);
    await admin.execute(`DELETE qap FROM question_assessment_points qap
      JOIN questions q ON q.current_version_id=qap.question_version_id WHERE q.id=?`, [results[0].id]);
    const withoutPoint = await getPlanQuestionRows(planId);
    assert.equal(withoutPoint.length, 1200);
    assert.equal(withoutPoint[0].point_name, null);
    await startGeneration(planId, actorId);
    assert.equal(await runGenerationTick(), false);
    console.info("隔离验证通过：1200题/13批、部分保存、失败后继续、仅补失败4题、重复启动幂等、过期租约恢复、旧令牌迟到结果拦截、1200个唯一题目。");
    console.info("成果读取验证通过：ONLY_FULL_GROUP_BY、空计划、执行中草稿、多考评点关联、历史版本隔离、无考评点关联。");
    console.info("并发验证通过：两路同时执行、第三路被数据库全局容量拒绝、混合题型按槽位配额保存。");
  } finally {
    globalThis.fetch = originalFetch;
    if (globalThis.__itembankMysqlPool) await globalThis.__itembankMysqlPool.end();
    for (const table of tables.slice().reverse()) {
      await rawQuery(`DROP TABLE IF EXISTS \`${prefix}${table}\``);
    }
    await admin.end();
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
