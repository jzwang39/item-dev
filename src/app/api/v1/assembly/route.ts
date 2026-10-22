import type { RowDataPacket } from "mysql2/promise";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getVerifiedSession } from "@/auth";
import { createUlid } from "@/shared/database/ulid";
import { query, withTransaction } from "@/shared/database/mysql";

const levels = ["level_5", "level_4", "level_3", "level_2", "level_1"] as const;
const modes = ["theory", "skill"] as const;
const questionTypeVariants = (type: string) => {
  const base = type.replace(/^[A-Z]\s+/, "");
  const letter = type.match(/^([A-Z])\s+/)?.[1];
  return [base, letter ? `${letter} ${base}` : type];
};
const sectionSchema = z.object({
  questionType: z.string().min(1),
  itemCount: z.number().int().min(0),
  scorePerItem: z.number().positive(),
});
const structureSchema = z.object({
  action: z.literal("structure"),
  structureId: z.string().length(26).optional(),
  name: z.string().trim().min(1).max(300),
  occupationId: z.string().length(26),
  levelCode: z.enum(levels),
  assessmentMode: z.enum(modes),
  durationMinutes: z.number().int().positive(),
  sections: z.array(sectionSchema).min(1),
});
const planSchema = z.object({
  action: z.literal("plan"),
  planId: z.string().length(26).optional(),
  name: z.string().trim().min(1).max(300),
  structureVersionId: z.string().length(26),
  paperCount: z.number().int().min(1).max(10),
});
const actionSchema = z.object({
  action: z.enum(["execute", "delete"]),
  planId: z.string().length(26),
});

