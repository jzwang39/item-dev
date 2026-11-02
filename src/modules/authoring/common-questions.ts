import { createHash } from "node:crypto";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { createUlid } from "@/shared/database/ulid";
import { query, withTransaction } from "@/shared/database/mysql";
import { readCurrentTheoryVersion } from "@/modules/blueprints/current-theory-version";
import { assertCommonOutlinesConfirmed } from "./common-outline-readiness";
import { isLegalPoint } from "./legal-topics";
import { stemHash, type Scope, type QuotaPoint } from "./generation/contracts";
import { basicIdentity, commonCoverage, commonLevels, commonQuotaPoints, decodeCommon, matchCommonPoints,
  validateCommonQuota, type CommonNode, type CommonPoint, type CommonQuota } from "./common-question-policy";

export type CommonBasis = { points: CommonPoint[]; scopes: Record<string, Scope> };
type Group = RowDataPacket & { id: string; project_id: string; occupation_id: string; basis_json: unknown; quota_json: unknown;
  current_release_id: string | null; generation_plan_id: string | null; row_version: number };
type Member = RowDataPacket & { question_id: string; current_version_id: string; current_status: string;
  point_key: string; question_type: string; suspended: number; stem: string; question_no: string };

async function commonAudit(db: PoolConnection, group: Group | { id: string; project_id: string }, actor: string,
  action: string, details: unknown) {
  await db.execute(`INSERT INTO audit_logs(id,project_id,actor_id,action,object_type,object_id,after_json,result)
    VALUES(?,?,?,?,'common_question_group',?,?,'success')`,
  [createUlid(), group.project_id, actor, `common_questions.${action}`, group.id, JSON.stringify(details)]);
}
async function lockGroup(db: PoolConnection, id: string) {
  // Generation, termination and group edits share this leading lock.
  await db.execute("SELECT id FROM authoring_generation_capacity WHERE id=1 FOR UPDATE");
  const [groups] = await db.execute<Group[]>(`SELECT g.* FROM common_question_groups g
    JOIN projects p ON p.id=g.project_id AND p.status='active'
    JOIN project_occupations o ON o.id=g.occupation_id AND o.status='active' WHERE g.id=? FOR UPDATE`, [id]);
  if (!groups[0]) throw new Error("公共题组不存在或职业已归档。");
  return groups[0];
}
async function assertIdle(db: PoolConnection, group: Group) {
  const [jobs] = await db.execute<RowDataPacket[]>(`SELECT j.id FROM authoring_generation_jobs j
    JOIN authoring_plans p ON p.id=j.plan_id
    WHERE JSON_UNQUOTE(JSON_EXTRACT(p.scope_json,'$.commonGroupId'))=? AND j.status IN ('queued','running') LIMIT 1`, [group.id]);
  if (jobs.length) throw new Error("公共题组正在生成，请先等待或停止生成，再修改配置、选用旧题或发布。");
}
async function members(db: PoolConnection, id: string) {
  const [rows] = await db.execute<Member[]>(`SELECT m.*,q.current_version_id,q.current_status,q.question_type,q.question_no,v.stem
    FROM common_question_members m JOIN questions q ON q.id=m.question_id
    JOIN question_versions v ON v.id=q.current_version_id WHERE m.group_id=? AND q.archived_at IS NULL ORDER BY q.id FOR UPDATE`, [id]);
  return rows;
}
export async function loadCommonBasis(db: PoolConnection, occupationId: string): Promise<CommonBasis & { projectId: string }> {
  const [occupations] = await db.execute<(RowDataPacket & { project_id: string; name: string })[]>(`SELECT o.project_id,o.name
    FROM project_occupations o JOIN projects p ON p.id=o.project_id AND p.status='active'
    WHERE o.id=? AND o.status='active' AND p.code<>'SYSTEM-GENERIC-LEGAL' FOR UPDATE`, [occupationId]);
  if (!occupations[0]) throw new Error("职业不存在或已归档。");
  const { project_id: projectId, name } = occupations[0];
  const weights = await readCurrentTheoryVersion(db, { projectId, occupationId, kind: "theory_weight" });
  if (!weights) throw new Error("请先确认理论知识权重表。");
  const levelNodes: Record<string, CommonNode[]> = {};
  const scopes: Record<string, Scope> = {};
  const outlines: Array<{ id: string; levelCode: string; versionNo: number }> = [];
  for (const levelCode of commonLevels) {
    const outline = await readCurrentTheoryVersion(db, { projectId, occupationId, kind: "theory_outline", levelCode });
    if (!outline) throw new Error("请先保存五、四、三级理论细目表，再创建公共题组。");
    outlines.push({ id: outline.id, levelCode, versionNo: Number(outline.version_no) });
    const [nodes] = await db.execute<(RowDataPacket & CommonNode)[]>(`SELECT id,node_code,name,requirement_json,source_ref_json
      FROM blueprint_nodes WHERE blueprint_version_id=? AND node_kind='assessment_point' ORDER BY ordinal`, [outline.id]);
    levelNodes[levelCode] = nodes.filter((node) => !isLegalPoint(node));
    scopes[levelCode] = { occupationId, occupation: name, levelCode, assessmentMode: "理论知识",
      blueprintVersions: { outline: { id: outline.id, versionNo: Number(outline.version_no) },
        weights: { id: weights.id, versionNo: Number(weights.version_no) } } };
  }
  await assertCommonOutlinesConfirmed(db, outlines);
  return { projectId, scopes, points: matchCommonPoints(levelNodes) };
}

