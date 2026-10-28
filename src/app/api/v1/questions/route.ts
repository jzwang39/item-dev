import type { RowDataPacket } from "mysql2/promise";
import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getVerifiedSession } from "@/auth";
import { createUlid } from "@/shared/database/ulid";
import { query, withTransaction } from "@/shared/database/mysql";
import { bulkStorageSchema } from "@/modules/authoring/question-storage-policy";
import { storeQuestions } from "@/modules/authoring/question-storage";

const levelCodes = [
  "level_5",
  "level_4",
  "level_3",
  "level_2",
  "level_1",
] as const;
const assessmentModes = ["theory", "skill"] as const;
const statusCodes = [
  "draft",
  "pending_review",
  "returned",
  "approved",
  "stored",
  "archived",
] as const;
const submitSchema = z.object({ questionId: z.string().length(26) });

type QuestionRow = RowDataPacket & {
  id: string;
  question_no: string;
  occupation_name: string;
  occupation_code: string;
  level_code: (typeof levelCodes)[number];
  assessment_mode: (typeof assessmentModes)[number];
  question_type: string;
  current_status: (typeof statusCodes)[number];
  current_version_id: string | null;
  is_confirmed: number;
  difficulty: "easy" | "medium" | "hard" | null;
  created_at: string;
  stem: string | null;
  content_json: unknown;
  answer_json: unknown;
  analysis_text: string | null;
  point_codes: string | null;
  point_names: string | null;
};

const levelLabels: Record<(typeof levelCodes)[number], string> = {
  level_5: "五级 / 初级工",
  level_4: "四级 / 中级工",
  level_3: "三级 / 高级工",
  level_2: "二级 / 技师",
  level_1: "一级 / 高级技师",
};

type ResultScopeRow = RowDataPacket & {
  occupation_id: string;
  occupation_name: string;
  occupation_code: string;
  level_code: (typeof levelCodes)[number];
  assessment_mode: (typeof assessmentModes)[number];
  question_count: number;
};

function guard(session: Awaited<ReturnType<typeof getVerifiedSession>>) {
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: { code: "UNAUTHENTICATED", message: "登录已失效。" } },
      { status: 401 },
    );
  }
  return null;
}