export async function GET(request: Request) {
  const session = await getVerifiedSession();
  if (!session?.user?.id)
    return NextResponse.json(
      { error: { code: "UNAUTHENTICATED", message: "登录已失效。" } },
      { status: 401 },
    );
  const [occupations, structures, plans, papers] = await Promise.all([
    query<(RowDataPacket & { id: string; name: string; code: string })[]>(
      "SELECT po.id, po.name, po.code FROM project_occupations po INNER JOIN projects p ON p.id = po.project_id WHERE p.status = 'active' AND po.status = 'active' ORDER BY po.name",
    ),
    query<
      (RowDataPacket & {
        id: string;
        name: string;
        current_version_id: string;
        occupation_id: string;
        occupation_name: string;
        level_code: string;
        assessment_mode: string;
        duration_minutes: number;
        total_items: number;
        total_score: number;
        snapshot_json: unknown;
      })[]
    >(
      `SELECT ps.id, ps.name, ps.current_version_id, ps.occupation_id, po.name AS occupation_name, ps.level_code, ps.assessment_mode, psv.duration_minutes, psv.total_items, psv.total_score, psv.snapshot_json FROM paper_structures ps INNER JOIN paper_structure_versions psv ON psv.id = ps.current_version_id INNER JOIN project_occupations po ON po.id = ps.occupation_id WHERE ps.status <> 'archived' ORDER BY ps.updated_at DESC`,
    ),
    query<
      (RowDataPacket & {
        id: string;
        name: string;
        status: string;
        current_version_id: string | null;
      })[]
    >(
      "SELECT id, name, status, current_version_id FROM assembly_plans WHERE status <> 'cancelled' ORDER BY updated_at DESC",
    ),
    query<
      (RowDataPacket & {
        id: string;
        paper_no: string;
        title: string;
        generated_at: string;
        plan_name: string;
        occupation_name: string;
        level_code: string;
        assessment_mode: string;
        item_count: number;
      })[]
    >(
      `SELECT p.id, p.paper_no, p.title, p.generated_at, ap.name AS plan_name,
        po.name AS occupation_name, ap.level_code, ap.assessment_mode, COUNT(pi.id) AS item_count
       FROM papers p
       INNER JOIN assembly_plan_versions apv ON apv.id = p.assembly_plan_version_id
       INNER JOIN assembly_plans ap ON ap.id = apv.assembly_plan_id
       INNER JOIN project_occupations po ON po.id = ap.occupation_id
       LEFT JOIN paper_items pi ON pi.paper_id = p.id
       WHERE p.status = 'generated'
       GROUP BY p.id, p.paper_no, p.title, p.generated_at, ap.name, po.name, ap.level_code, ap.assessment_mode
       ORDER BY p.generated_at DESC`,
    ),
  ]);
  const paperId = new URL(request.url).searchParams.get("paperId");
  if (paperId) {
    const [paperRows, items] = await Promise.all([
      query<
        (RowDataPacket & {
          id: string;
          paper_no: string;
          title: string;
          generated_at: string;
          plan_name: string;
          occupation_name: string;
          level_code: string;
          assessment_mode: string;
        })[]
      >(
        `SELECT p.id, p.paper_no, p.title, p.generated_at, ap.name AS plan_name,
          po.name AS occupation_name, ap.level_code, ap.assessment_mode
         FROM papers p
         INNER JOIN assembly_plan_versions apv ON apv.id = p.assembly_plan_version_id
         INNER JOIN assembly_plans ap ON ap.id = apv.assembly_plan_id
         INNER JOIN project_occupations po ON po.id = ap.occupation_id
         WHERE p.id = ? AND p.status = 'generated'`,
        [paperId],
      ),
      query<
        (RowDataPacket & {
          item_no: number;
          question_no_snapshot: string;
          question_type: string;
          stem_snapshot: string;
          content_snapshot_json: unknown;
          answer_snapshot_json: unknown;
          score: number;
        })[]
      >(
        `SELECT item_no, question_no_snapshot, question_type, stem_snapshot,
          content_snapshot_json, answer_snapshot_json, score
         FROM paper_items WHERE paper_id = ? ORDER BY item_no`,
        [paperId],
      ),
    ]);
    if (!paperRows[0])
      return NextResponse.json(
        { error: { code: "NOT_FOUND", message: "试卷不存在。" } },
        { status: 404 },
      );
    return NextResponse.json({
      data: {
        ...paperRows[0],
        items: items.map((item) => ({
          ...item,
          content_snapshot_json:
            typeof item.content_snapshot_json === "string"
              ? JSON.parse(item.content_snapshot_json)
              : item.content_snapshot_json,
          answer_snapshot_json:
            typeof item.answer_snapshot_json === "string"
              ? JSON.parse(item.answer_snapshot_json)
              : item.answer_snapshot_json,
        })),
      },
    });
  }
  const planId = new URL(request.url).searchParams.get("planId");
  if (planId) {
    const [planRows, slots] = await Promise.all([
      query<
        (RowDataPacket & {
          id: string;
          name: string;
          status: string;
          level_code: string;
          assessment_mode: string;
          occupation_name: string;
          snapshot_json: unknown;
          paper_structure_version_id: string;
          structure_name: string;
          total_items: number;
          total_score: number;
        })[]
      >(
        `SELECT ap.id, ap.name, ap.status, ap.level_code, ap.assessment_mode, po.name occupation_name, apv.snapshot_json, apv.paper_structure_version_id, ps.name structure_name, psv.total_items, psv.total_score FROM assembly_plans ap INNER JOIN assembly_plan_versions apv ON apv.id=ap.current_version_id INNER JOIN project_occupations po ON po.id=ap.occupation_id INNER JOIN paper_structure_versions psv ON psv.id=apv.paper_structure_version_id INNER JOIN paper_structures ps ON ps.id=psv.paper_structure_id WHERE ap.id=?`,
        [planId],
      ),
      query<
        (RowDataPacket & {
          slot_no: number;
          section_no: number;
          question_type: string;
          required_count: number;
        })[]
      >(
        "SELECT slot_no, section_no, question_type, required_count FROM assembly_plan_slots WHERE assembly_plan_version_id=(SELECT current_version_id FROM assembly_plans WHERE id=?) ORDER BY slot_no",
        [planId],
      ),
    ]);
    if (!planRows[0])
      return NextResponse.json(
        { error: { code: "NOT_FOUND", message: "组卷计划不存在。" } },
        { status: 404 },
      );
    return NextResponse.json({
      data: {
        ...planRows[0],
        snapshot_json:
          typeof planRows[0].snapshot_json === "string"
            ? JSON.parse(planRows[0].snapshot_json)
            : planRows[0].snapshot_json,
        slots,
      },
    });
  }
  const planDetails = await query<
    (RowDataPacket & {
      id: string;
      name: string;
      status: string;
      current_version_id: string | null;
      occupation_name: string;
      level_code: string;
      assessment_mode: string;
      structure_name: string;
      paper_count: number;
    })[]
  >(
    `SELECT ap.id, ap.name, ap.status, ap.current_version_id, po.name occupation_name, ap.level_code, ap.assessment_mode, ps.name structure_name, CAST(JSON_UNQUOTE(JSON_EXTRACT(apv.snapshot_json, '$.paperCount')) AS UNSIGNED) paper_count FROM assembly_plans ap INNER JOIN assembly_plan_versions apv ON apv.id=ap.current_version_id INNER JOIN project_occupations po ON po.id=ap.occupation_id INNER JOIN paper_structure_versions psv ON psv.id=apv.paper_structure_version_id INNER JOIN paper_structures ps ON ps.id=psv.paper_structure_id WHERE ap.status <> 'cancelled' ORDER BY ap.updated_at DESC`,
  );
  return NextResponse.json({
    data: {
      occupations,
      structures: structures.map((structure) => ({
        ...structure,
        snapshot_json:
          typeof structure.snapshot_json === "string"
            ? JSON.parse(structure.snapshot_json)
            : structure.snapshot_json,
      })),
      plans: planDetails,
      paperCount: papers.length,
      papers,
    },
  });
}