export async function createCommonGroup(occupationId: string, actor: string) {
  return withTransaction(async (db) => {
    await db.execute("SELECT id FROM authoring_generation_capacity WHERE id=1 FOR UPDATE");
    const [active] = await db.execute<RowDataPacket[]>(`SELECT j.id FROM authoring_generation_jobs j
      JOIN authoring_plans p ON p.id=j.plan_id WHERE j.status IN ('queued','running')
      AND JSON_UNQUOTE(JSON_EXTRACT(p.scope_json,'$.occupationId'))=?
      AND JSON_UNQUOTE(JSON_EXTRACT(p.scope_json,'$.assessmentMode'))='理论知识' LIMIT 1`, [occupationId]);
    if (active.length) throw new Error("该职业仍有理论题生成任务，请先停止并保留成果，再启用公共题组。");
    const basis = await loadCommonBasis(db, occupationId);
    const [existing] = await db.execute<Group[]>("SELECT * FROM common_question_groups WHERE occupation_id=? FOR UPDATE", [occupationId]);
    if (existing.length) throw new Error("该职业已有公共题组，请进入现有题组管理。");
    const group = { id: createUlid(), project_id: basis.projectId };
    const quota = basis.points.map((point) => ({ key: point.key, single: 4, multiple: 0, judgement: 2 }));
    await db.execute(`INSERT INTO common_question_groups(id,project_id,occupation_id,basis_json,quota_json) VALUES(?,?,?,?,?)`,
      [group.id, basis.projectId, occupationId, JSON.stringify(basis), JSON.stringify(quota)]);
    for (const point of basis.points) for (const level of commonLevels) await db.execute(
      "INSERT INTO common_question_points(group_id,point_key,level_code,blueprint_node_id) VALUES(?,?,?,?)",
      [group.id, point.key, level, point.nodes[level].id]);
    await commonAudit(db, group, actor, "create", { basis, quota, note: "默认配额可在生成前逐点调整；不自动选用旧题。" });
    return { id: group.id };
  });
}