function parseJson(value: unknown) {
  if (typeof value !== "string") return value ?? {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

export async function GET(request: Request) {
  const session = await getVerifiedSession();
  const rejection = guard(session);
  if (rejection) return rejection;

  const params = new URL(request.url).searchParams;
  const view = params.get("view");
  if (view === "storage-candidates" && session!.user.role !== "admin") {
    return NextResponse.json({ error: { code: "FORBIDDEN", message: "仅管理员可选择批量入库试题。" } }, { status: 403 });
  }

  if (
    session!.user.role === "expert" &&
    ["download", "results"].includes(view ?? "")
  ) {
    return NextResponse.json(
      {
        error: {
          code: "FORBIDDEN",
          message: "专家账号仅可检索和查看授权范围内的试题。",
        },
      },
      { status: 403 },
    );
  }

  if (view === "download") {
    const occupationId = params.get("occupationId");
    const levelCode = params.get("levelCode");
    const assessmentMode = params.get("assessmentMode");
    const file = params.get("file");
    if (
      !occupationId ||
      !levelCodes.includes(levelCode as (typeof levelCodes)[number]) ||
      !assessmentModes.includes(
        assessmentMode as (typeof assessmentModes)[number],
      ) ||
      !["question-bank", "outline"].includes(file ?? "")
    ) {
      return NextResponse.json(
        {
          error: {
            code: "VALIDATION_FAILED",
            message: "下载范围或文件类型无效。",
          },
        },
        { status: 400 },
      );
    }
    try {
      const [scope] = await query<
        (RowDataPacket & {
          project_id: string;
          occupation_name: string;
          occupation_code: string;
        })[]
      >(
        `SELECT p.id AS project_id, po.name AS occupation_name, po.code AS occupation_code
           FROM project_occupations po INNER JOIN projects p ON p.id = po.project_id
          WHERE po.id = ? AND po.status = 'active' AND p.status = 'active' LIMIT 1`,
        [occupationId],
      );
      if (!scope)
        return NextResponse.json(
          { error: { code: "NOT_FOUND", message: "职业范围不存在或已归档。" } },
          { status: 404 },
        );

      const workbook = new ExcelJS.Workbook();
      workbook.creator = "技能人才评价国家题库智能命题平台";
      const sheet = workbook.addWorksheet(
        file === "question-bank" ? "题库" : "考评要素",
      );
      if (file === "question-bank") {
        const rows = await query<
          (RowDataPacket & {
            question_no: string;
            question_type: string;
            stem: string;
            answer_json: unknown;
            analysis_text: string | null;
            point_code: string | null;
            point_name: string | null;
          })[]
        >(
          `SELECT q.question_no, q.question_type, qv.stem, qv.answer_json, qv.analysis_text,
                  GROUP_CONCAT(DISTINCT bn.node_code ORDER BY bn.node_code SEPARATOR '、') AS point_code,
                  GROUP_CONCAT(DISTINCT bn.name ORDER BY bn.ordinal SEPARATOR '、') AS point_name
             FROM questions q
             INNER JOIN question_versions qv ON qv.id = q.current_version_id
             LEFT JOIN question_assessment_points qap ON qap.question_version_id = qv.id
             LEFT JOIN blueprint_nodes bn ON bn.id = qap.blueprint_node_id
            WHERE q.occupation_id = ? AND q.level_code = ? AND q.assessment_mode = ?
              AND q.current_status IN ('approved', 'stored') AND q.archived_at IS NULL
            GROUP BY q.id, q.question_no, q.question_type, qv.stem, qv.answer_json, qv.analysis_text
            ORDER BY q.question_no`,
          [occupationId, levelCode!, assessmentMode!],
        );
        if (!rows.length)
          return NextResponse.json(
            {
              error: {
                code: "NO_APPROVED_QUESTIONS",
                message: "当前范围没有已审定试题，无法生成正式成果文件。",
              },
            },
            { status: 422 },
          );
        sheet.columns = [
          { header: "试题编号", key: "questionNo", width: 20 },
          { header: "题型", key: "type", width: 20 },
          { header: "题干", key: "stem", width: 58 },
          { header: "标准答案", key: "answer", width: 18 },
          { header: "答案解析", key: "analysis", width: 52 },
          { header: "考评点代码", key: "pointCode", width: 28 },
          { header: "考评点", key: "pointName", width: 30 },
        ];
        rows.forEach((row) =>
          sheet.addRow({
            questionNo: row.question_no,
            type: row.question_type,
            stem: row.stem,
            answer: JSON.stringify(parseJson(row.answer_json)),
            analysis: row.analysis_text ?? "",
            pointCode: row.point_code ?? "",
            pointName: row.point_name ?? "",
          }),
        );
      } else {
        const rows = await query<
          (RowDataPacket & {
            node_code: string;
            name: string;
            weight: string | null;
            importance: string | null;
            requirement_json: unknown;
          })[]
        >(
          `SELECT bn.node_code, bn.name, bn.weight, bn.importance, bn.requirement_json
             FROM blueprints b
             INNER JOIN blueprint_nodes bn ON bn.blueprint_version_id = b.current_version_id
            WHERE b.occupation_id = ? AND b.level_code = ? AND b.assessment_mode = ?
              AND b.blueprint_kind = ? AND b.current_version_id IS NOT NULL
            ORDER BY bn.ordinal`,
          [
            occupationId,
            levelCode!,
            assessmentMode!,
            assessmentMode === "theory" ? "theory_outline" : "skill_outline",
          ],
        );
        if (!rows.length)
          return NextResponse.json(
            {
              error: {
                code: "NO_OUTLINE",
                message: "当前范围尚未维护细目表，无法生成成果文件。",
              },
            },
            { status: 422 },
          );
        sheet.columns = [
          { header: "考评点代码", key: "code", width: 28 },
          { header: "考评点名称", key: "name", width: 42 },
          { header: "权重", key: "weight", width: 15 },
          { header: "重要程度", key: "importance", width: 16 },
          { header: "要求", key: "requirement", width: 48 },
        ];
        rows.forEach((row) =>
          sheet.addRow({
            code: row.node_code,
            name: row.name,
            weight: row.weight ?? "",
            importance: row.importance ?? "",
            requirement: JSON.stringify(parseJson(row.requirement_json)),
          }),
        );
      }
      sheet.getRow(1).font = { bold: true };
      sheet.views = [{ state: "frozen", ySplit: 1 }];
      const filename = `${scope.occupation_name}-${levelLabels[levelCode as (typeof levelCodes)[number]]}-${assessmentMode === "theory" ? "理论知识" : "操作技能"}-${file === "question-bank" ? "题库" : "考评要素细目表"}.xlsx`;
      const bytes = await workbook.xlsx.writeBuffer();
      return new NextResponse(bytes, {
        headers: {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        },
      });
    } catch (error) {
      return NextResponse.json(
        {
          error: {
            code: "RESULT_DOWNLOAD_FAILED",
            message:
              error instanceof Error ? error.message : "成果文件生成失败。",
          },
        },
        { status: 500 },
      );
    }
  }

  if (view === "results") {
    try {
      const rows = await query<ResultScopeRow[]>(
        `SELECT po.id AS occupation_id, po.name AS occupation_name, po.code AS occupation_code,
                scope.level_code, scope.assessment_mode, COUNT(q.id) AS question_count
           FROM project_occupations po
           INNER JOIN projects p ON p.id = po.project_id AND p.status = 'active'
           INNER JOIN (
             SELECT 'level_5' AS level_code, 'theory' AS assessment_mode
             UNION ALL SELECT 'level_4', 'theory'
             UNION ALL SELECT 'level_3', 'theory'
             UNION ALL SELECT 'level_2', 'skill'
             UNION ALL SELECT 'level_1', 'skill'
           ) scope
           LEFT JOIN project_occupation_levels pol
             ON pol.occupation_id = po.id
            AND pol.level_code = scope.level_code
            AND pol.assessment_mode = scope.assessment_mode
           LEFT JOIN questions q ON q.occupation_id = po.id
                               AND q.level_code = scope.level_code
                               AND q.assessment_mode = scope.assessment_mode
                               AND q.current_status IN ('approved', 'stored')
                               AND q.archived_at IS NULL
          WHERE po.status = 'active'
            AND (
              pol.occupation_id IS NOT NULL
              OR NOT EXISTS (SELECT 1 FROM project_occupation_levels existing WHERE existing.occupation_id = po.id)
              OR EXISTS (
                SELECT 1 FROM questions existing_question
                 WHERE existing_question.occupation_id = po.id
                   AND existing_question.level_code = scope.level_code
                   AND existing_question.assessment_mode = scope.assessment_mode
                   AND existing_question.archived_at IS NULL
              )
            )
          GROUP BY po.id, po.name, po.code, scope.level_code, scope.assessment_mode
          ORDER BY po.name, FIELD(scope.level_code, 'level_5', 'level_4', 'level_3', 'level_2', 'level_1'), scope.assessment_mode`,
      );
      return NextResponse.json({
        data: rows.map((row) => ({
          occupationId: row.occupation_id,
          occupationName: row.occupation_name,
          occupationCode: row.occupation_code,
          levelCode: row.level_code,
          levelLabel: levelLabels[row.level_code],
          assessmentMode: row.assessment_mode,
          questionCount: Number(row.question_count),
        })),
      });
    } catch (error) {
      return NextResponse.json(
        {
          error: {
            code: "RESULT_SCOPE_LIST_FAILED",
            message:
              error instanceof Error ? error.message : "成果范围加载失败。",
          },
        },
        { status: 500 },
      );
    }
  }

  const assessmentMode = params.get("assessmentMode");
  const levelCode = params.get("levelCode");
  const questionType = params.get("questionType");
  const status = params.get("status");
  const keyword = params.get("keyword")?.trim() ?? "";
  const conditions = ["p.status = 'active'", "q.archived_at IS NULL"];
  const values: (string | number)[] = [];
  if (session!.user.role === "expert") {
    conditions.push(
      "EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = q.project_id AND pm.account_id = ? AND pm.status = 'active')",
    );
    values.push(session!.user.id);
  }

  if (
    assessmentModes.includes(assessmentMode as (typeof assessmentModes)[number])
  ) {
    conditions.push("q.assessment_mode = ?");
    values.push(assessmentMode!);
  }
  if (levelCodes.includes(levelCode as (typeof levelCodes)[number])) {
    conditions.push("q.level_code = ?");
    values.push(levelCode!);
  }
  if (questionType) {
    conditions.push("q.question_type = ?");
    values.push(questionType);
  }
  if (statusCodes.includes(status as (typeof statusCodes)[number])) {
    conditions.push("q.current_status = ?");
    values.push(status!);
  }
  if (keyword) {
    conditions.push(
      "(q.question_no LIKE ? OR qv.stem LIKE ? OR po.name LIKE ? OR bn.name LIKE ? OR bn.node_code LIKE ?)",
    );
    values.push(...Array(5).fill(`%${keyword}%`));
  }

  const pagination = z.object({
    page: z.coerce.number().int().min(1).max(1000000),
    pageSize: z.coerce.number().int().min(1).max(100),
  }).safeParse({ page: params.get("page") ?? 1, pageSize: params.get("pageSize") ?? 20 });
  if (!pagination.success) {
    return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "分页参数无效。" } }, { status: 400 });
  }
  const paginated = params.has("page");
  const { page, pageSize } = pagination.data;
  const searchJoins = `FROM questions q
    INNER JOIN projects p ON p.id=q.project_id
    INNER JOIN project_occupations po ON po.id=q.occupation_id
    LEFT JOIN question_versions qv ON qv.id=q.current_version_id
    LEFT JOIN question_assessment_points qap ON qap.question_version_id=qv.id
    LEFT JOIN blueprint_nodes bn ON bn.id=qap.blueprint_node_id`;

  try {
    if (view === "storage-candidates") {
      const candidates = await query<(RowDataPacket & { id: string; versionId: string; questionNo: string })[]>(
        `SELECT DISTINCT q.id, q.current_version_id AS versionId, q.question_no AS questionNo
         ${searchJoins}
         WHERE ${conditions.join(" AND ")} AND q.current_status='approved'
           AND EXISTS (SELECT 1 FROM question_review_confirmations qrc WHERE qrc.question_version_id=q.current_version_id)
         ORDER BY q.id`,
        values,
      );
      return NextResponse.json({ data: candidates });
    }
    const rows = await query<QuestionRow[]>(
      `SELECT q.id, q.question_no, po.name AS occupation_name, po.code AS occupation_code,
              q.level_code, q.assessment_mode, q.question_type, q.current_status, q.difficulty,
              q.created_at, q.current_version_id, qv.stem, qv.content_json, qv.answer_json, qv.analysis_text,
              EXISTS (SELECT 1 FROM question_review_confirmations qrc WHERE qrc.question_version_id=q.current_version_id) AS is_confirmed,
              GROUP_CONCAT(DISTINCT bn.node_code ORDER BY bn.node_code SEPARATOR '、') AS point_codes,
              GROUP_CONCAT(DISTINCT bn.name ORDER BY bn.ordinal SEPARATOR '、') AS point_names
         FROM questions q
         INNER JOIN projects p ON p.id = q.project_id
         INNER JOIN project_occupations po ON po.id = q.occupation_id
         LEFT JOIN question_versions qv ON qv.id = q.current_version_id
         LEFT JOIN question_assessment_points qap ON qap.question_version_id = qv.id
         LEFT JOIN blueprint_nodes bn ON bn.id = qap.blueprint_node_id
        WHERE ${conditions.join(" AND ")}
        GROUP BY q.id, q.question_no, po.name, po.code, q.level_code, q.assessment_mode,
                 q.question_type, q.current_status, q.difficulty, q.created_at, q.updated_at, q.current_version_id, qv.stem,
                 qv.content_json, qv.answer_json, qv.analysis_text
        ORDER BY q.updated_at DESC, q.id DESC
        LIMIT ${paginated ? pageSize : 200} OFFSET ${paginated ? (page - 1) * pageSize : 0}`,
      values,
    );
    const [count] = paginated ? await query<(RowDataPacket & { total: number })[]>(
      `SELECT COUNT(DISTINCT q.id) AS total ${searchJoins} WHERE ${conditions.join(" AND ")}`, values,
    ) : [{ total: rows.length }];
    const options = await query<
      (RowDataPacket & {
        level_code: (typeof levelCodes)[number];
        assessment_mode: (typeof assessmentModes)[number];
        question_type: string;
      })[]
    >(
      `SELECT DISTINCT q.level_code, q.assessment_mode, q.question_type
         FROM questions q INNER JOIN projects p ON p.id = q.project_id
        WHERE p.status = 'active' AND q.archived_at IS NULL
        ORDER BY q.assessment_mode, q.level_code, q.question_type`,
    );
    return NextResponse.json({
      data: rows.map((row) => ({
        id: row.id,
        questionNo: row.question_no,
        occupationName: row.occupation_name,
        occupationCode: row.occupation_code,
        levelCode: row.level_code,
        levelLabel: levelLabels[row.level_code],
        assessmentMode: row.assessment_mode,
        questionType: row.question_type,
        status: row.current_status,
        versionId: row.current_version_id,
        confirmed: Boolean(Number(row.is_confirmed)),
        difficulty: row.difficulty,
        createdAt: row.created_at,
        stem: row.stem ?? "当前试题版本尚未写入题干。",
        content: parseJson(row.content_json),
        answer: parseJson(row.answer_json),
        analysis: row.analysis_text,
        pointCodes: row.point_codes ?? "—",
        pointNames: row.point_names ?? "未关联考评点",
      })),
      total: Number(count.total),
      options: options.map((item) => ({
        levelCode: item.level_code,
        assessmentMode: item.assessment_mode,
        questionType: item.question_type,
      })),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: {
          code: "QUESTION_LIST_FAILED",
          message: error instanceof Error ? error.message : "题库检索失败。",
        },
      },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const session = await getVerifiedSession();
  const rejection = guard(session);
  if (rejection) return rejection;
  if (session!.user.role !== "admin") {
    return NextResponse.json(
      { error: { code: "FORBIDDEN", message: "仅管理员可提交专家审定。" } },
      { status: 403 },
    );
  }
  const parsed = submitSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "试题标识无效。" } },
      { status: 400 },
    );
  }

  try {
    const result = await withTransaction(async (connection) => {
      const [rows] = await connection.execute<
        (RowDataPacket & {
          id: string;
          project_id: string;
          current_version_id: string | null;
          current_status: (typeof statusCodes)[number];
        })[]
      >(
        `SELECT id, project_id, current_version_id, current_status
           FROM questions WHERE id = ? AND archived_at IS NULL FOR UPDATE`,
        [parsed.data.questionId],
      );
      const question = rows[0];
      if (!question?.current_version_id)
        throw new Error("试题尚无可提审的当前版本。");
      if (question.current_status !== "draft")
        throw new Error("仅草稿状态的试题可以提审。");

      await connection.execute(
        `UPDATE questions
            SET current_status = 'pending_review', row_version = row_version + 1
          WHERE id = ? AND row_version = row_version`,
        [question.id],
      );
      await connection.execute(
        `INSERT INTO question_status_events (
          id, question_id, question_version_id, from_status, to_status, reason, actor_id
        ) VALUES (?, ?, ?, ?, 'pending_review', '题库管理提交专家审定', ?)`,
        [
          createUlid(),
          question.id,
          question.current_version_id,
          question.current_status,
          session!.user.id,
        ],
      );
      await connection.execute(
        `INSERT INTO audit_logs (
          id, project_id, actor_id, action, object_type, object_id, before_json, after_json, result
        ) VALUES (?, ?, ?, 'question.submit_review', 'question', ?, ?, ?, 'success')`,
        [
          createUlid(),
          question.project_id,
          session!.user.id,
          question.id,
          JSON.stringify({ status: question.current_status }),
          JSON.stringify({
            status: "pending_review",
            questionVersionId: question.current_version_id,
          }),
        ],
      );
      return { id: question.id, status: "pending_review" };
    });
    return NextResponse.json({ data: result });
  } catch (error) {
    return NextResponse.json(
      {
        error: {
          code: "QUESTION_SUBMIT_FAILED",
          message:
            error instanceof Error ? error.message : "提交专家审定失败。",
        },
      },
      { status: 422 },
    );
  }
}

