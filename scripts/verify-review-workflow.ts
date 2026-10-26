import assert from "node:assert/strict";
import { loadEnvConfig } from "@next/env";
import { createConnection } from "mysql2/promise";
import { createUlid } from "../src/shared/database/ulid";

async function main() {
  loadEnvConfig(process.cwd());
  const prefix = `vr_${Date.now()}_`;
  const tables = ["accounts", "projects", "project_occupations", "blueprints", "blueprint_versions", "blueprint_nodes",
    "outline_point_reviews", "questions", "question_versions", "question_options", "question_assessment_points",
    "question_source_refs", "question_revision_links", "question_status_events", "review_assignments", "review_records", "audit_logs", "question_review_confirmations"];
  const admin = await createConnection(process.env.DATABASE_URL!);
  const rewrite = (sql: string) => sql.replace(new RegExp(`\\b(${tables.join("|")})\\b`, "g"), (name) => `${prefix}${name}`);
  const raw = admin.query.bind(admin);
  const originalExecute = admin.execute.bind(admin);
  let role: "admin" | "expert" = "admin";
  const actor = createUlid(), expert = createUlid(), otherExpert = createUlid();
  // Only this isolated test process substitutes auth. No real HTTP authorization
  // or application process is modified.
  const authPath = require.resolve("../src/auth");
  const previousAuth = require.cache[authPath];
  require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: {
    getVerifiedSession: async () => ({ user: { id: role === "admin" ? actor : expert, role } }),
  } } as NonNullable<typeof previousAuth>;
  try {
    for (const table of tables) await raw(`CREATE TABLE \`${prefix}${table}\` LIKE \`${table}\``);
    admin.execute = ((sql: string, values?: Parameters<typeof admin.execute>[1]) => originalExecute(rewrite(sql), values)) as typeof admin.execute;
    const { getPool, withTransaction } = await import("../src/shared/database/mysql");
    const pool = getPool();
    const execute = pool.execute.bind(pool);
    pool.execute = ((sql: string, values?: Parameters<typeof pool.execute>[1]) => execute(rewrite(sql), values)) as typeof pool.execute;
    const connect = pool.getConnection.bind(pool);
    pool.getConnection = async () => {
      const connection = await connect();
      const wrapped = connection as typeof connection & { wrappedReviewTest?: boolean };
      if (!wrapped.wrappedReviewTest) {
        const execute = connection.execute.bind(connection);
        connection.execute = ((sql: string, values?: Parameters<typeof connection.execute>[1]) => execute(rewrite(sql), values)) as typeof connection.execute;
        wrapped.wrappedReviewTest = true;
      }
      return connection;
    };
    const { actOnOutline, assertOutlineConfirmed, listOutlineReviews } = await import("../src/modules/blueprints/point-review");
    const { POST: questionAction } = await import("../src/app/api/v1/review/questions/route");
    const { PATCH: libraryStore } = await import("../src/app/api/v1/questions/route");
    const { GET: taskList, POST: assignQuestions } = await import("../src/app/api/v1/review/assignments/route");
    const { POST: assignOutlines } = await import("../src/app/api/v1/review/outlines/route");
    const { POST: expertAction, GET: expertTasks } = await import("../src/app/api/v1/expert/reviews/route");
    const project = createUlid(), occupation = createUlid(), blueprint = createUlid(), version = createUlid();
    const nodes = [createUlid(), createUlid()];
    for (const [id, accountRole] of [[actor, "admin"], [expert, "expert"], [otherExpert, "expert"]]) {
      await admin.execute("INSERT INTO accounts(id,username,display_name,role,password_hash) VALUES(?,?,?,?,?)", [id, id, accountRole, accountRole, "not-a-login-hash"]);
    }
    await admin.execute("INSERT INTO projects(id,code,name) VALUES(?,'verify','验证项目')", [project]);
    await admin.execute("INSERT INTO project_occupations(id,project_id,code,name) VALUES(?,?,'verify','验证职业')", [occupation, project]);
    await admin.execute("INSERT INTO blueprints(id,project_id,name,blueprint_kind,occupation_id,level_code,assessment_mode,current_version_id) VALUES(?,?,'验证细目表','theory_outline',?,'level_4','theory',?)", [blueprint, project, occupation, version]);
    await admin.execute("INSERT INTO blueprint_versions(id,blueprint_id,version_no,status,snapshot_json) VALUES(?,?,1,'published','{}')", [version, blueprint]);
    for (const [index, id] of nodes.entries()) await admin.execute("INSERT INTO blueprint_nodes(id,blueprint_version_id,node_kind,node_code,name,ordinal) VALUES(?,?,'assessment_point',?,?,?)", [id, version, `P${index}`, `有效规范${index}`, index]);
    assert.equal((await listOutlineReviews(actor, "admin")).length, 2);
    await assert.rejects(withTransaction((db) => assertOutlineConfirmed(db, version)));
    await assert.rejects(actOnOutline({ versionId: version, action: "confirm", opinion: "" }, actor, "admin"));
    await actOnOutline({ versionId: version, action: "assign", expertId: expert, opinion: "" }, actor, "admin");
    assert.equal((await listOutlineReviews(expert, "expert")).length, 2);
    await assert.rejects(actOnOutline({ versionId: version, nodeId: nodes[0], action: "approve", opinion: "通过" }, otherExpert, "expert"));
    await actOnOutline({ versionId: version, nodeId: nodes[0], action: "approve", opinion: "专家通过" }, expert, "expert");
    await assert.rejects(withTransaction((db) => assertOutlineConfirmed(db, version)));
    await assert.rejects(actOnOutline({ versionId: version, action: "approve", opinion: "管理员不得代审" }, actor, "admin"));
    await assert.rejects(actOnOutline({ versionId: version, action: "assign", expertId: otherExpert, opinion: "" }, actor, "admin"));
    await actOnOutline({ versionId: version, nodeId: nodes[1], action: "approve", opinion: "专家通过" }, expert, "expert");
    await assert.rejects(withTransaction((db) => assertOutlineConfirmed(db, version)));
    await actOnOutline({ versionId: version, action: "confirm", opinion: "" }, actor, "admin");
    await withTransaction((db) => assertOutlineConfirmed(db, version));
    assert.equal((await actOnOutline({ versionId: version, action: "confirm", opinion: "" }, actor, "admin")).changed, 0);
    const adminVersion = createUlid(), adminNode = createUlid();
    await admin.execute("INSERT INTO blueprint_versions(id,blueprint_id,version_no,status,snapshot_json) VALUES(?,?,2,'published','{}')", [adminVersion, blueprint]);
    await admin.execute("INSERT INTO blueprint_nodes(id,blueprint_version_id,node_kind,node_code,name,ordinal) VALUES(?,?,'assessment_point','ADMIN','管理员审核考评点',0)", [adminNode, adminVersion]);
    await actOnOutline({ versionId: adminVersion, action: "approve", opinion: "管理员审核通过" }, actor, "admin");
    await assert.rejects(actOnOutline({ versionId: adminVersion, action: "assign", expertId: expert, opinion: "" }, actor, "admin"));
    const freshVersion = createUlid(), freshNode = createUlid();
    await admin.execute("INSERT INTO blueprint_versions(id,blueprint_id,version_no,status,snapshot_json) VALUES(?,?,3,'published','{}')", [freshVersion, blueprint]);
    await admin.execute("INSERT INTO blueprint_nodes(id,blueprint_version_id,node_kind,node_code,name,ordinal) VALUES(?,?,'assessment_point','FRESH','未分配考评点',0)", [freshNode, freshVersion]);
    const batchResponse = await assignOutlines(new Request("http://localhost/api/v1/review/outlines", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ versionIds: [freshVersion, adminVersion], expertId: expert }) }));
    assert.equal(batchResponse.status, 422);
    const fresh = (await listOutlineReviews(actor, "admin", freshVersion))[0];
    assert.equal(fresh.expertId, null, "Failed batch must not leave partial assignment.");
    const question = createUlid(), qv = createUlid(), assignment = createUlid();
    const options = ["A", "B", "C", "D"].map((key) => ({ key, content: `规范${key}` }));
    await admin.execute("INSERT INTO questions(id,project_id,question_no,occupation_id,level_code,assessment_mode,question_type,current_version_id,current_status) VALUES(?,?,'VERIFY',?,'level_4','theory','单项选择题',?,'pending_review')", [question, project, occupation, qv]);
    await admin.execute("INSERT INTO question_versions(id,question_id,version_no,stem,content_json,answer_json,analysis_text,source_snapshot_json,content_hash) VALUES(?,?,1,?,?,?,'原始解析','{}',?)", [qv, question, "如何按规范正确处理捐赠凭证？", JSON.stringify({ options }), '{"answers":["A"]}', "b".repeat(64)]);
    await admin.execute("INSERT INTO question_assessment_points(question_version_id,blueprint_node_id) VALUES(?,?)", [qv, nodes[0]]);
    await admin.execute("INSERT INTO review_assignments(id,project_id,question_id,question_version_id,expert_id,assigned_by) VALUES(?,?,?,?,?,?)", [assignment, project, question, qv, expert, actor]);
    const post = (data: unknown) => questionAction(new Request("http://localhost/api/v1/review/questions", { method: "POST", body: JSON.stringify(data), headers: { "Content-Type": "application/json" } }));
    const input = { questionId: question, assignmentId: assignment, versionId: qv, action: "review", decision: "approved", stem: "修订后应如何按规范归档捐赠凭证？", options, answers: ["B"], analysis: "修订后解析", opinion: "管理员修订并同意" };
    assert.equal((await post({ ...input, action: "confirm" })).status, 422);
    role = "expert";
    assert.equal((await post(input)).status, 403);
    role = "admin";
    const blocked = await post(input);
    assert.equal(blocked.status, 422);
    assert.match((await blocked.json()).error.message, /分配给专家/);
    assert.equal((await (await taskList()).json()).data.reviewTasks[0].canAdminReview, false);
    // Remove only the isolated fixture assignment to test a separate,
    // unassigned administrator review path. Production assignments stay intact.
    await admin.execute("DELETE FROM review_assignments WHERE id=?", [assignment]);
    assert.equal((await post({ ...input, answers: ["X"] })).status, 422);
    const response = await post({ ...input, assignmentId: null });
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    const payload = await response.json();
    assert.notEqual(payload.data.current_version_id, qv);
    assert.equal(payload.data.current_status, "approved");
    const forbiddenAssignment = await assignQuestions(new Request("http://localhost/api/v1/review/assignments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expertId: expert, questionIds: [question] }) }));
    assert.equal(forbiddenAssignment.status, 422);
    const tasks = await (await taskList()).json();
    assert.equal(tasks.data.reviewTasks[0].status, "approved");
    const newAssignment = tasks.data.reviewTasks[0].assignmentId;
    assert.notEqual(newAssignment, assignment);
    role = "expert";
    const stale = await expertAction(new Request("http://localhost/api/v1/expert/reviews", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ assignmentId: assignment, stage: "initial", alignment: "aligned", alignmentScore: "5", decision: "approved", comment: "迟到专家意见", confirmed: true }) }));
    assert.equal(stale.status, 422);
    role = "admin";
    assert.equal((await post({ ...input, assignmentId: newAssignment, versionId: payload.data.current_version_id, action: "store" })).status, 422);
    assert.equal((await libraryStore(new Request("http://localhost/api/v1/questions", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ questionId: question }) }))).status, 422);
    assert.equal((await post({ ...input, assignmentId: newAssignment, versionId: payload.data.current_version_id, action: "confirm" })).status, 200);
    const [confirmedQuestion] = await admin.execute("SELECT current_status FROM questions WHERE id=?", [question]);
    assert.equal((confirmedQuestion as Array<{ current_status: string }>)[0].current_status, "approved", "Confirm must not store the question.");
    const confirmedTasks = (await (await taskList()).json()).data.reviewTasks;
    assert.ok(confirmedTasks.find((task: { id: string; confirmedAt: string | null }) => task.id === question)?.confirmedAt);
    assert.equal((await post({ ...input, action: "store" })).status, 422, "Old version cannot be stored.");
    assert.equal((await post({ ...input, assignmentId: newAssignment, versionId: payload.data.current_version_id, action: "confirm" })).status, 422);
    assert.equal((await post({ ...input, assignmentId: newAssignment, versionId: payload.data.current_version_id, action: "store" })).status, 200);
    assert.equal((await post({ ...input, assignmentId: newAssignment, versionId: payload.data.current_version_id, action: "store" })).status, 422);
    const [records] = await admin.execute("SELECT submitted_by,acting_role,expert_id FROM review_records");
    assert.equal((records as Array<Record<string, unknown>>)[0].submitted_by, actor);
    assert.equal((records as Array<Record<string, unknown>>)[0].expert_id, actor);
    assert.equal((records as Array<Record<string, unknown>>)[0].acting_role, "admin");
    const [history] = await admin.execute("SELECT COUNT(*) AS count FROM question_versions WHERE question_id=?", [question]);
    assert.equal(Number((history as Array<{ count: number }>)[0].count), 2);
    const expertQuestion = createUlid(), expertVersion = createUlid(), expertAssignment = createUlid();
    await admin.execute("INSERT INTO questions(id,project_id,question_no,occupation_id,level_code,assessment_mode,question_type,current_version_id,current_status) VALUES(?,?,'EXPERT-VERIFY',?,'level_4','theory','单项选择题',?,'pending_review')", [expertQuestion, project, occupation, expertVersion]);
    await admin.execute("INSERT INTO question_versions(id,question_id,version_no,stem,content_json,answer_json,analysis_text,source_snapshot_json,content_hash) VALUES(?,?,1,?,?,?,'原始解析','{}',?)", [expertVersion, expertQuestion, "如何按规范正确处理捐赠凭证？", JSON.stringify({ options }), '{"answers":["A"]}', "c".repeat(64)]);
    await admin.execute("INSERT INTO question_assessment_points(question_version_id,blueprint_node_id) VALUES(?,?)", [expertVersion, nodes[0]]);
    await admin.execute("INSERT INTO review_assignments(id,project_id,question_id,question_version_id,expert_id,assigned_by) VALUES(?,?,?,?,?,?)", [expertAssignment, project, expertQuestion, expertVersion, expert, actor]);
    const revisionInput = { ...input, questionId: expertQuestion, versionId: expertVersion, assignmentId: expertAssignment, action: "revise", opinion: "本人专家修订说明" };
    role = "expert";
    assert.equal((await post({ ...revisionInput, assignmentId: createUlid() })).status, 422);
    assert.equal((await post({ ...revisionInput, action: "confirm" })).status, 403);
    const revisionResponse = await post(revisionInput);
    assert.equal(revisionResponse.status, 200, JSON.stringify(await revisionResponse.clone().json()));
    const revision = await revisionResponse.json();
    assert.equal(revision.data.current_status, "pending_review");
    assert.notEqual(revision.data.current_version_id, expertVersion);
    let ownTasks = await (await expertTasks()).json();
    assert.equal(ownTasks.data.tasks.length, 1);
    let revisedTask = ownTasks.data.tasks[0];
    assert.equal(revisedTask.questionVersionId, revision.data.current_version_id);
    assert.notEqual(revisedTask.assignmentId, expertAssignment);
    const returnedResponse = await expertAction(new Request("http://localhost/api/v1/expert/reviews", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignmentId: revisedTask.assignmentId, stage: "initial", alignment: "aligned", alignmentScore: "4", decision: "returned", comment: "需继续修订", confirmed: true }) }));
    assert.equal(returnedResponse.status, 200);
    ownTasks = await (await expertTasks()).json();
    assert.equal(ownTasks.data.tasks[0].status, "returned");
    const returnRevision = await post({ ...revisionInput, versionId: revisedTask.questionVersionId, assignmentId: revisedTask.assignmentId });
    assert.equal(returnRevision.status, 200);
    ownTasks = await (await expertTasks()).json();
    revisedTask = ownTasks.data.tasks[0];
    assert.equal(revisedTask.status, "pending_review");
    const decisionRequest = () => new Request("http://localhost/api/v1/expert/reviews", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignmentId: revisedTask.assignmentId, stage: "initial", alignment: "aligned", alignmentScore: "5", decision: "approved", comment: "修订版本专家审核通过", confirmed: true }) });
    assert.equal((await expertAction(decisionRequest())).status, 200);
    assert.equal((await expertAction(decisionRequest())).status, 422);
    ownTasks = await (await expertTasks()).json();
    assert.equal(ownTasks.data.tasks[0].status, "approved");
    assert.equal((await post({ ...revisionInput, versionId: revisedTask.questionVersionId, assignmentId: revisedTask.assignmentId })).status, 422);
    role = "admin";
    assert.equal((await post({ ...revisionInput, action: "review", versionId: revisedTask.questionVersionId, assignmentId: revisedTask.assignmentId })).status, 422);
    assert.equal((await post({ ...revisionInput, action: "confirm", versionId: revisedTask.questionVersionId, assignmentId: revisedTask.assignmentId })).status, 200);
    assert.equal((await post({ ...revisionInput, action: "store", versionId: revisedTask.questionVersionId, assignmentId: revisedTask.assignmentId })).status, 200);
    console.info("专家修订回归通过：本人任务新版本保存、重新审核、通过后只读等待确认、专家不能入库、重复审核拒绝、管理员确认后单独入库。");
    console.info("确认回归通过：确认不自动入库、待入库状态可查询、未确认及旧版本入库拒绝、题库入口不能绕过确认、重复确认及入库拒绝。");
    console.info("审核回归通过：分配后拒绝管理员审核、通过后拒绝分配、拒绝重复分配、专家审核后管理员确认、未分配试题管理员修订审核、版本与身份留痕。");
  } finally {
    if (previousAuth) require.cache[authPath] = previousAuth;
    else delete require.cache[authPath];
    if (globalThis.__itembankMysqlPool) await globalThis.__itembankMysqlPool.end();
    for (const table of tables.slice().reverse()) await raw(`DROP TABLE IF EXISTS \`${prefix}${table}\``);
    await admin.end();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