export async function commonPlanQuota(db: PoolConnection, scope: Scope, nodes: CommonNode[], points: QuotaPoint[], planId?: string) {
  if (scope.assessmentMode !== "理论知识" || scope.commonGroupId || !commonLevels.includes(scope.levelCode as typeof commonLevels[number])) return null;
  const basics = nodes.filter((node) => basicIdentity(node));
  if (!basics.length) return null;
  const [groups] = await db.execute<Group[]>("SELECT * FROM common_question_groups WHERE occupation_id=? FOR UPDATE", [scope.occupationId]);
  const group = groups[0];
  if (!group) throw new Error("本计划包含基本要求，请先在“基本要求公共题组”创建并配置共用题组。");
  const basis = decodeCommon<CommonBasis>(group.basis_json), quota = decodeCommon<CommonQuota>(group.quota_json);
  if (quota.some((point) => point.multiple > 0)) throw new Error("公共题组不生成多选题，请先在公共题组保存单选、判断题的统一配额，再创建等级计划。");
  const identities = basics.map((node) => ({ node, identity: basicIdentity(node)! }));
  if (identities.length !== basis.points.length || identities.some(({ node, identity }) =>
    !basis.points.some((point) => point.key === identity.key && point.signature === identity.signature
      && point.nodes[scope.levelCode]?.id === node.id))) {
    throw new Error("计划基本要求与公共题组冻结依据不一致，请先在公共题组核对并同步细目表对应关系。");
  }
  const shared = commonQuotaPoints(basis.points, quota, scope.levelCode);
  const merged = points.map((point) => shared.find((item) => item.code === point.code) ?? point);
  if (planId) await db.execute(`INSERT INTO common_question_plan_links(plan_id,group_id,release_at_confirmation,snapshot_json)
    VALUES(?,?,?,?)`, [planId, group.id, group.current_release_id, JSON.stringify({ shared, basis, quota })]);
  return { groupId: group.id, releaseId: group.current_release_id, shared, points: merged };
}

export async function commonPlanProgress(planId: string) {
  const rows = await query<(RowDataPacket & { group_id: string; current_release_id: string | null; release_at_confirmation: string | null;
    snapshot_json: unknown; version_no: number | null })[]>(`SELECT l.*,g.current_release_id,r.version_no
    FROM common_question_plan_links l JOIN common_question_groups g ON g.id=l.group_id
    LEFT JOIN common_question_releases r ON r.id=g.current_release_id WHERE l.plan_id=?`, [planId]);
  if (!rows[0]) return null;
  const row = rows[0], snapshot = decodeCommon<{ shared: QuotaPoint[]; quota: CommonQuota }>(row.snapshot_json);
  const available = await query<(RowDataPacket & { point_key: string; question_type: string })[]>(`SELECT i.point_key,q.question_type
    FROM common_question_release_items i JOIN questions q ON q.id=i.question_id AND q.archived_at IS NULL
    JOIN common_question_members m ON m.question_id=q.id AND m.suspended=0 WHERE i.release_id=?`, [row.current_release_id]);
  const coverage = commonCoverage(snapshot.quota, available);
  return { groupId: row.group_id, releaseId: row.current_release_id, versionNo: row.version_no,
    releaseAtConfirmation: row.release_at_confirmation,
    target: coverage.reduce((sum, item) => sum + item.target, 0),
    available: coverage.reduce((sum, item) => sum + Math.min(item.target, item.count), 0),
    ready: coverage.every((item) => item.count >= item.target) && Boolean(row.current_release_id) };
}

export async function configureCommonGroup(id: string, quota: unknown, expectedVersion: number, actor: string) {
  return withTransaction(async (db) => {
    const group = await lockGroup(db, id);
    await assertIdle(db, group);
    if (group.row_version !== expectedVersion) throw new Error("配置已变化，请刷新后再保存。");
    const points = decodeCommon<CommonBasis>(group.basis_json).points;
    const next = validateCommonQuota(points, quota), previous = decodeCommon<CommonQuota>(group.quota_json);
    if (group.current_release_id && next.some((item) => {
      const old = previous.find((entry) => entry.key === item.key)!;
      return item.single < old.single || item.judgement < old.judgement;
    })) throw new Error("已发布公共题组仅允许扩充配额，不能缩减并影响已有等级计划。");
    const coverage = commonCoverage(next, (await members(db, id)).filter((item) => !item.suspended));
    if (coverage.some((item) => item.count > item.target)) throw new Error("配额不能小于现有题数，请先核对题目或停用多余题。");
    await db.execute("UPDATE common_question_groups SET quota_json=?,generation_plan_id=NULL,row_version=row_version+1 WHERE id=?",
      [JSON.stringify(next), id]);
    await commonAudit(db, group, actor, "quota", { previous, next });
  });
}

