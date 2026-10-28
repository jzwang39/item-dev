import { createHash, randomInt } from "node:crypto";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { createUlid } from "@/shared/database/ulid";
import { assemblyPaperNumber } from "@/app/api/v1/assembly/paper-number";
import { decode, loadWeightBasis, loadWeightedQuestions, type WeightedQuestion } from "./weight-basis";
import { allocateWeighted, baseQuestionType, inventoryKey, rangeTargets, scaleRubric, scoreCents, suggestWeightedSections, type WeightedSection } from "./weight-policy";
import { paperFormat, parseRecord, type PaperPresentation } from "@/modules/documents/paper-presentation";

type PlanContext = RowDataPacket & {
  id: string; name: string; status: string; project_id: string; occupation_id: string;
  level_code: string; assessment_mode: string; current_version_id: string; version_no: number;
  paper_structure_version_id: string; snapshot_json: unknown; structure_name: string;
  duration_minutes: number; total_items: number; total_score: number; occupation_name: string;
};

async function loadContext(db: PoolConnection, planId: string) {
  const [plans] = await db.execute<PlanContext[]>(
    `SELECT ap.*,v.version_no,v.paper_structure_version_id,v.snapshot_json,ps.name AS structure_name,po.name AS occupation_name,
      sv.duration_minutes,sv.total_items,sv.total_score
     FROM assembly_plans ap JOIN assembly_plan_versions v ON v.id=ap.current_version_id
     JOIN paper_structure_versions sv ON sv.id=v.paper_structure_version_id
     JOIN paper_structures ps ON ps.id=sv.paper_structure_id
     JOIN project_occupations po ON po.id=ap.occupation_id AND po.project_id=ap.project_id AND po.status='active'
     JOIN projects p ON p.id=ap.project_id AND p.status='active'
     WHERE ap.id=? AND ap.status<>'cancelled' FOR UPDATE`, [planId],
  );
  if (!plans[0]) throw new Error("组卷计划不存在、已取消或项目已停用。");
  const plan = plans[0];
  const snapshot = decode<{ paperCount?: number; weightDirection?: string }>(plan.snapshot_json);
  const paperCount = snapshot.paperCount ?? 1;
  if (!Number.isInteger(paperCount) || paperCount < 1 || paperCount > 10) throw new Error("组卷套数必须为1至10套。");
  const [rows] = await db.execute<(RowDataPacket & {
    section_no: number; question_type: string; item_count: number; score_per_item: number; requirements_json: unknown;
  })[]>(
    `SELECT section_no,question_type,item_count,score_per_item,requirements_json FROM paper_structure_sections
     WHERE paper_structure_version_id=? AND item_count>0 ORDER BY section_no`, [plan.paper_structure_version_id],
  );
  const sections: WeightedSection[] = rows.map((row) => ({
    questionType: row.question_type, itemCount: Number(row.item_count), scorePerItem: Number(row.score_per_item),
    rangeKey: decode<{ rangeKey?: string }>(row.requirements_json)?.rangeKey,
  }));
  if (sections.reduce((sum, row) => sum + row.itemCount, 0) !== Number(plan.total_items) ||
    sections.reduce((sum, row) => sum + row.itemCount * scoreCents(row.scorePerItem), 0) !== scoreCents(Number(plan.total_score)) ||
    scoreCents(Number(plan.total_score)) !== 10000) throw new Error("试卷结构题量或100分总配分不一致，请先修订结构。");
  const basis = await loadWeightBasis(db, plan, snapshot.weightDirection);
  const candidates = await loadWeightedQuestions(db, plan, basis);
  const targets = rangeTargets(basis.ranges, Number(plan.total_score));
  return { plan, paperCount, sections, sectionNumbers: rows.map((row) => row.section_no), basis, targets, ...candidates };
}

