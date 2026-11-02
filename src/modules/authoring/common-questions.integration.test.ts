import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import mysql, { type RowDataPacket } from "mysql2/promise";
import { createUlid } from "@/shared/database/ulid";
import { getPool, withTransaction } from "@/shared/database/mysql";
import { adoptCommonQuestions, commonPlanProgress, commonPlanQuota, commonQuestionAction, configureCommonGroup,
  createCommonGroup, getCommonGroup, prepareCommonGeneration, publishCommonGroup } from "./common-questions";
import { commonLevels, commonQuotaPoints, decodeCommon, formalQuestionSource } from "./common-question-policy";
import { prefillCommonSlots } from "./common-generation";
import { loadWeightedQuestions } from "@/modules/assembly/weight-basis";
import { terminateGeneration } from "./generation/termination";

// Explicit opt-in. Copy schema only, never business rows, and remove only the
// freshly created test database. The configured source database is read-only.
test("隔离MySQL：选用旧题、发布共用、修订保旧版、统一停用及跨计划槽位复用", {
  skip: process.env.COMMON_QUESTIONS_DB_TEST !== "1", timeout: 90000,
}, async () => {
  const original = process.env.DATABASE_URL!;
  const source = new URL(original);
  assert.ok(["127.0.0.1", "localhost"].includes(source.hostname), "只允许使用本机结构作为测试模板");
  const sourceName = source.pathname.slice(1);
  assert.match(sourceName, /^[a-zA-Z0-9_]+$/);
  const name = `itembank_common_test_${process.pid}_${Date.now()}`;
  const admin = await mysql.createConnection(original);
  let created = false;
  try {
    await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    created = true;
    const [tables] = await admin.query<RowDataPacket[]>(
      "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE'", [sourceName]);
    for (const table of tables) if (!String(table.name).startsWith("common_question_")) {
      assert.match(table.name, /^[a-zA-Z0-9_]+$/);
      await admin.query(`CREATE TABLE \`${name}\`.\`${table.name}\` LIKE \`${sourceName}\`.\`${table.name}\``);
    }
    source.pathname = `/${name}`;
    process.env.DATABASE_URL = source.toString();
    const db = await mysql.createConnection({ uri: source.toString(), multipleStatements: true });
    try {
      const [indexes] = await db.query<RowDataPacket[]>("SHOW INDEX FROM authoring_generation_slots WHERE Key_name='uk_ags_question'");
      if (!indexes.length) {
        await db.query("ALTER TABLE authoring_generation_slots DROP INDEX uk_ags_job_question, DROP INDEX idx_ags_question, ADD UNIQUE KEY uk_ags_question(question_id)");
      }
      await db.query(await readFile("database/migrations/0022_common_theory_questions.sql", "utf8"));
      await db.execute("INSERT INTO authoring_generation_capacity(id) VALUES(1)");
      const actor = createUlid(), project = createUlid(), occupation = createUlid();
      await db.execute("INSERT INTO accounts(id,username,display_name,role,password_hash) VALUES(?,?,'测试管理员','admin','not-a-login')", [actor, actor]);
      await db.execute("INSERT INTO projects(id,code,name) VALUES(?,?,'公共题组隔离测试')", [project, project]);
      await db.execute("INSERT INTO project_occupations(id,project_id,code,name) VALUES(?,?,?,'测试职业')", [occupation, project, occupation]);
      const nodes: Record<string, string> = {};
      async function blueprint(kind: string, level: string) {
        const id = createUlid(), version = createUlid();
        await db.execute(`INSERT INTO blueprints(id,project_id,name,blueprint_kind,occupation_id,level_code,assessment_mode,current_version_id)
          VALUES(?,?,'测试蓝图',?,?,?,'theory',?)`, [id, project, kind, occupation, level, version]);
        await db.execute("INSERT INTO blueprint_versions(id,blueprint_id,version_no,status,snapshot_json) VALUES(?,?,1,'published','{}')", [version, id]);
        return version;
      }
      await blueprint("theory_weight", "level_5");
      for (const level of commonLevels) {
        const version = await blueprint("theory_outline", level), id = createUlid();
        nodes[level] = id;
        await db.execute(`INSERT INTO blueprint_nodes(id,blueprint_version_id,node_kind,node_code,name,ordinal,requirement_json,source_ref_json)
          VALUES(?,?,'assessment_point',?,'职业道德要求',1,?,?)`, [id, version, `${level}-A-001`,
          JSON.stringify({ sectionKind: "basic", primaryName: "基本要求", secondaryName: "职业道德", sharedPointKey: "test:standard:2.1:point" }),
          JSON.stringify({ chapterIds: [], standardBasic: { evidence: "职业道德要求原文" } })]);
        await db.execute("INSERT INTO outline_point_reviews(node_id,status) VALUES(?,'confirmed')", [id]);
      }
      const group = await createCommonGroup(occupation, actor);
      await assert.rejects(createCommonGroup(occupation, actor), /已有公共题组/);
      let detail = await getCommonGroup(group.id, 1);
      const key = detail.basis.points[0].key, quota = [{ key, single: 1, multiple: 0, judgement: 0 }];
      assert.equal(detail.quota[0].judgement, 0, "新公共题组不配置判断题");
      const oldPlan = createUlid(), oldJob = createUlid();
      await db.execute("INSERT INTO authoring_plans(id,project_id,name,raw_requirement,scope_json,quota_json,status) VALUES(?,?,'历史公共任务','测试','{}','{}','confirmed')", [oldPlan, project]);
      await db.execute("INSERT INTO authoring_generation_jobs(id,plan_id,snapshot_json,target_count,status) VALUES(?,?,'{}',8,'cancelled')", [oldJob, oldPlan]);
      await db.execute("UPDATE common_question_groups SET quota_json=?,generation_plan_id=? WHERE id=?",
        [JSON.stringify([{ key, single: 4, multiple: 2, judgement: 2 }]), oldPlan, group.id]);
      const choicePlan = await prepareCommonGeneration(group.id, actor);
      assert.notEqual(choicePlan, oldPlan);
      const [newPlans] = await db.query<RowDataPacket[]>("SELECT quota_json FROM authoring_plans WHERE id=?", [choicePlan]);
      const newQuota = decodeCommon<{ minimumTotal: number; points: Array<{ judgement: number }> }>(newPlans[0].quota_json);
      assert.equal(newQuota.minimumTotal, 6);
      assert.equal(newQuota.points[0].judgement, 0);
      const [oldJobs] = await db.query<RowDataPacket[]>("SELECT target_count,status FROM authoring_generation_jobs WHERE id=?", [oldJob]);
      assert.equal(oldJobs[0].target_count, 8);
      assert.equal(oldJobs[0].status, "cancelled");
      detail = await getCommonGroup(group.id, 1);
      await configureCommonGroup(group.id, quota, detail.rowVersion, actor);
      const question = createUlid(), version = createUlid();
      await db.execute(`INSERT INTO questions(id,project_id,question_no,occupation_id,level_code,assessment_mode,question_type,current_version_id,current_status)
        VALUES(?,?,?,?,'level_5','theory','单项选择题',?,'stored')`, [question, project, question, occupation, version]);
      await db.execute(`INSERT INTO question_versions(id,question_id,version_no,stem,content_json,answer_json,analysis_text,source_snapshot_json,content_hash,created_by)
        VALUES(?,?,1,'测试职业道德题干','{"options":[{"key":"A","content":"选项甲"},{"key":"B","content":"选项乙"}]}',
          '{"answers":["A"]}','原版解析','{}',?,?)`, [version, question, "a".repeat(64), actor]);
      await db.execute("INSERT INTO question_assessment_points(question_version_id,blueprint_node_id) VALUES(?,?)", [version, nodes.level_5]);
      await db.execute("INSERT INTO question_review_confirmations(question_version_id,confirmed_by,opinion) VALUES(?,?,'测试已确认')", [version, actor]);
      await adoptCommonQuestions(group.id, [{ questionId: question, versionId: version }], actor);
      detail = await getCommonGroup(group.id, 1);
      assert.equal(detail.total, 1);
      assert.equal((await db.query<RowDataPacket[]>("SELECT level_code FROM questions WHERE id=?", [question]))[0][0].level_code, null);
      await assert.rejects(prepareCommonGeneration(group.id, actor), /无需重复生成/);
      const release = await publishCommonGroup(group.id, detail.rowVersion, actor);
      const [publicRows] = await db.query<RowDataPacket[]>(`SELECT * FROM ${formalQuestionSource} q WHERE q.current_status='stored'`);
      assert.equal(publicRows.length, 3);
      assert.equal(new Set(publicRows.map((row) => row.id)).size, 1);
      assert.deepEqual(publicRows.map((row) => row.level_code).sort(), [...commonLevels].sort());
      assert.ok(publicRows.every((row) => row.current_version_id === version));
      for (const level of commonLevels) {
        const weighted = await withTransaction((connection) => loadWeightedQuestions(connection,
          { project_id: project, occupation_id: occupation, level_code: level, assessment_mode: "theory" },
          { versionId: "test", versionNo: 1, direction: "通用",
            ranges: [{ category: "基本要求", name: "职业道德", key: "基本要求:职业道德", weight: 100 }] }));
        assert.equal(weighted.questions.length, 1);
        assert.equal(weighted.questions[0].versionId, version);
        assert.deepEqual(weighted.questions[0].nodeIds, [nodes[level]]);
        assert.equal(weighted.questions[0].commonReleaseId, release.releaseId);
      }
      const plan = createUlid();
      await db.execute("INSERT INTO authoring_plans(id,project_id,name,raw_requirement,scope_json,quota_json,status) VALUES(?,?,'等级计划','测试','{}','{}','confirmed')", [plan, project]);
      await withTransaction(async (connection) => {
        const [rows] = await connection.query<RowDataPacket[]>("SELECT * FROM blueprint_nodes WHERE id=?", [nodes.level_4]);
        const result = await commonPlanQuota(connection, detail.basis.scopes.level_4, rows as never,
          commonQuotaPoints(detail.basis.points, quota, "level_4"), plan);
        assert.equal(result!.groupId, group.id);
      });
      assert.equal((await commonPlanProgress(plan))!.ready, true);
      await commonQuestionAction(group.id, question, version, "reopen", "统一修订测试", actor);
      detail = await getCommonGroup(group.id, 1);
      const revisedQuestion = detail.questions[0] as unknown as { current_version_id: string; current_status: string };
      const newVersion = revisedQuestion.current_version_id;
      assert.notEqual(newVersion, version);
      assert.equal(revisedQuestion.current_status, "pending_review");
      await assert.rejects(publishCommonGroup(group.id, detail.rowVersion, actor), /尚未入库/);
      const [duringRevision] = await db.query<RowDataPacket[]>("SELECT current_version_id FROM common_published_questions");
      assert.ok(duringRevision.every((row) => row.current_version_id === version));
      await db.execute("UPDATE questions SET current_status='stored' WHERE id=?", [question]);
      await db.execute("INSERT INTO question_review_confirmations(question_version_id,confirmed_by,opinion) VALUES(?,?,'测试新版本确认')", [newVersion, actor]);
      const second = await publishCommonGroup(group.id, detail.rowVersion, actor);
      assert.equal(second.versionNo, 2);
      const [history] = await db.query<RowDataPacket[]>("SELECT question_version_id FROM common_question_release_items WHERE release_id=?", [release.releaseId]);
      assert.equal(history[0].question_version_id, version);
      await commonQuestionAction(group.id, question, newVersion, "suspend", "错误题统一停用测试", actor);
      assert.equal((await db.query<RowDataPacket[]>("SELECT * FROM common_published_questions"))[0].length, 0);
      assert.equal((await commonPlanProgress(plan))!.ready, false);
      const generatedPlans = await Promise.all([prepareCommonGeneration(group.id, actor), prepareCommonGeneration(group.id, actor)]);
      assert.equal(generatedPlans[0], generatedPlans[1], "并发只能创建一个公共任务计划");
      // A reference slot may be reused by later public plans without deleting
      // the old slot or resetting the original generation attempt history.
      await db.execute("UPDATE common_question_members SET suspended=0 WHERE question_id=?", [question]);
      const testPlans: string[] = [];
      for (let index = 0; index < 2; index++) {
        const p = createUlid(), job = createUlid(), batch = createUlid(), unit = createUlid();
        testPlans.push(p);
        await db.execute("INSERT INTO authoring_plans(id,project_id,name,raw_requirement,scope_json,quota_json,status) VALUES(?,?,'测试公共引用','测试','{}','{}','confirmed')", [p, project]);
        await db.execute("INSERT INTO authoring_generation_jobs(id,plan_id,snapshot_json,target_count) VALUES(?,?,'{}',1)", [job, p]);
        await db.execute("INSERT INTO authoring_generation_batches(id,job_id,ordinal,target_count) VALUES(?,?,1,1)", [batch, job]);
        await db.execute("INSERT INTO authoring_generation_units(id,job_id,batch_id,ordinal,point_code,question_type) VALUES(?,?,?,1,'level_5-A-001','single')", [unit, job, batch]);
        await db.execute("INSERT INTO authoring_generation_slots(id,job_id,unit_id,ordinal,question_type) VALUES(?,?,?,1,'single')", [createUlid(), job, unit]);
        await withTransaction((connection) => prefillCommonSlots(connection, group.id, job));
      }
      const [slots] = await db.query<RowDataPacket[]>("SELECT * FROM authoring_generation_slots WHERE question_id=?", [question]);
      assert.equal(slots.length, 2);
      await terminateGeneration(testPlans[0], actor);
      assert.equal((await db.query<RowDataPacket[]>("SELECT id FROM questions WHERE id=?", [question]))[0].length, 1,
        "终止引用任务不能删除公共已选用题目");
      const storedBasis = decodeCommon(detail.basis);
      assert.ok(storedBasis);
    } finally { await db.end(); }
  } finally {
    if (globalThis.__itembankMysqlPool) { await getPool().end(); globalThis.__itembankMysqlPool = undefined; }
    process.env.DATABASE_URL = original;
    if (created) await admin.query(`DROP DATABASE \`${name}\``);
    await admin.end();
  }
});