export async function syncCommonBasis(id: string, actor: string) {
  return withTransaction(async (db) => {
    const group = await lockGroup(db, id);
    await assertIdle(db, group);
    const current = await loadCommonBasis(db, group.occupation_id), previous = decodeCommon<CommonBasis>(group.basis_json);
    if (current.points.length !== previous.points.length || current.points.some((point) =>
      !previous.points.some((old) => old.key === point.key && old.signature === point.signature))) {
      throw new Error("来源或公共考评点内容已变化，不能自动沿用旧题及审核结论；请先人工核对，旧题组保持不变。");
    }
    for (const point of current.points) for (const level of commonLevels) await db.execute(
      "UPDATE common_question_points SET blueprint_node_id=? WHERE group_id=? AND point_key=? AND level_code=?",
      [point.nodes[level].id, id, point.key, level]);
    await db.execute("UPDATE common_question_groups SET basis_json=?,generation_plan_id=NULL,row_version=row_version+1 WHERE id=?",
      [JSON.stringify(current), id]);
    await commonAudit(db, group, actor, "basis_mapping", { previous, current });
  });
}

export async function adoptCommonQuestions(id: string, selections: Array<{ questionId: string; versionId: string }>, actor: string) {
  return withTransaction(async (db) => {
    const group = await lockGroup(db, id);
    await assertIdle(db, group);
    const basis = decodeCommon<CommonBasis>(group.basis_json), quota = decodeCommon<CommonQuota>(group.quota_json);
    if (!selections.length || new Set(selections.map((item) => item.questionId)).size !== selections.length) throw new Error("请选择不重复的旧题。");
    for (const selection of [...selections].sort((a, b) => a.questionId.localeCompare(b.questionId))) {
      const [questions] = await db.execute<(RowDataPacket & { current_version_id: string; level_code: string; question_type: string; stem: string })[]>(`
        SELECT q.current_version_id,q.level_code,q.question_type,v.stem FROM questions q JOIN question_versions v ON v.id=q.current_version_id
        WHERE q.id=? AND q.project_id=? AND q.occupation_id=? AND q.assessment_mode='theory' AND q.archived_at IS NULL
          AND q.current_status<>'archived' AND q.level_code IN ('level_5','level_4','level_3')
          AND NOT EXISTS(SELECT 1 FROM common_question_members m WHERE m.question_id=q.id)
          AND NOT EXISTS(SELECT 1 FROM authoring_generation_slots s JOIN authoring_generation_jobs j ON j.id=s.job_id
            WHERE s.question_id=q.id AND j.status IN ('queued','running'))
        FOR UPDATE`, [selection.questionId, group.project_id, group.occupation_id]);
      const question = questions[0];
      if (!question || question.current_version_id !== selection.versionId) throw new Error("旧题已变化、已选用或仍在生成，请刷新后重新选择。");
      if (!/单.*选|判断/.test(question.question_type)) throw new Error("公共题组仅支持单选、判断题，不再选用多选题。");
      const [nodes] = await db.execute<(RowDataPacket & CommonNode)[]>(`SELECT n.* FROM question_assessment_points p
        JOIN blueprint_nodes n ON n.id=p.blueprint_node_id WHERE p.question_version_id=?`, [selection.versionId]);
      const point = nodes.length === 1 ? basicIdentity(nodes[0]) : null;
      if (!point || !basis.points.some((item) => item.key === point.key && item.signature === point.signature)) {
        throw new Error("选中题目的基本要求来源与公共题组不一致，不能按题干或编号直接合并。");
      }
      const [duplicates] = await db.execute<(RowDataPacket & { stem: string })[]>(`SELECT v.stem FROM common_question_members m
        JOIN questions q ON q.id=m.question_id JOIN question_versions v ON v.id=q.current_version_id
        WHERE m.group_id=? AND m.suspended=0`, [id]);
      if (duplicates.some((item) => stemHash(item.stem) === stemHash(question.stem))) throw new Error("公共题组已有规范化后相同题干，请核对后再选用。");
      await db.execute("INSERT INTO common_question_members(question_id,group_id,point_key,origin_json) VALUES(?,?,?,?)",
        [selection.questionId, id, point.key, JSON.stringify({ kind: "adopted", versionId: selection.versionId, levelCode: question.level_code, actor })]);
      await db.execute("UPDATE questions SET level_code=NULL,row_version=row_version+1 WHERE id=?", [selection.questionId]);
    }
    if (commonCoverage(quota, (await members(db, id)).filter((item) => !item.suspended)).some((item) => item.count > item.target)) {
      throw new Error("所选旧题超过公共配额，请减少选择或先扩充对应题型配额。");
    }
    await db.execute("UPDATE common_question_groups SET generation_plan_id=NULL,row_version=row_version+1 WHERE id=?", [id]);
    await commonAudit(db, group, actor, "adopt", { selections, note: "复用原题ID与审核记录，未审核题不自动通过；旧试卷不变。" });
  });
}