export async function PATCH(request: Request) {
  const session = await getVerifiedSession();
  const rejection = guard(session);
  if (rejection) return rejection;
  if (session!.user.role !== "admin") {
    return NextResponse.json(
      { error: { code: "FORBIDDEN", message: "仅管理员可执行终审入库。" } },
      { status: 403 },
    );
  }
  const body = await request.json();
  const bulk = body?.action === "bulk_store";
  const batch = bulk ? bulkStorageSchema.safeParse(body) : null;
  if (batch && !batch.success) {
    return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: batch.error.issues[0]?.message ?? "批量入库参数无效。" } }, { status: 400 });
  }
  const parsed = submitSchema.safeParse(bulk && batch?.success ? batch.data.questions[0] : body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "试题标识无效。" } },
      { status: 400 },
    );
  }
  try {
    const data = await withTransaction((connection) => storeQuestions(
      connection,
      bulk && batch?.success ? batch.data.questions : [parsed.data],
      session!.user.id,
      bulk && batch?.success ? batch.data.opinion : undefined,
    ));
    return NextResponse.json({ data });
  } catch (error) {
    return NextResponse.json(
      {
        error: {
          code: "QUESTION_FINAL_STORE_FAILED",
          message: error instanceof Error ? error.message : "终审入库失败。",
        },
      },
      { status: 422 },
    );
  }
}