export async function previewWeightedAssembly(db: PoolConnection, planId: string) {
  const context = await loadContext(db, planId);
  let valid = true, message = "每套试卷的范围配分和现有结构可严格满足权重。";
  try { allocateWeighted(context.sections, context.basis.ranges, context.inventory, context.paperCount); }
  catch (error) { valid = false; message = error instanceof Error ? error.message : "无法严格满足权重。"; }
  let suggestion: WeightedSection[] | null = null, suggestionError = "";
  if (!valid) {
    try {
      suggestion = suggestWeightedSections(context.sections, context.basis.ranges, context.inventory, context.paperCount);
      if (context.plan.assessment_mode === "theory" && ["level_2", "level_1"].includes(context.plan.level_code) &&
        suggestion.reduce((sum, row) => sum + row.itemCount, 0) !== 46) {
        suggestion = null;
        suggestionError = "调整结果不满足二级、一级理论试卷46题要求，请手工修订结构。";
      }
    } catch (error) { suggestionError = error instanceof Error ? error.message : "无法生成调整建议。"; }
  }
  const ranges = context.targets.map((range) => ({
    ...range, targetScore: range.targetCents / 100,
    available: context.questions.filter((question) => question.rangeKey === range.key).length,
    byType: [...new Set(context.sections.map((section) => baseQuestionType(section.questionType)))].map((type) => ({
      type, available: context.inventory[inventoryKey(range.key, type)] ?? 0,
    })),
  }));
  const fingerprint = createHash("sha256").update(JSON.stringify({
    planVersion: context.plan.current_version_id, structureVersion: context.plan.paper_structure_version_id,
    basis: context.basis, paperCount: context.paperCount, suggestion,
    inventory: Object.entries(context.inventory).sort(([a], [b]) => a.localeCompare(b)),
  })).digest("hex");
  return {
    valid, message, ranges, excluded: context.excluded, paperCount: context.paperCount,
    basis: context.basis, sections: context.sections, suggestion, suggestionError, fingerprint,
  };
}