export async function prepareCommonGeneration(id: string, actor: string) {
  return withTransaction(async (db) => {
    const group = await lockGroup(db, id);
    const previous = decodeCommon<CommonQuota>(group.quota_json);
    if (previous.some((point) => point.multiple > 0)) {
      await assertIdle(db, group);
      if (group.current_release_id || (await members(db, id)).some((item) => !item.suspended && /多.*选/.test(item.question_type))) {
        throw new Error("公共题组改为单选、判断题。请先核对并停用历史多选题，再保存新配额；历史任务和发布记录保留。");
      }
      throw new Error("公共题组配额仍包含多选题。请先终止当前任务，再在“统一配额”将多选设为0、判断设为2后重新生成。");
    }
    if (group.generation_plan_id) {
      const [jobs] = await db.execute<(RowDataPacket & { status: string })[]>("SELECT status FROM authoring_generation_jobs WHERE plan_id=?", [group.generation_plan_id]);
      if (!jobs.length || ["queued", "running", "partial"].includes(jobs[0].status)) return group.generation_plan_id;
    }
    await assertIdle(db, group);
    const basis = decodeCommon<CommonBasis>(group.basis_json), quota = decodeCommon<CommonQuota>(group.quota_json);
    if (commonCoverage(quota, (await members(db, id)).filter((item) => !item.suspended)).every((item) => item.count >= item.target)) {
      throw new Error("公共题数量已满足配置，无需重复生成；请继续审核或发布。");
    }
    const scope: Scope = { ...basis.scopes.level_5, commonGroupId: id };
    const points = commonQuotaPoints(basis.points, quota, "level_5"), planId = createUlid();
    await db.execute(`INSERT INTO authoring_plans(id,project_id,name,raw_requirement,scope_json,quota_json,status,created_by)
      VALUES(?,?,?,?,?,?,'confirmed',?)`, [planId, group.project_id, `${scope.occupation}基本要求公共题组`,
      "基本要求公共命题，统一适用于五级、四级、三级，只生成配置的公共考评点，不按某个等级分别加深或改写。严格遵守理论试题质量标准。",
      JSON.stringify(scope), JSON.stringify({ points, minimumTotal: points.reduce((sum, point) => sum + point.total, 0),
        qualityRequirements: ["五四三级共用基本要求；答案真实、唯一可答，统一审核"], validations: [], temporaryMinimums: {} }), actor]);
    for (const version of Object.values(scope.blueprintVersions)) if (version) await db.execute(
      "INSERT INTO authoring_plan_blueprints(plan_id,blueprint_version_id) VALUES(?,?)", [planId, version.id]);
    await db.execute("UPDATE common_question_groups SET generation_plan_id=?,row_version=row_version+1 WHERE id=?", [planId, id]);
    await commonAudit(db, group, actor, "generation_plan", { planId, points });
    return planId;
  });
}

