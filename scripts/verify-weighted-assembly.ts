// All writes target disposable, uniquely prefixed tables. Real business rows
// and account credentials are never copied or changed.
import assert from "node:assert/strict";
import { loadEnvConfig } from "@next/env";
import { createConnection, type RowDataPacket } from "mysql2/promise";
import { createUlid } from "../src/shared/database/ulid";

async function main() {
  loadEnvConfig(process.cwd());
  const prefix = `wa_${Date.now()}_`;
  const tables = [
    "accounts", "projects", "project_occupations", "blueprints", "blueprint_versions", "blueprint_nodes",
    "questions", "question_versions", "question_assessment_points", "paper_structures", "paper_structure_versions",
    "paper_structure_sections", "assembly_plans", "assembly_plan_versions", "assembly_plan_slots", "assembly_runs",
    "papers", "paper_items", "paper_item_points", "audit_logs",
  ];
  const admin = await createConnection({ uri: process.env.DATABASE_URL! });
  const rawQuery = admin.query.bind(admin);
  const pattern = new RegExp(`\\b(${tables.join("|")})\\b`, "g");
  const rewrite = (sql: string) => sql.replace(pattern, (table) => `${prefix}${table}`);
  let failSave = false;
  const { getPool, withTransaction } = await import("../src/shared/database/mysql");
  const pool = getPool();
  try {
    for (const table of tables) await rawQuery(`CREATE TABLE \`${prefix}${table}\` LIKE \`${table}\``);
    const execute = admin.execute.bind(admin);
    admin.execute = ((sql: string, values?: Parameters<typeof admin.execute>[1]) => execute(rewrite(sql), values)) as typeof admin.execute;
    const getConnection = pool.getConnection.bind(pool);
    pool.getConnection = async () => {
      const db = await getConnection();
      const marked = db as typeof db & { __weightedTest?: boolean };
      if (!marked.__weightedTest) {
        const original = db.execute.bind(db);
        db.execute = ((sql: string, values?: Parameters<typeof db.execute>[1]) => {
          if (failSave && /INSERT INTO paper_items/.test(sql)) throw new Error("隔离测试：模拟题目保存失败");
          return original(rewrite(sql), values);
        }) as typeof db.execute;
        marked.__weightedTest = true;
      }
      return db;
    };
    const { executeWeightedAssembly, previewWeightedAssembly, confirmWeightedAdjustment } = await import("../src/modules/assembly/weighted-service");
    const { loadWeightBasis } = await import("../src/modules/assembly/weight-basis");
    const actor = createUlid(), project = createUlid(), occupation = createUlid();
    await admin.execute("INSERT INTO accounts(id,username,display_name,role,password_hash) VALUES(?,'weighted-test','隔离管理员','admin','not-a-password')", [actor]);
    await admin.execute("INSERT INTO projects(id,code,name) VALUES(?,'weighted-test','隔离项目')", [project]);
    await admin.execute("INSERT INTO project_occupations(id,project_id,code,name) VALUES(?,?,'weighted-test','隔离职业')", [occupation, project]);
    const count = async (table: string) => {
      const [rows] = await admin.execute<(RowDataPacket & { total: number })[]>(`SELECT COUNT(*) AS total FROM ${table}`);
      return Number(rows[0].total);
    };
    const seedBlueprint = async (mode: string, kind: string, snapshot: object) => {
      const blueprint = createUlid(), version = createUlid();
      await admin.execute("INSERT INTO blueprints(id,project_id,name,blueprint_kind,occupation_id,level_code,assessment_mode,current_version_id) VALUES(?,?,'隔离蓝图',?,?,'level_4',?,?)",
        [blueprint, project, kind, occupation, mode, version]);
      await admin.execute("INSERT INTO blueprint_versions(id,blueprint_id,version_no,status,snapshot_json) VALUES(?,?,1,'published',?)", [version, blueprint, JSON.stringify(snapshot)]);
      return { blueprint, version };
    };
    const seedPoint = async (version: string, code: string, requirement: object) => {
      const node = createUlid();
      await admin.execute("INSERT INTO blueprint_nodes(id,blueprint_version_id,node_kind,node_code,name,ordinal,requirement_json) VALUES(?,?,'assessment_point',?,?,1,?)",
        [node, version, code, code, JSON.stringify(requirement)]);
      return node;
    };
    const seedQuestion = async (mode: string, nodes: string[], type: string, status = "stored") => {
      const question = createUlid(), version = createUlid();
      const rubric = type === "实操题" ? { totalScore: 100, criteria: [{ item: "完成操作", score: 100, standard: "按要求完成完整工作过程" }] } : null;
      await admin.execute("INSERT INTO questions(id,project_id,question_no,occupation_id,level_code,assessment_mode,question_type,current_version_id,current_status) VALUES(?,?,?,?,'level_4',?,?,?,?)",
        [question, project, question, occupation, mode, type, version, status]);
      await admin.execute("INSERT INTO question_versions(id,question_id,version_no,stem,content_json,answer_json,score_rubric_json,source_snapshot_json,content_hash) VALUES(?,?,1,'隔离题干','{}','{}',?,'{}',SHA2(?,256))",
        [version, question, rubric ? JSON.stringify(rubric) : null, version]);
      for (const node of nodes) await admin.execute("INSERT INTO question_assessment_points(question_version_id,blueprint_node_id) VALUES(?,?)", [version, node]);
      return question;
    };
    const seedPlan = async (mode: string, sections: Array<{ type: string; count: number; score: number }>, paperCount: number) => {
      const structure = createUlid(), structureVersion = createUlid(), plan = createUlid(), planVersion = createUlid();
      await admin.execute("INSERT INTO paper_structures(id,project_id,name,occupation_id,level_code,assessment_mode,current_version_id,status) VALUES(?,?,'隔离结构',?,'level_4',?,?,'published')",
        [structure, project, occupation, mode, structureVersion]);
      await admin.execute("INSERT INTO paper_structure_versions(id,paper_structure_id,version_no,template_code,duration_minutes,total_items,total_score,snapshot_json) VALUES(?,?,1,'standard',90,?,100,'{}')",
        [structureVersion, structure, sections.reduce((sum, item) => sum + item.count, 0)]);
      for (const [index, section] of sections.entries()) await admin.execute("INSERT INTO paper_structure_sections(id,paper_structure_version_id,section_no,question_type,item_count,score_per_item,section_score,ordering) VALUES(?,?,?,?,?,?,?,?)",
        [createUlid(), structureVersion, index + 1, section.type, section.count, section.score, section.count * section.score, index + 1]);
      await admin.execute("INSERT INTO assembly_plans(id,project_id,name,occupation_id,level_code,assessment_mode,current_version_id) VALUES(?,?,'隔离计划',?,'level_4',?,?)",
        [plan, project, occupation, mode, planVersion]);
      await admin.execute("INSERT INTO assembly_plan_versions(id,assembly_plan_id,version_no,paper_structure_version_id,candidate_filter_json,snapshot_json) VALUES(?,?,1,?,'{}',?)",
        [planVersion, plan, structureVersion, JSON.stringify({ paperCount })]);
      return { plan, planVersion, structure, structureVersion };
    };

    const skillWeights = await seedBlueprint("skill", "theory_weight", {
      columns: [{ key: "level_4", levelCode: "level_4", direction: "通用" }],
      items: ["募集管理", "捐赠管理"].map((name, index) => ({ name, weights: { level_4: index ? 70 : 30 }, columnWeights: { level_4: index ? 70 : 30 } })),
    });
    const skillOutline = await seedBlueprint("skill", "skill_outline", {});
    const a = await seedPoint(skillOutline.version, "A", { direction: "通用", sourceStandardRequirement: { functionName: "募集管理" } });
    const b = await seedPoint(skillOutline.version, "B", { direction: "通用", sourceStandardRequirement: { functionName: "捐赠管理" } });
    for (let i = 0; i < 4; i++) {
      await seedQuestion("skill", [a], "实操题");
      await seedQuestion("skill", [b], "实操题");
    }
    await seedQuestion("skill", [a, b], "实操题");
    await seedQuestion("skill", [], "实操题");
    await seedQuestion("skill", [a], "实操题", "pending_review");
    const skillPlan = await seedPlan("skill", [{ type: "实操题", count: 1, score: 100 }], 2);
    const preview = await withTransaction((db) => previewWeightedAssembly(db, skillPlan.plan));
    assert.equal(preview.valid, false);
    assert.equal(preview.excluded, 2);
    assert.deepEqual(preview.suggestion?.map((row) => row.scorePerItem), [30, 70]);
    assert.equal(await count("paper_structures"), 1, "预览不能写入结构");
    const blocked = await withTransaction((db) => executeWeightedAssembly(db, skillPlan.plan, actor));
    assert.equal(blocked.executed, false);
    assert.equal(await count("papers"), 0);
    await seedQuestion("skill", [a], "实操题");
    await assert.rejects(withTransaction((db) => confirmWeightedAdjustment(db, skillPlan.plan, actor, preview.fingerprint)), /已变化/);
    const latest = await withTransaction((db) => previewWeightedAssembly(db, skillPlan.plan));
    const adjusted = await withTransaction((db) => confirmWeightedAdjustment(db, skillPlan.plan, actor, latest.fingerprint));
    assert.equal(adjusted.adjusted, true);
    assert.equal(await count("papers"), 0, "确认结构不能偷偷执行组卷");
    assert.equal(await count("paper_structures"), 2, "旧结构必须保留");
    assert.equal(await count("assembly_plan_versions"), 2);
    const result = await withTransaction((db) => executeWeightedAssembly(db, skillPlan.plan, actor));
    assert.equal(result.executed, true);
    const [paperScores] = await admin.execute<(RowDataPacket & { paper_id: string; rangeName: string; total: string })[]>(
      `SELECT paper_id,JSON_UNQUOTE(JSON_EXTRACT(content_snapshot_json,'$.assemblyWeightRange.name')) AS rangeName,SUM(score) AS total
       FROM paper_items GROUP BY paper_id,rangeName ORDER BY paper_id,rangeName`);
    assert.equal(paperScores.length, 4);
    for (const row of paperScores) assert.equal(Number(row.total), row.rangeName === "募集管理" ? 30 : 70);
    const [unique] = await admin.execute<(RowDataPacket & { total: number; uniqueCount: number })[]>(
      "SELECT COUNT(*) total,COUNT(DISTINCT question_id) uniqueCount FROM paper_items");
    assert.equal(unique[0].total, unique[0].uniqueCount, "同次多套不可重复试题");
    const [rubrics] = await admin.execute<(RowDataPacket & { rubric: string; score: string })[]>(
      "SELECT score_rubric_snapshot_json AS rubric,score FROM paper_items");
    for (const row of rubrics) assert.equal(JSON.parse(typeof row.rubric === "string" ? row.rubric : JSON.stringify(row.rubric)).totalScore, Number(row.score));
    const [summary] = await admin.execute<(RowDataPacket & { summary: unknown })[]>(
      "SELECT selection_summary_json AS summary FROM assembly_runs WHERE status='succeeded'");
    assert.equal(summary.length, 2);
    assert.ok(JSON.stringify(summary).includes(skillWeights.version), "每套必须保存权重版本");
    assert.ok(JSON.stringify(summary).includes("skill_sample_v1"), "每套必须冻结操作技能样式版本");
    const [presentations] = await admin.execute<(RowDataPacket & { content: unknown })[]>(
      "SELECT content_snapshot_json AS content FROM paper_items");
    for (const row of presentations) {
      const content = typeof row.content === "string" ? JSON.parse(row.content) : row.content;
      assert.ok(content.assemblyPresentation.evaluationPoint, "题目必须保存评价点名称用于样例排版");
    }
    assert.equal(await count("paper_item_points"), 4);
    const beforePapers = await count("papers"), beforeRuns = await count("assembly_runs");
    failSave = true;
    await assert.rejects(withTransaction((db) => executeWeightedAssembly(db, skillPlan.plan, actor)), /模拟题目保存失败/);
    failSave = false;
    assert.equal(await count("papers"), beforePapers, "保存失败整次回滚");
    assert.equal(await count("assembly_runs"), beforeRuns);
    await withTransaction((db) => executeWeightedAssembly(db, skillPlan.plan, actor));
    assert.equal(await count("papers"), 4, "重复组卷保留新旧成果");

    await seedBlueprint("theory", "theory_weight", {
      scopes: [{ directionId: null, directionName: "隔离职业", items: [
        { category: "基本要求", name: "基础知识", weights: { level_4: 25 } },
        { category: "相关知识要求", name: "捐赠管理", weights: { level_4: 75 } },
      ] }],
    });
    const theoryOutline = await seedBlueprint("theory", "theory_outline", {});
    const basic = await seedPoint(theoryOutline.version, "T-A", { sectionKind: "basic", secondaryName: "基础知识" });
    const related = await seedPoint(theoryOutline.version, "T-B", { sectionKind: "related_knowledge", standardSource: { functionName: "捐赠管理" } });
    for (let i = 0; i < 5; i++) {
      await seedQuestion("theory", [basic], "单项选择题");
      await seedQuestion("theory", [related], "B 单项选择题");
    }
    const theoryPlan = await seedPlan("theory", [{ type: "B 单项选择题", count: 4, score: 25 }], 1);
    const theoryResult = await withTransaction((db) => executeWeightedAssembly(db, theoryPlan.plan, actor));
    assert.equal(theoryResult.executed, true);
    const [theorySummary] = await admin.execute<(RowDataPacket & { summary: unknown })[]>(
      "SELECT selection_summary_json AS summary FROM assembly_runs WHERE assembly_plan_version_id=?", [theoryPlan.planVersion]);
    assert.ok(JSON.stringify(theorySummary).includes("theory_sample_v1"), "理论卷必须使用理论样例，而不是技能模板");
    assert.equal(await count("papers"), 5);
    await admin.execute("UPDATE blueprint_versions SET snapshot_json=? WHERE id=?", [JSON.stringify({
      columns: [{ key: "x", levelCode: "level_4", direction: "普通车床" }, { key: "y", levelCode: "level_4", direction: "数控车床" }],
      items: [{ name: "募集管理", weights: { level_4: 100 }, columnWeights: { x: 100, y: 100 } }],
    }), skillWeights.version]);
    const scope = { project_id: project, occupation_id: occupation, level_code: "level_4", assessment_mode: "skill" };
    await assert.rejects(withTransaction((db) => loadWeightBasis(db, scope)), /唯一职业方向/);
    const selectedDirection = await withTransaction((db) => loadWeightBasis(db, scope, "数控车床"));
    assert.equal(selectedDirection.direction, "数控车床");
    console.log("隔离验证通过：理论/技能严格配分、缺额阻止、调整确认、过期建议拒绝、多套去重、评分换算、版本保留、失败回滚、方向隔离。未改动业务数据。");
  } finally {
    await pool.end();
    for (const table of [...tables].reverse()) await rawQuery(`DROP TABLE IF EXISTS \`${prefix}${table}\``);
    await admin.end();
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