export async function confirmWeightedAdjustment(db: PoolConnection, planId: string, actorId: string, fingerprint: string) {
  const preview = await previewWeightedAssembly(db, planId);
  if (!preview.suggestion || preview.fingerprint !== fingerprint) {
    throw new Error("权重、库存或计划已变化，或当前无需调整；请重新检查并确认最新建议。");
  }
  const context = await loadContext(db, planId);
  const structureId = createUlid(), structureVersionId = createUlid(), planVersionId = createUlid();
  const sections = preview.suggestion;
  const totalItems = sections.reduce((sum, row) => sum + row.itemCount, 0);
  const snapshot = {
    name: `${context.plan.structure_name}（权重调整）`.slice(0, 300),
    occupationId: context.plan.occupation_id, levelCode: context.plan.level_code,
    assessmentMode: context.plan.assessment_mode, durationMinutes: context.plan.duration_minutes,
    sections, weightBasis: preview.basis, sourceStructureVersionId: context.plan.paper_structure_version_id,
    confirmedBy: actorId, confirmationFingerprint: fingerprint,
  };
  // A new structure avoids changing other plans which reference the old one.
  await db.execute(
    `INSERT INTO paper_structures(id,project_id,name,occupation_id,level_code,assessment_mode,current_version_id,status)
     VALUES(?,?,?,?,?,?,?,'published')`,
    [structureId, context.plan.project_id, snapshot.name, snapshot.occupationId, snapshot.levelCode, snapshot.assessmentMode, structureVersionId],
  );
  await db.execute(
    `INSERT INTO paper_structure_versions(id,paper_structure_id,version_no,status,template_code,duration_minutes,total_items,total_score,snapshot_json,published_at)
     VALUES(?,?,1,'published','weighted',?,?,100,?,NOW(3))`,
    [structureVersionId, structureId, snapshot.durationMinutes, totalItems, JSON.stringify(snapshot)],
  );
  for (const [index, section] of sections.entries()) {
    await db.execute(
      `INSERT INTO paper_structure_sections(id,paper_structure_version_id,section_no,question_type,item_count,score_per_item,section_score,ordering,requirements_json)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      [createUlid(), structureVersionId, index + 1, section.questionType, section.itemCount, section.scorePerItem,
        section.itemCount * section.scorePerItem, index + 1, JSON.stringify({ rangeKey: section.rangeKey })],
    );
  }
  await db.execute(
    `INSERT INTO assembly_plan_versions(id,assembly_plan_id,version_no,paper_structure_version_id,status,candidate_filter_json,snapshot_json)
     VALUES(?,?,?,?,'draft',?,?)`,
    [planVersionId, planId, Number(context.plan.version_no) + 1, structureVersionId, JSON.stringify({ status: "stored" }),
      JSON.stringify({ paperCount: context.paperCount, structureVersionId, weightDirection: preview.basis.direction, weightBasis: preview.basis,
        sourcePlanVersionId: context.plan.current_version_id, confirmedBy: actorId })],
  );
  for (const [index, section] of sections.entries()) {
    await db.execute(
      `INSERT INTO assembly_plan_slots(id,assembly_plan_version_id,slot_no,section_no,question_type,required_count,requirements_json)
       VALUES(?,?,?,?,?,?,?)`,
      [createUlid(), planVersionId, index + 1, index + 1, section.questionType, section.itemCount, JSON.stringify({ rangeKey: section.rangeKey })],
    );
  }
  await db.execute("UPDATE assembly_plans SET current_version_id=?,status='draft',row_version=row_version+1 WHERE id=?", [planVersionId, planId]);
  await db.execute(
    `INSERT INTO audit_logs(id,project_id,actor_id,action,object_type,object_id,after_json,result)
     VALUES(?,?,?,'assembly.weight_adjust.confirm','assembly_plan',?,?,'success')`,
    [createUlid(), context.plan.project_id, actorId, planId, JSON.stringify({ snapshot, planVersionId, sourcePlanVersionId: context.plan.current_version_id })],
  );
  return { adjusted: true, structureId, structureVersionId, planVersionId, message: "已确认并保存调整结构和计划新版本，尚未组卷；请再次点击执行组卷。" };
}

export async function executeWeightedAssembly(db: PoolConnection, planId: string, actorId: string) {
  const context = await loadContext(db, planId);
  const presentation: PaperPresentation = {
    format: paperFormat(context.plan.assessment_mode), occupationName: context.plan.occupation_name,
    levelCode: context.plan.level_code, assessmentMode: context.plan.assessment_mode, durationMinutes: Number(context.plan.duration_minutes),
  };
  let allocation;
  try { allocation = allocateWeighted(context.sections, context.basis.ranges, context.inventory, context.paperCount); }
  catch (error) {
    const validation = await previewWeightedAssembly(db, planId);
    const message = error instanceof Error ? error.message : validation.message;
    await db.execute(
      `INSERT INTO assembly_runs(id,assembly_plan_version_id,project_id,status,gap_json,selection_summary_json,requested_by,started_at,finished_at)
       VALUES(?,?,?,'failed',?,?,?,NOW(3),NOW(3))`,
      [createUlid(), context.plan.current_version_id, context.plan.project_id, JSON.stringify({ message, ranges: validation.ranges }),
        JSON.stringify({ policy: "strict_range_score_v1", basis: context.basis, excluded: context.excluded }), actorId],
    );
    await db.execute("UPDATE assembly_plans SET status='incomplete' WHERE id=?", [planId]);
    return { executed: false, message, validation };
  }
  const pools = new Map<string, WeightedQuestion[]>();
  for (const question of context.questions) {
    const key = inventoryKey(question.rangeKey, question.type);
    const bucket = pools.get(key) ?? [];
    bucket.push(question);
    pools.set(key, bucket);
  }
  for (const pool of pools.values()) {
    for (let i = pool.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
  }
  const runId = createUlid(), paperIds: string[] = [];
  for (const [paperIndex, cells] of allocation.entries()) {
    const paperRunId = paperIndex ? createUlid() : runId, paperId = createUlid();
    const actual = new Map(context.basis.ranges.map((range) => [range.key, 0]));
    await db.execute(
      `INSERT INTO assembly_runs(id,assembly_plan_version_id,project_id,status,requested_by,started_at)
       VALUES(?,?,?,'running',?,NOW(3))`,
      [paperRunId, context.plan.current_version_id, context.plan.project_id, actorId],
    );
    await db.execute(
      `INSERT INTO papers(id,project_id,paper_no,assembly_run_id,assembly_plan_version_id,paper_structure_version_id,title,snapshot_hash)
       VALUES(?,?,?,?,?,?,?,?)`,
      [paperId, context.plan.project_id, assemblyPaperNumber(runId, paperIndex + 1), paperRunId, context.plan.current_version_id,
        context.plan.paper_structure_version_id, `${context.plan.name} 第${paperIndex + 1}套`,
        createHash("sha256").update(JSON.stringify({ basis: context.basis, cells, sections: context.sections })).digest("hex")],
    );
    let itemNo = 0, paperCents = 0;
    const selectedVersions: Array<{ versionId: string; rangeKey: string; score: number }> = [];
    for (const cell of [...cells].sort((a, b) => a.section - b.section)) {
      const section = context.sections[cell.section], cents = scoreCents(section.scorePerItem);
      const pool = pools.get(inventoryKey(cell.range, section.questionType))!;
      for (let i = 0; i < cell.count; i++) {
        const question = pool.pop();
        if (!question) throw new Error("范围库存发生变化，已回滚整次组卷，请重新检查。");
        const itemId = createUlid();
        itemNo++; paperCents += cents;
        selectedVersions.push({ versionId: question.versionId, rangeKey: cell.range, score: section.scorePerItem });
        actual.set(cell.range, actual.get(cell.range)! + cents);
        const range = context.basis.ranges.find((item) => item.key === cell.range)!;
        const content = {
          ...parseRecord(question.content),
          assemblyWeightRange: { ...range, direction: context.basis.direction, weightVersionId: context.basis.versionId },
          assemblyPresentation: { evaluationPoint: question.evaluationPoint, skillExam: parseRecord(parseRecord(question.content).skillExam) },
        };
        const rubric = question.type === "实操题" ? scaleRubric(question.rubric, section.scorePerItem) : question.rubric;
        await db.execute(
          `INSERT INTO paper_items(id,paper_id,item_no,section_no,question_id,question_version_id,question_no_snapshot,question_type,
           stem_snapshot,content_snapshot_json,answer_snapshot_json,score_rubric_snapshot_json,score,ordering)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [itemId, paperId, itemNo, context.sectionNumbers[cell.section], question.id, question.versionId, question.number,
            section.questionType, question.stem, JSON.stringify(content), JSON.stringify(question.answer),
            rubric ? JSON.stringify(rubric) : null, section.scorePerItem, itemNo],
        );
        for (const nodeId of question.nodeIds) {
          await db.execute("INSERT INTO paper_item_points(paper_item_id,assessment_point_id,coverage_weight) VALUES(?,?,?)",
            [itemId, nodeId, 1 / question.nodeIds.length]);
        }
      }
    }
    if (itemNo !== Number(context.plan.total_items) || paperCents !== 10000 ||
      context.targets.some((range) => actual.get(range.key) !== range.targetCents)) {
      throw new Error("最终试卷题量、总分或范围配分不符合权重，已回滚整次组卷。");
    }
    const summary = {
      policy: "strict_range_score_v1", basis: context.basis, structureVersionId: context.plan.paper_structure_version_id,
      presentation, excluded: context.excluded, ranges: context.targets.map((range) => ({
        ...range, targetScore: range.targetCents / 100, actualScore: actual.get(range.key)! / 100,
      })),
    };
    await db.execute("UPDATE papers SET snapshot_hash=? WHERE id=?", [
      createHash("sha256").update(JSON.stringify({ basis: context.basis, presentation, sections: context.sections, selectedVersions })).digest("hex"), paperId,
    ]);
    await db.execute("UPDATE assembly_runs SET status='succeeded',selection_summary_json=?,finished_at=NOW(3) WHERE id=?",
      [JSON.stringify(summary), paperRunId]);
    paperIds.push(paperId);
  }
  await db.execute("UPDATE assembly_plans SET status='completed' WHERE id=?", [planId]);
  await db.execute(
    `INSERT INTO audit_logs(id,project_id,actor_id,action,object_type,object_id,after_json,result)
     VALUES(?,?,?,'assembly.weighted.execute','assembly_plan',?,?,'success')`,
    [createUlid(), context.plan.project_id, actorId, planId, JSON.stringify({ paperIds, basis: context.basis, allocation })],
  );
  return { executed: true, paperIds, presentation };
}