export async function publishCommonGroup(id: string, expectedVersion: number, actor: string) {
  return withTransaction(async (db) => {
    const group = await lockGroup(db, id);
    await assertIdle(db, group);
    if (group.row_version !== expectedVersion) throw new Error("题组已变化，请刷新后再发布。");
    const rows = (await members(db, id)).filter((item) => !item.suspended);
    const quota = decodeCommon<CommonQuota>(group.quota_json);
    if (quota.some((point) => point.multiple > 0)) throw new Error("公共题组不生成多选题，请先核对历史多选题并保存单选、判断题配额，再发布新版本。");
    if (!rows.length || commonCoverage(quota, rows).some((item) => item.count !== item.target)) {
      throw new Error("公共题组尚未逐考评点、逐题型满足配置，不可发布。");
    }
    for (const row of rows) {
      if (row.current_status !== "stored") throw new Error("公共题组包含尚未入库的题目，请完成统一审核、确认及入库。");
      const [confirmed] = await db.execute<RowDataPacket[]>("SELECT question_version_id FROM question_review_confirmations WHERE question_version_id=?", [row.current_version_id]);
      if (!confirmed.length) throw new Error("题目当前版本缺少管理员确认，不可发布。");
    }
    const [previous] = await db.execute<(RowDataPacket & { question_id: string; question_version_id: string })[]>(
      "SELECT question_id,question_version_id FROM common_question_release_items WHERE release_id=? ORDER BY question_id", [group.current_release_id]);
    if (previous.length === rows.length && rows.every((row) => previous.some((item) => item.question_id === row.question_id && item.question_version_id === row.current_version_id))) {
      throw new Error("题目版本没有变化，无需重复发布。");
    }
    const [versions] = await db.execute<(RowDataPacket & { next_version: number })[]>(
      "SELECT COALESCE(MAX(version_no),0)+1 AS next_version FROM common_question_releases WHERE group_id=?", [id]);
    const releaseId = createUlid(), versionNo = Number(versions[0].next_version);
    await db.execute("INSERT INTO common_question_releases(id,group_id,version_no,snapshot_json,published_by) VALUES(?,?,?,?,?)",
      [releaseId, id, versionNo, JSON.stringify({ basis: decodeCommon(group.basis_json), quota }), actor]);
    for (const row of rows) await db.execute(
      "INSERT INTO common_question_release_items(release_id,question_id,question_version_id,point_key) VALUES(?,?,?,?)",
      [releaseId, row.question_id, row.current_version_id, row.point_key]);
    await db.execute("UPDATE common_question_groups SET current_release_id=?,row_version=row_version+1 WHERE id=?", [releaseId, id]);
    await commonAudit(db, group, actor, "publish", { releaseId, versionNo, previousReleaseId: group.current_release_id, count: rows.length });
    return { releaseId, versionNo };
  });
}

