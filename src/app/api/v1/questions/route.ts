import type { RowDataPacket } from "mysql2/promise";
import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getVerifiedSession } from "@/auth";
import { createUlid } from "@/shared/database/ulid";
import { query, withTransaction } from "@/shared/database/mysql";
import { bulkStorageSchema } from "@/modules/authoring/question-storage-policy";
import { storeQuestions } from "@/modules/authoring/question-storage";
import { commonEditorialLevelFilter } from "@/modules/authoring/common-question-policy";
import { buildOutlineWorkbook, type ExportPoint } from "@/modules/blueprints/outline-export";
import { createSkillOutlineWord, createSkillStructureWord } from "@/modules/documents/skill-blueprint-word";
import { buildTheoryQuestionBankWorkbook } from "@/modules/questions/theory-question-bank-export";
import { limitTheoryQuestionBankRows } from "@/modules/questions/theory-question-bank-selection";

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
  occupation_id: string | null;
  level_code: (typeof levelCodes)[number] | null;
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
      !["question-bank", "theory-outline", "skill-structure", "skill-outline"].includes(file ?? "")
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

      const levelLabel = levelLabels[levelCode as (typeof levelCodes)[number]];
      if (file === "skill-structure") {
        const rows = await query<(RowDataPacket & { snapshot_json: unknown })[]>(
          `SELECT v.snapshot_json FROM blueprints b
             INNER JOIN blueprint_versions v ON v.id=b.current_version_id
            WHERE b.occupation_id=? AND b.level_code=? AND b.assessment_mode='skill'
              AND b.blueprint_kind='skill_structure' LIMIT 1`,
          [occupationId, levelCode],
        );
        if (!rows[0]) throw new Error("当前范围尚未维护操作技能考核内容结构表，无法生成成果文件。");
        const structure = parseJson(rows[0].snapshot_json) as {
          pathway?: string; totalMinutes?: number; rows?: Array<{ code?: string; name?: string; selection?: string; score?: number | string; minutes?: number; method?: string }>;
        };
        const outlineRows = await query<(RowDataPacket & { requirement_json: unknown })[]>(
          `SELECT bn.requirement_json
             FROM blueprints b INNER JOIN blueprint_nodes bn ON bn.blueprint_version_id=b.current_version_id
            WHERE b.occupation_id=? AND b.level_code=? AND b.assessment_mode='skill'
              AND b.blueprint_kind='skill_outline' AND bn.node_kind='assessment_point'
            ORDER BY bn.ordinal,bn.id`,
          [occupationId, levelCode],
        );
        const groups = new Map<string, string[]>();
        const validNames = (structure.rows ?? []).map(r => String(r.name ?? "").replace(/\s*[A-Z]$/, "").trim());
        
        for (const outline of outlineRows) {
          const requirement = parseJson(outline.requirement_json) as Record<string, any>;
          
          const l1 = String(requirement.level1Name ?? "").replace(/\s*[A-Z]$/, "").trim();
          const l2 = String(requirement.level2Name ?? "").replace(/\s*[A-Z]$/, "").trim();
          const l3 = String(requirement.level3Name ?? "").replace(/\s*[A-Z]$/, "").trim();
          const fn = String(requirement.sourceStandardRequirement?.functionName ?? "").trim();
          const cn = String(requirement.sourceStandardRequirement?.contentName ?? "").trim();
          
          let primary = "";
          let secondary = "";
          
          if (validNames.includes(l1)) { primary = l1; secondary = l2 || l3; }
          else if (validNames.includes(l2)) { primary = l2; secondary = cn || l3; }
          else if (validNames.includes(l3)) { primary = l3; secondary = cn || l3; }
          else if (validNames.includes(fn)) { primary = fn; secondary = cn; }
          
          if (!primary) {
            primary = String(requirement.primaryName ?? requirement.level1Name ?? "").replace(/\s*[A-Z]$/, "").trim();
            secondary = String(requirement.secondaryName ?? requirement.level2Name ?? "").trim();
          }
          
          if (secondary === primary) secondary = "";
          if (!primary) continue;
          
          const children = groups.get(primary) ?? [];
          if (secondary && !children.includes(secondary)) children.push(secondary);
          groups.set(primary, children);
        }
        const bytes = await createSkillStructureWord({
          occupationName: scope.occupation_name,
          levelLabel,
          pathway: structure.pathway ?? null,
          totalMinutes: typeof structure.totalMinutes === "number" ? structure.totalMinutes : null,
          rows: (structure.rows ?? []).map((row) => ({
            code: row.code ?? "待核对", name: row.name ?? "待核对", selection: row.selection ?? null,
            score: row.score != null ? Number(String(row.score).replace(/[^0-9.]/g, "")) : null,
            minutes: typeof row.minutes === "number" ? row.minutes : null, method: row.method ?? null,
          })),
          headerGroups: [...groups.entries()].map(([name, children]) => ({ name, children })),
        });
        const filename = `${scope.occupation_name}-${levelLabel}-操作技能考核内容结构表.docx`;
        return new NextResponse(new Uint8Array(bytes), { headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        } });
      }

      if (file === "skill-outline") {
        const rows = await query<(RowDataPacket & ExportPoint & { question_count: number })[]>(
          `SELECT bn.node_code AS code,bn.name,bn.importance,bn.requirement_json AS requirement,
             (SELECT COUNT(*) FROM questions q
                INNER JOIN question_assessment_points qap ON qap.question_version_id=q.current_version_id
               WHERE qap.blueprint_node_id=bn.id AND q.occupation_id=? AND q.level_code=?
                 AND q.assessment_mode='skill' AND q.current_status='stored' AND q.archived_at IS NULL) AS question_count
             FROM blueprints b INNER JOIN blueprint_nodes bn ON bn.blueprint_version_id=b.current_version_id
            WHERE b.occupation_id=? AND b.level_code=? AND b.assessment_mode='skill'
              AND b.blueprint_kind='skill_outline' AND bn.node_kind='assessment_point'
            ORDER BY bn.ordinal,bn.id`,
          [occupationId, levelCode, occupationId, levelCode],
        );
        if (!rows.length) throw new Error("当前范围尚未维护操作技能鉴定要素细目表，无法生成成果文件。");
        const bytes = await createSkillOutlineWord({
          occupationName: scope.occupation_name, levelLabel,
          rows: rows.map((row) => ({
            code: row.code, name: row.name, importance: row.importance,
            requirement: row.requirement, questionCount: Number(row.question_count),
          })),
        });
        const filename = `${scope.occupation_name}-${levelLabel}-操作技能鉴定要素细目表.docx`;
        return new NextResponse(new Uint8Array(bytes), { headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        } });
      }

      if (file === "theory-outline") {
        const rows = await query<(RowDataPacket & ExportPoint)[]>(
          `SELECT bn.node_code AS code,bn.name,bn.importance,bn.requirement_json AS requirement
             FROM blueprints b INNER JOIN blueprint_nodes bn ON bn.blueprint_version_id=b.current_version_id
            WHERE b.occupation_id=? AND b.level_code=? AND b.assessment_mode='theory'
              AND b.blueprint_kind='theory_outline' AND bn.node_kind='assessment_point'
            ORDER BY bn.ordinal,bn.id`,
          [occupationId, levelCode],
        );
        if (!rows.length) throw new Error("当前范围尚未维护理论知识考评要素细目表，无法生成成果文件。");
        const bytes = await buildOutlineWorkbook(rows).xlsx.writeBuffer();
        const filename = `${scope.occupation_name}-${levelLabel}-理论知识考评要素细目表.xlsx`;
        return new NextResponse(bytes, { headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        } });
      }

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
            difficulty: "easy" | "medium" | "hard" | null;
            alignment: "aligned" | "partially_aligned" | "not_aligned" | null;
            stem: string;
            content_json: unknown;
            answer_json: unknown;
            score_rubric_json: unknown;
            analysis_text: string | null;
            point_code: string | null;
            stored_at: Date | string | null;
          })[]
        >(
          `SELECT q.question_no, q.question_type, q.difficulty,
                  (SELECT rr.alignment FROM review_records rr
                    WHERE rr.question_version_id = q.current_version_id
                    ORDER BY rr.submitted_at DESC, rr.id DESC LIMIT 1) AS alignment,
                  qv.stem, qv.content_json, qv.answer_json, qv.score_rubric_json, qv.analysis_text,
                  GROUP_CONCAT(DISTINCT bn.node_code ORDER BY bn.node_code SEPARATOR '、') AS point_code,
                  COALESCE(
                    (SELECT MAX(qse.created_at) FROM question_status_events qse
                      WHERE qse.question_id = q.id AND qse.to_status = 'stored'),
                    q.updated_at,
                    q.created_at
                  ) AS stored_at
             FROM questions q
             INNER JOIN question_versions qv ON qv.id = q.current_version_id
             LEFT JOIN question_assessment_points qap ON qap.question_version_id = qv.id
             LEFT JOIN blueprint_nodes bn ON bn.id = qap.blueprint_node_id
            WHERE q.occupation_id = ? AND q.assessment_mode = ?
              AND q.archived_at IS NULL
              AND ${commonEditorialLevelFilter()}
            GROUP BY q.id, q.question_no, q.question_type, q.difficulty, q.current_version_id,
                     qv.stem, qv.content_json, qv.answer_json, qv.score_rubric_json, qv.analysis_text
            ORDER BY point_code, q.question_no`,
          [occupationId, assessmentMode!, levelCode!, levelCode!],
        );
        if (!rows.length)
          return NextResponse.json(
            {
              error: {
                code: "NO_APPROVED_QUESTIONS",
                message: "当前范围没有题库试题，无法生成成果文件。",
              },
            },
            { status: 422 },
          );
        if (assessmentMode === "theory") {
          const theoryRows = limitTheoryQuestionBankRows(rows.map((row) => ({
            pointCode: row.point_code,
            questionType: row.question_type,
            questionNo: row.question_no,
            storedAt: row.stored_at,
            difficulty: row.difficulty,
            alignment: row.alignment,
            stem: row.stem,
            contentJson: row.content_json,
            answerJson: row.answer_json,
            analysisText: row.analysis_text,
            scoreRubricJson: row.score_rubric_json,
          })));
          const theoryWorkbook = buildTheoryQuestionBankWorkbook(theoryRows.map((row) => ({
            pointCode: row.pointCode,
            questionType: row.questionType,
            difficulty: row.difficulty,
            alignment: row.alignment,
            stem: row.stem,
            contentJson: row.contentJson,
            answerJson: row.answerJson,
            analysisText: row.analysisText,
            scoreRubricJson: row.scoreRubricJson,
          })));
          const filename = `${scope.occupation_name}-${levelLabels[levelCode as (typeof levelCodes)[number]]}-理论知识-题库.xlsx`;
          const bytes = await theoryWorkbook.xlsx.writeBuffer();
          return new NextResponse(bytes, {
            headers: {
              "Content-Type":
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
            },
          });
        }
        sheet.columns = [
          { header: "试题编号", key: "questionNo", width: 20 },
          { header: "题型", key: "type", width: 20 },
          { header: "题干", key: "stem", width: 58 },
          { header: "标准答案", key: "answer", width: 18 },
          { header: "答案解析", key: "analysis", width: 52 },
          { header: "考评点代码", key: "pointCode", width: 28 },
        ];
        rows.forEach((row) =>
          sheet.addRow({
            questionNo: row.question_no,
            type: row.question_type,
            stem: row.stem,
            answer: JSON.stringify(parseJson(row.answer_json)),
            analysis: row.analysis_text ?? "",
            pointCode: row.point_code ?? "",
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
             UNION ALL SELECT 'level_5', 'skill'
             UNION ALL SELECT 'level_4', 'theory'
             UNION ALL SELECT 'level_4', 'skill'
             UNION ALL SELECT 'level_3', 'theory'
             UNION ALL SELECT 'level_3', 'skill'
           ) scope
           LEFT JOIN questions q ON q.occupation_id = po.id
                               AND q.assessment_mode = scope.assessment_mode
                               AND q.archived_at IS NULL
                               AND (q.level_code = scope.level_code
                                 OR (q.level_code IS NULL AND q.assessment_mode='theory'
                                   AND EXISTS(SELECT 1 FROM common_question_members cm
                                     JOIN common_question_points cp ON cp.group_id=cm.group_id AND cp.point_key=cm.point_key
                                     WHERE cm.question_id=q.id AND cp.level_code=scope.level_code)))
          WHERE po.status = 'active'
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
    conditions.push(commonEditorialLevelFilter());
    values.push(levelCode!, levelCode!);
  } else if (levelCode === "generic") {
    conditions.push("q.level_code IS NULL AND q.occupation_id IS NULL");
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
    LEFT JOIN project_occupations po ON po.id=q.occupation_id
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
      `SELECT q.id, q.question_no,q.occupation_id, COALESCE(po.name,'通用') AS occupation_name, COALESCE(po.code,'') AS occupation_code,
              q.level_code, q.assessment_mode, q.question_type, q.current_status, q.difficulty,
              q.created_at, q.current_version_id, qv.stem, qv.content_json, qv.answer_json, qv.analysis_text,
              EXISTS (SELECT 1 FROM question_review_confirmations qrc WHERE qrc.question_version_id=q.current_version_id) AS is_confirmed,
              GROUP_CONCAT(DISTINCT bn.node_code ORDER BY bn.node_code SEPARATOR '、') AS point_codes,
              GROUP_CONCAT(DISTINCT bn.name ORDER BY bn.ordinal SEPARATOR '、') AS point_names
         FROM questions q
         INNER JOIN projects p ON p.id = q.project_id
         LEFT JOIN project_occupations po ON po.id = q.occupation_id
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
        level_code: (typeof levelCodes)[number] | null;
        assessment_mode: (typeof assessmentModes)[number];
        question_type: string;
      })[]
    >(
      `SELECT DISTINCT COALESCE(cp.level_code,q.level_code) AS level_code, q.assessment_mode, q.question_type
         FROM questions q INNER JOIN projects p ON p.id = q.project_id
         LEFT JOIN common_question_members cm ON cm.question_id=q.id
         LEFT JOIN common_question_points cp ON cp.group_id=cm.group_id AND cp.point_key=cm.point_key
        WHERE p.status = 'active' AND q.archived_at IS NULL
        ORDER BY q.assessment_mode, level_code, q.question_type`,
    );
    return NextResponse.json({
      data: rows.map((row) => ({
        id: row.id,
        questionNo: row.question_no,
        occupationName: row.occupation_name,
        occupationCode: row.occupation_code,
        levelCode: row.level_code ?? "generic",
        levelLabel: row.level_code ? levelLabels[row.level_code] : row.occupation_id ? "公共 · 五四三级（维护版本）" : "通用",
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
        pointNames: row.point_names ?? (row.level_code === null ? "通用法规知识" : "未关联考评点"),
      })),
      total: Number(count.total),
      options: options.map((item) => ({
        levelCode: item.level_code ?? "generic",
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
      const [common] = await connection.execute<RowDataPacket[]>("SELECT question_id FROM common_question_members WHERE question_id=?", [question.id]);
      if (common.length) throw new Error("公共试题请在公共题组统一停用，不能从等级题库删除。");
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
