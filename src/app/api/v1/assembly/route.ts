import type { RowDataPacket } from "mysql2/promise";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getVerifiedSession } from "@/auth";
import { createUlid } from "@/shared/database/ulid";
import { query, withTransaction } from "@/shared/database/mysql";
import { confirmWeightedAdjustment, executeWeightedAssembly, previewWeightedAssembly } from "@/modules/assembly/weighted-service";
import { scoreCents } from "@/modules/assembly/weight-policy";
import { paperItemContent, parseRecord, type PaperPresentation } from "@/modules/documents/paper-presentation";

const levels = ["level_5", "level_4", "level_3", "level_2", "level_1"] as const;
const modes = ["theory", "skill"] as const;
const sectionSchema = z.object({
  questionType: z.string().min(1),
  itemCount: z.number().int().min(0),
  scorePerItem: z.number().positive(),
  rangeKey: z.string().min(1).max(300).optional(),
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
  weightDirection: z.string().trim().max(100).optional(),
});
const actionSchema = z.object({
  action: z.enum(["execute", "delete", "weight_preview", "weight_adjust"]),
  planId: z.string().length(26),
  fingerprint: z.string().length(64).optional(),
});

export async function GET(request: Request) {
  const session = await getVerifiedSession();
  if (!session?.user?.id)
    return NextResponse.json(
      { error: { code: "UNAUTHENTICATED", message: "登录已失效。" } },
      { status: 401 },
    );
  const [occupations, structures, papers] = await Promise.all([
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
        updated_at: Date;
      })[]
    >(
      `SELECT ps.id, ps.name, ps.current_version_id, ps.updated_at, ps.occupation_id, po.name AS occupation_name, ps.level_code, ps.assessment_mode, psv.duration_minutes, psv.total_items, psv.total_score, psv.snapshot_json FROM paper_structures ps INNER JOIN paper_structure_versions psv ON psv.id = ps.current_version_id INNER JOIN project_occupations po ON po.id = ps.occupation_id WHERE ps.status <> 'archived' ORDER BY ps.updated_at DESC, ps.id DESC`,
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
          po.name AS occupation_name, ap.level_code, ap.assessment_mode, ar.selection_summary_json,psv.duration_minutes
         FROM papers p
         INNER JOIN assembly_runs ar ON ar.id=p.assembly_run_id
         INNER JOIN assembly_plan_versions apv ON apv.id = p.assembly_plan_version_id
         INNER JOIN paper_structure_versions psv ON psv.id=p.paper_structure_version_id
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
          assessment_point_names?: unknown;
          score: number;
        })[]
      >(
        `SELECT item_no,section_no,question_no_snapshot,question_type,stem_snapshot,
          content_snapshot_json,answer_snapshot_json,score_rubric_snapshot_json,score,
          (SELECT JSON_ARRAYAGG(n.name) FROM question_assessment_points qp JOIN blueprint_nodes n ON n.id=qp.blueprint_node_id
           WHERE qp.question_version_id=paper_items.question_version_id) AS assessment_point_names
         FROM paper_items WHERE paper_id = ? ORDER BY item_no`,
        [paperId],
      ),
    ]);
    if (!paperRows[0])
      return NextResponse.json(
        { error: { code: "NOT_FOUND", message: "试卷不存在。" } },
        { status: 404 },
      );
    const presentation = parseRecord(paperRows[0].selection_summary_json).presentation as PaperPresentation | undefined;
    return NextResponse.json({
      data: {
        ...paperRows[0],
        ...(presentation ? { occupation_name: presentation.occupationName, level_code: presentation.levelCode,
          assessment_mode: presentation.assessmentMode, duration_minutes: presentation.durationMinutes } : {}),
        presentation,
        weightValidation: typeof paperRows[0].selection_summary_json === "string"
          ? JSON.parse(paperRows[0].selection_summary_json) : paperRows[0].selection_summary_json,
        items: items.map((item) => ({
          ...item,
          content_snapshot_json: paperItemContent(item),
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
      updated_at: Date;
    })[]
  >(
    `SELECT ap.id, ap.name, ap.status, ap.current_version_id, ap.updated_at, po.name occupation_name, ap.level_code, ap.assessment_mode, ps.name structure_name, CAST(JSON_UNQUOTE(JSON_EXTRACT(apv.snapshot_json, '$.paperCount')) AS UNSIGNED) paper_count FROM assembly_plans ap INNER JOIN assembly_plan_versions apv ON apv.id=ap.current_version_id INNER JOIN project_occupations po ON po.id=ap.occupation_id INNER JOIN paper_structure_versions psv ON psv.id=apv.paper_structure_version_id INNER JOIN paper_structures ps ON ps.id=psv.paper_structure_id WHERE ap.status <> 'cancelled' ORDER BY ap.updated_at DESC, ap.id DESC`,
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
      : ["execute", "delete", "weight_preview", "weight_adjust"].includes(payload.action)
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
        for (const section of parsed.data.sections) scoreCents(section.scorePerItem);
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
            "INSERT INTO paper_structure_sections (id, paper_structure_version_id, section_no, question_type, item_count, score_per_item, section_score, ordering, requirements_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
              createUlid(),
              versionId,
              index + 1,
              row.questionType,
              row.itemCount,
              row.scorePerItem,
              row.itemCount * row.scorePerItem,
              index + 1,
              row.rangeKey ? JSON.stringify({ rangeKey: row.rangeKey }) : null,
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
        return executeWeightedAssembly(connection, parsed.data.planId, session.user.id);
      }
      if (parsed.data.action === "weight_preview") {
        return previewWeightedAssembly(connection, parsed.data.planId);
      }
      if (parsed.data.action === "weight_adjust") {
        if (!parsed.data.fingerprint) throw new Error("请先查看并确认权重调整建议。");
        return confirmWeightedAdjustment(connection, parsed.data.planId, session.user.id, parsed.data.fingerprint);
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