export async function commonQuestionAction(id: string, questionId: string, versionId: string, action: "reopen" | "suspend", opinion: string, actor: string) {
  return withTransaction(async (db) => {
    const group = await lockGroup(db, id);
    await assertIdle(db, group);
    const row = (await members(db, id)).find((item) => item.question_id === questionId);
    if (!row || row.current_version_id !== versionId) throw new Error("试题版本已变化，请刷新后操作。");
    if (action === "reopen") {
      if (row.suspended || !["stored", "approved"].includes(row.current_status)) throw new Error("仅可对未停用的已审定题发起统一修订。");
      // Clone a working revision first: never invalidate the published version's
      // confirmation or replace historical paper snapshots.
      const nextId = createUlid();
      await db.execute(`INSERT INTO question_versions(id,question_id,version_no,parent_version_id,revision_reason,stem,content_json,
        answer_json,analysis_text,score_rubric_json,source_snapshot_json,content_hash,created_by)
        SELECT ?,question_id,version_no+1,id,?,stem,content_json,answer_json,analysis_text,score_rubric_json,source_snapshot_json,?,?
        FROM question_versions WHERE id=?`, [nextId, opinion, createHash("sha256").update(nextId).digest("hex"), actor, versionId]);
      await db.execute(`INSERT INTO question_assessment_points(question_version_id,blueprint_node_id,coverage_weight)
        SELECT ?,blueprint_node_id,coverage_weight FROM question_assessment_points WHERE question_version_id=?`, [nextId, versionId]);
      const [options] = await db.execute<(RowDataPacket & { option_key: string; content: string; is_correct: number })[]>(
        "SELECT option_key,content,is_correct FROM question_options WHERE question_version_id=?", [versionId]);
      for (const option of options) await db.execute("INSERT INTO question_options(id,question_version_id,option_key,content,is_correct) VALUES(?,?,?,?,?)",
        [createUlid(), nextId, option.option_key, option.content, option.is_correct]);
      const [refs] = await db.execute<(RowDataPacket & { source_version_id: string; source_segment_id: string | null; citation: string; quote_excerpt: string | null })[]>(
        "SELECT source_version_id,source_segment_id,citation,quote_excerpt FROM question_source_refs WHERE question_version_id=?", [versionId]);
      for (const ref of refs) await db.execute("INSERT INTO question_source_refs(id,question_version_id,source_version_id,source_segment_id,citation,quote_excerpt) VALUES(?,?,?,?,?,?)",
        [createUlid(), nextId, ref.source_version_id, ref.source_segment_id, ref.citation, ref.quote_excerpt]);
      await db.execute("INSERT INTO question_revision_links(id,from_question_version_id,to_question_version_id,relation_type) VALUES(?,?,?,'manual_revision')",
        [createUlid(), versionId, nextId]);
      await db.execute("UPDATE questions SET current_version_id=?,current_status='pending_review',row_version=row_version+1 WHERE id=?", [nextId, questionId]);
      await db.execute("INSERT INTO question_status_events(id,question_id,question_version_id,from_status,to_status,reason,actor_id) VALUES(?,?,?,?,'pending_review',?,?)",
        [createUlid(), questionId, nextId, row.current_status, opinion, actor]);
    } else {
      await db.execute("UPDATE common_question_members SET suspended=1 WHERE question_id=?", [questionId]);
    }
    await db.execute("UPDATE common_question_groups SET generation_plan_id=NULL,row_version=row_version+1 WHERE id=?", [id]);
    const [papers] = await db.execute<RowDataPacket[]>("SELECT DISTINCT paper_id FROM paper_items WHERE question_id=?", [questionId]);
    await commonAudit(db, group, actor, action, { questionId, versionId, opinion, affectedPapers: papers });
    return { affectedPapers: papers };
  });
}