export async function POST(request: Request) {
  const session = await getVerifiedSession();
  if (!session?.user?.id)
    return NextResponse.json(
      { error: { code: "UNAUTHENTICATED", message: "登录已失效。" } },
      { status: 401 },
    );
  if (session.user.role !== "admin")
    return NextResponse.json(
      {
        error: { code: "FORBIDDEN", message: "仅管理员可维护组卷结构与计划。" },
      },
      { status: 403 },
    );
  const payload = await request.json();
  const parsed =
    payload.action === "plan"
      ? planSchema.safeParse(payload)
      : ["execute", "delete"].includes(payload.action)
        ? actionSchema.safeParse(payload)
        : structureSchema.safeParse(payload);
  if (!parsed.success)
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_FAILED",
          message: parsed.error.issues[0]?.message ?? "组卷数据不完整。",
        },
      },
      { status: 400 },
    );

  try {
    const result = await withTransaction(async (connection) => {
      if (parsed.data.action === "structure") {
        const totalItems = parsed.data.sections.reduce(
          (sum, row) => sum + row.itemCount,
          0,
        );
        const totalScore = parsed.data.sections.reduce(
          (sum, row) => sum + row.itemCount * row.scorePerItem,
          0,
        );
        if (Math.abs(totalScore - 100) > 0.001)
          throw new Error("试卷总配分必须为 100 分。");
        if (
          parsed.data.assessmentMode === "theory" &&
          ["level_2", "level_1"].includes(parsed.data.levelCode) &&
          totalItems !== 46
        )
          throw new Error(
            "二级、一级理论知识试卷常规结构必须为 46 题、100 分；47 题选答结构须另行处理。",
          );
        const [occupation] = await connection.execute<
          (RowDataPacket & { project_id: string })[]
        >(
          "SELECT project_id FROM project_occupations WHERE id = ? AND status = 'active' FOR UPDATE",
          [parsed.data.occupationId],
        );
        if (!occupation[0]) throw new Error("职业不存在或已归档。");
        const structureId = parsed.data.structureId ?? createUlid();
        const versionId = createUlid();
        let versionNo = 1;
        if (parsed.data.structureId) {
          const [current] = await connection.execute<
            (RowDataPacket & {
              current_version_id: string;
              project_id: string;
              version_no: number;
            })[]
          >(
            "SELECT ps.current_version_id, ps.project_id, psv.version_no FROM paper_structures ps INNER JOIN paper_structure_versions psv ON psv.id = ps.current_version_id WHERE ps.id = ? FOR UPDATE",
            [structureId],
          );
          if (!current[0] || current[0].project_id !== occupation[0].project_id)
            throw new Error("试卷结构不存在或不属于当前项目。");
          versionNo = current[0].version_no + 1;
          await connection.execute(
            "UPDATE paper_structure_versions SET status = 'superseded' WHERE id = ?",
            [current[0].current_version_id],
          );
          await connection.execute(
            "UPDATE paper_structures SET name = ?, occupation_id = ?, level_code = ?, assessment_mode = ?, current_version_id = ?, status = 'published', row_version = row_version + 1 WHERE id = ?",
            [
              parsed.data.name,
              parsed.data.occupationId,
              parsed.data.levelCode,
              parsed.data.assessmentMode,
              versionId,
              structureId,
            ],
          );
        } else {
          await connection.execute(
            "INSERT INTO paper_structures (id, project_id, name, occupation_id, level_code, assessment_mode, current_version_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'published')",
            [
              structureId,
              occupation[0].project_id,
              parsed.data.name,
              parsed.data.occupationId,
              parsed.data.levelCode,
              parsed.data.assessmentMode,
              versionId,
            ],
          );
        }
        await connection.execute(
          "INSERT INTO paper_structure_versions (id, paper_structure_id, version_no, status, template_code, duration_minutes, total_items, total_score, snapshot_json, published_at) VALUES (?, ?, ?, 'published', 'standard', ?, ?, ?, ?, NOW(3))",
          [
            versionId,
            structureId,
            versionNo,
            parsed.data.durationMinutes,
            totalItems,
            totalScore,
            JSON.stringify(parsed.data),
          ],
        );
        for (const [index, row] of parsed.data.sections.entries())
          await connection.execute(
            "INSERT INTO paper_structure_sections (id, paper_structure_version_id, section_no, question_type, item_count, score_per_item, section_score, ordering) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [
              createUlid(),
              versionId,
              index + 1,
              row.questionType,
              row.itemCount,
              row.scorePerItem,
              row.itemCount * row.scorePerItem,
              index + 1,
            ],
          );
        await connection.execute(
          "INSERT INTO audit_logs (id, project_id, actor_id, action, object_type, object_id, after_json, result) VALUES (?, ?, ?, ?, 'paper_structure', ?, ?, 'success')",
          [
            createUlid(),
            occupation[0].project_id,
            session.user.id,
            parsed.data.structureId
              ? "paper_structure.update"
              : "paper_structure.create",
            structureId,
            JSON.stringify(parsed.data),
          ],
        );
        return { structureId, structureVersionId: versionId };
      }
      if (parsed.data.action === "delete") {
        await connection.execute(
          "UPDATE assembly_plans SET status='cancelled' WHERE id=?",
          [parsed.data.planId],
        );
        return { deleted: true };
      }
      if (parsed.data.action === "execute") {
        const [plan] = await connection.execute<
          (RowDataPacket & {
            project_id: string;
            occupation_id: string;
            level_code: string;
            assessment_mode: string;
            current_version_id: string;
            name: string;
            paper_structure_version_id: string;
            total_items: number;
            total_score: number;
          })[]
        >(
          `SELECT ap.project_id, ap.occupation_id, ap.level_code, ap.assessment_mode, ap.current_version_id, ap.name,
                  apv.paper_structure_version_id, psv.total_items, psv.total_score
             FROM assembly_plans ap
             INNER JOIN assembly_plan_versions apv ON apv.id=ap.current_version_id
             INNER JOIN paper_structure_versions psv ON psv.id=apv.paper_structure_version_id
            WHERE ap.id=? FOR UPDATE`,
          [parsed.data.planId],
        );
        if (!plan[0]) throw new Error("组卷计划不存在。");
        const [sections] = await connection.execute<
          (RowDataPacket & {
            section_no: number;
            question_type: string;
            item_count: number;
            score_per_item: number;
          })[]
        >(
          `SELECT section_no, question_type, item_count, score_per_item
             FROM paper_structure_sections
            WHERE paper_structure_version_id = ? AND item_count > 0
            ORDER BY section_no`,
          [plan[0].paper_structure_version_id],
        );
        if (!sections.length) throw new Error("试卷结构未配置有效题型分区。");
        const structureItems = sections.reduce(
          (total, section) => total + Number(section.item_count),
          0,
        );
        const structureScore = sections.reduce(
          (total, section) =>
            total + Number(section.item_count) * Number(section.score_per_item),
          0,
        );
        if (
          structureItems !== Number(plan[0].total_items) ||
          Math.abs(structureScore - Number(plan[0].total_score)) > 0.001
        )
          throw new Error(
            "试卷结构题量或总分与分区配置不一致，请重新保存结构后组卷。",
          );
        const [snapshotRows] = await connection.execute<
          (RowDataPacket & { snapshot_json: unknown })[]
        >("SELECT snapshot_json FROM assembly_plan_versions WHERE id=?", [
          plan[0].current_version_id,
        ]);
        const paperCount = Number(
          (typeof snapshotRows[0].snapshot_json === "string"
            ? JSON.parse(snapshotRows[0].snapshot_json)
            : (snapshotRows[0].snapshot_json as { paperCount?: number })
          ).paperCount ?? 1,
        );
        const requirements = new Map<string, number>();
        sections.forEach((section) =>
          requirements.set(
            section.question_type,
            (requirements.get(section.question_type) ?? 0) +
              Number(section.item_count) * paperCount,
          ),
        );
        const gaps: {
          questionType: string;
          required: number;
          available: number;
          shortage: number;
        }[] = [];
        for (const [questionType, required] of requirements) {
          const [baseType, prefixedType] = questionTypeVariants(questionType);
          const [rows] = await connection.execute<
            (RowDataPacket & { total: number })[]
          >(
            "SELECT COUNT(*) total FROM questions WHERE project_id=? AND occupation_id=? AND level_code=? AND assessment_mode=? AND question_type IN (?,?) AND current_status='stored'",
            [
              plan[0].project_id,
              plan[0].occupation_id,
              plan[0].level_code,
              plan[0].assessment_mode,
              baseType,
              prefixedType,
            ],
          );
          if (Number(rows[0].total) < required)
            gaps.push({
              questionType,
              required,
              available: Number(rows[0].total),
              shortage: required - Number(rows[0].total),
            });
        }
        const runId = createUlid();
        if (gaps.length) {
          await connection.execute(
            "INSERT INTO assembly_runs (id, assembly_plan_version_id, project_id, status, gap_json, requested_by, started_at, finished_at) VALUES (?, ?, ?, 'failed', ?, ?, NOW(3), NOW(3))",
            [
              runId,
              plan[0].current_version_id,
              plan[0].project_id,
              JSON.stringify(gaps),
              session.user.id,
            ],
          );
          await connection.execute(
            "UPDATE assembly_plans SET status='incomplete' WHERE id=?",
            [parsed.data.planId],
          );
          return { executed: false, gaps };
        }
        const selected = new Set<string>();
        const runs: string[] = [];
        for (let paperIndex = 1; paperIndex <= paperCount; paperIndex++) {
          const paperRunId = paperIndex === 1 ? runId : createUlid();
          const paperId = createUlid();
          let itemNo = 0;
          await connection.execute(
            "INSERT INTO assembly_runs (id, assembly_plan_version_id, project_id, status, requested_by, started_at) VALUES (?, ?, ?, 'running', ?, NOW(3))",
            [
              paperRunId,
              plan[0].current_version_id,
              plan[0].project_id,
              session.user.id,
            ],
          );
          await connection.execute(
            "INSERT INTO papers (id, project_id, paper_no, assembly_run_id, assembly_plan_version_id, paper_structure_version_id, title, snapshot_hash) VALUES (?, ?, ?, ?, ?, ?, ?, SHA2(?,256))",
            [
              paperId,
              plan[0].project_id,
              `${parsed.data.planId.slice(-6)}-${paperIndex}`,
              paperRunId,
              plan[0].current_version_id,
              plan[0].paper_structure_version_id,
              `${plan[0].name} 第${paperIndex}套`,
              plan[0].name,
            ],
          );
          let paperScore = 0;
          for (const section of sections) {
            const [baseType, prefixedType] = questionTypeVariants(
              section.question_type,
            );
            const [candidates] = await connection.execute<
              (RowDataPacket & {
                id: string;
                current_version_id: string;
                question_no: string;
                stem: string;
                content_json: unknown;
                answer_json: unknown;
              })[]
            >(
              `SELECT q.id,q.current_version_id,q.question_no,qv.stem,qv.content_json,qv.answer_json FROM questions q INNER JOIN question_versions qv ON qv.id=q.current_version_id WHERE q.project_id=? AND q.occupation_id=? AND q.level_code=? AND q.assessment_mode=? AND q.question_type IN (?,?) AND q.current_status='stored' ORDER BY RAND() LIMIT ?`,
              [
                plan[0].project_id,
                plan[0].occupation_id,
                plan[0].level_code,
                plan[0].assessment_mode,
                baseType,
                prefixedType,
                Number(section.item_count) + selected.size,
              ],
            );
            const picks = candidates
              .filter(
                (candidate) => !selected.has(candidate.current_version_id),
              )
              .slice(0, Number(section.item_count));
            if (picks.length !== Number(section.item_count))
              throw new Error("题目去重后数量不足，请重新检查题库。");
            for (const question of picks) {
              selected.add(question.current_version_id);
              itemNo++;
              paperScore += Number(section.score_per_item);
              await connection.execute(
                "INSERT INTO paper_items (id,paper_id,item_no,section_no,question_id,question_version_id,question_no_snapshot,question_type,stem_snapshot,content_snapshot_json,answer_snapshot_json,score,ordering) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                [
                  createUlid(),
                  paperId,
                  itemNo,
                  section.section_no,
                  question.id,
                  question.current_version_id,
                  question.question_no,
                  section.question_type,
                  question.stem,
                  JSON.stringify(question.content_json),
                  JSON.stringify(question.answer_json),
                  section.score_per_item,
                  itemNo,
                ],
              );
            }
          }
          if (
            itemNo !== Number(plan[0].total_items) ||
            Math.abs(paperScore - Number(plan[0].total_score)) > 0.001
          )
            throw new Error("组卷结果题量或总分与试卷结构不一致，已取消生成。");
          await connection.execute(
            "UPDATE assembly_runs SET status='succeeded', finished_at=NOW(3) WHERE id=?",
            [paperRunId],
          );
          runs.push(paperId);
        }
        await connection.execute(
          "UPDATE assembly_plans SET status='completed' WHERE id=?",
          [parsed.data.planId],
        );
        return { executed: true, paperIds: runs };
      }
      const planData = parsed.data as z.infer<typeof planSchema>;
      const [structure] = await connection.execute<
        (RowDataPacket & {
          project_id: string;
          occupation_id: string;
          level_code: string;
          assessment_mode: string;
        })[]
      >(
        "SELECT ps.project_id, ps.occupation_id, ps.level_code, ps.assessment_mode FROM paper_structures ps WHERE ps.current_version_id = ? FOR UPDATE",
        [planData.structureVersionId],
      );
      if (!structure[0]) throw new Error("关联试卷结构不存在。");
      const planId = planData.planId ?? createUlid();
      const versionId = createUlid();
      let versionNo = 1;
      if (planData.planId) {
        const [old] = await connection.execute<
          (RowDataPacket & { version_no: number })[]
        >(
          "SELECT apv.version_no FROM assembly_plans ap JOIN assembly_plan_versions apv ON apv.id=ap.current_version_id WHERE ap.id=? FOR UPDATE",
          [planId],
        );
        if (!old[0]) throw new Error("组卷计划不存在。");
        versionNo = old[0].version_no + 1;
        await connection.execute(
          "UPDATE assembly_plans SET name=?, occupation_id=?, level_code=?, assessment_mode=?, current_version_id=?, status='draft' WHERE id=?",
          [
            planData.name,
            structure[0].occupation_id,
            structure[0].level_code,
            structure[0].assessment_mode,
            versionId,
            planId,
          ],
        );
      } else
        await connection.execute(
          "INSERT INTO assembly_plans (id, project_id, name, occupation_id, level_code, assessment_mode, current_version_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')",
          [
            planId,
            structure[0].project_id,
            planData.name,
            structure[0].occupation_id,
            structure[0].level_code,
            structure[0].assessment_mode,
            versionId,
          ],
        );
      await connection.execute(
        "INSERT INTO assembly_plan_versions (id, assembly_plan_id, version_no, paper_structure_version_id, status, candidate_filter_json, snapshot_json) VALUES (?, ?, ?, ?, 'draft', ?, ?)",
        [
          versionId,
          planId,
          versionNo,
          planData.structureVersionId,
          JSON.stringify({ status: "stored" }),
          JSON.stringify(planData),
        ],
      );
      const [sections] = await connection.execute<
        (RowDataPacket & {
          section_no: number;
          question_type: string;
          item_count: number;
        })[]
      >(
        "SELECT section_no, question_type, item_count FROM paper_structure_sections WHERE paper_structure_version_id=? AND item_count>0 ORDER BY section_no",
        [planData.structureVersionId],
      );
      let slotNo = 0;
      for (const section of sections) {
        slotNo++;
        await connection.execute(
          "INSERT INTO assembly_plan_slots (id,assembly_plan_version_id,slot_no,section_no,question_type,required_count) VALUES (?,?,?,?,?,?)",
          [
            createUlid(),
            versionId,
            slotNo,
            section.section_no,
            section.question_type,
            section.item_count,
          ],
        );
      }
      await connection.execute(
        "INSERT INTO audit_logs (id, project_id, actor_id, action, object_type, object_id, after_json, result) VALUES (?, ?, ?, 'assembly_plan.create', 'assembly_plan', ?, ?, 'success')",
        [
          createUlid(),
          structure[0].project_id,
          session.user.id,
          planId,
          JSON.stringify(parsed.data),
        ],
      );
      return { planId, planVersionId: versionId };
    });
    return NextResponse.json({ data: result }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      {
        error: {
          code: "ASSEMBLY_SAVE_FAILED",
          message: error instanceof Error ? error.message : "保存失败。",
        },
      },
      { status: 422 },
    );
  }
}