export async function DELETE(request: Request) {
  const session = await getVerifiedSession();
  const rejection = guard(session);
  if (rejection) return rejection;
  if (session!.user.role !== "admin") {
    return NextResponse.json(
      { error: { code: "FORBIDDEN", message: "仅管理员可删除草稿试题。" } },
      { status: 403 },
    );
  }
  const parsed = submitSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "试题标识无效。" } },
      { status: 400 },
    );
  }
  try {
    await withTransaction(async (connection) => {
      const [rows] = await connection.execute<
        (RowDataPacket & {
          id: string;
          project_id: string;
          current_version_id: string | null;
          current_status: (typeof statusCodes)[number];
        })[]
      >(
        "SELECT id, project_id, current_version_id, current_status FROM questions WHERE id = ? AND archived_at IS NULL FOR UPDATE",
        [parsed.data.questionId],
      );
      const question = rows[0];
      if (!question || question.current_status !== "draft")
        throw new Error("仅草稿状态的试题可以删除。");
      await connection.execute(
        "UPDATE questions SET current_status = 'archived', archived_at = NOW(3), row_version = row_version + 1 WHERE id = ?",
        [question.id],
      );
      if (question.current_version_id) {
        await connection.execute(
          "INSERT INTO question_status_events (id, question_id, question_version_id, from_status, to_status, reason, actor_id) VALUES (?, ?, ?, 'draft', 'archived', '题库管理删除草稿', ?)",
          [
            createUlid(),
            question.id,
            question.current_version_id,
            session!.user.id,
          ],
        );
      }
      await connection.execute(
        "INSERT INTO audit_logs (id, project_id, actor_id, action, object_type, object_id, before_json, after_json, result) VALUES (?, ?, ?, 'question.delete_draft', 'question', ?, ?, ?, 'success')",
        [
          createUlid(),
          question.project_id,
          session!.user.id,
          question.id,
          JSON.stringify({ status: "draft" }),
          JSON.stringify({ status: "archived" }),
        ],
      );
    });
    return NextResponse.json({ data: { deleted: true } });
  } catch (error) {
    return NextResponse.json(
      {
        error: {
          code: "QUESTION_DELETE_FAILED",
          message: error instanceof Error ? error.message : "删除草稿失败。",
        },
      },
      { status: 422 },
    );
  }
}