export async function listCommonGroups() {
  return query<RowDataPacket[]>(`SELECT g.id,g.occupation_id,g.row_version,g.updated_at,o.name AS occupation_name,
    CASE WHEN j.status='cancelled' OR p2.status='cancelled' THEN NULL ELSE j.status END AS generation_status,
    CASE WHEN j.status='cancelled' OR p2.status='cancelled' THEN NULL ELSE g.generation_plan_id END AS generation_plan_id,
    r.version_no,(SELECT COUNT(*) FROM common_question_members m WHERE m.group_id=g.id AND m.suspended=0) AS question_count
    FROM common_question_groups g JOIN project_occupations o ON o.id=g.occupation_id AND o.status='active'
    JOIN projects p ON p.id=g.project_id AND p.status='active'
    LEFT JOIN authoring_plans p2 ON p2.id=g.generation_plan_id
    LEFT JOIN authoring_generation_jobs j ON j.plan_id=g.generation_plan_id
    LEFT JOIN common_question_releases r ON r.id=g.current_release_id
    ORDER BY CASE WHEN j.status IN ('queued','running') THEN 0 ELSE 1 END,g.updated_at DESC,g.id DESC`);
}
export async function getCommonGroup(id: string, page: number, candidates = false) {
  return withTransaction(async (db) => {
    const group = await lockGroup(db, id), basis = decodeCommon<CommonBasis>(group.basis_json);
    const [generation] = group.generation_plan_id
      ? await db.execute<(RowDataPacket & { plan_status: string | null; job_status: string | null })[]>(
        `SELECT p.status AS plan_status,j.status AS job_status
           FROM authoring_plans p LEFT JOIN authoring_generation_jobs j ON j.plan_id=p.id
          WHERE p.id=?`, [group.generation_plan_id],
      )
      : [[]];
    const effectiveGenerationPlanId = generation[0] && !["cancelled"].includes(String(generation[0].plan_status))
      && !["cancelled"].includes(String(generation[0].job_status))
      ? group.generation_plan_id : null;
    const all = await members(db, id), quota = decodeCommon<CommonQuota>(group.quota_json);
    const [releases] = await db.execute<RowDataPacket[]>("SELECT id,version_no,published_at FROM common_question_releases WHERE group_id=? ORDER BY version_no DESC LIMIT 20", [id]);
    let result: RowDataPacket[], total: number;
    if (candidates) {
      const nodeIds = basis.points.flatMap((point) => Object.values(point.nodes).map((node) => node.id));
      const where = `q.occupation_id=? AND q.assessment_mode='theory' AND q.archived_at IS NULL
        AND q.question_type IN ('单项选择题','判断题')
        AND q.level_code IN ('level_5','level_4','level_3')
        AND NOT EXISTS(SELECT 1 FROM common_question_members m WHERE m.question_id=q.id)
        AND EXISTS(SELECT 1 FROM question_assessment_points a WHERE a.question_version_id=q.current_version_id
          AND a.blueprint_node_id IN (${nodeIds.map(() => "?").join(",")}))`;
      const [counts] = await db.execute<(RowDataPacket & { total: number })[]>(`SELECT COUNT(*) AS total FROM questions q WHERE ${where}`, [group.occupation_id, ...nodeIds]);
      [result] = await db.execute<RowDataPacket[]>(`SELECT q.id AS question_id,q.current_version_id,q.question_no,q.question_type,q.current_status,
        q.level_code,v.stem,v.content_json,v.answer_json,v.analysis_text FROM questions q JOIN question_versions v ON v.id=q.current_version_id
        WHERE ${where} ORDER BY q.updated_at DESC,q.id DESC LIMIT 20 OFFSET ${20 * (page - 1)}`, [group.occupation_id, ...nodeIds]);
      total = Number(counts[0].total);
    } else {
      [result] = await db.execute<RowDataPacket[]>(`SELECT m.*,q.current_version_id,q.question_no,q.question_type,q.current_status,v.stem,
        v.content_json,v.answer_json,v.analysis_text,
        EXISTS(SELECT 1 FROM question_review_confirmations c WHERE c.question_version_id=q.current_version_id) AS confirmed
        FROM common_question_members m JOIN questions q ON q.id=m.question_id
        JOIN question_versions v ON v.id=q.current_version_id WHERE m.group_id=?
        ORDER BY q.updated_at DESC,q.id DESC LIMIT 20 OFFSET ${20 * (page - 1)}`, [id]);
      total = all.length;
    }
    return { id, rowVersion: group.row_version, basis, quota, releases, generationPlanId: effectiveGenerationPlanId,
      currentReleaseId: group.current_release_id, coverage: commonCoverage(quota, all.filter((item) => !item.suspended)), total,
      questions: result.map((row) => ({ ...row, content_json: decodeCommon(row.content_json), answer_json: decodeCommon(row.answer_json) })) };
  });
}
