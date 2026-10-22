import { createHash } from "node:crypto";

import { NextResponse } from "next/server";
import type { RowDataPacket } from "mysql2/promise";
import { z } from "zod";

import { getVerifiedSession } from "@/auth";
import { getSavedModelConnection } from "@/modules/model-connection/service";
import { createUlid } from "@/shared/database/ulid";
import { query, withTransaction } from "@/shared/database/mysql";

type LevelCode = "level_5" | "level_4" | "level_3" | "level_2" | "level_1";
const questionSchema = z.object({
  assessmentPointCode: z.string().min(1),
  questionType: z.enum(["single", "multiple", "judgement"]),
  stem: z.string().min(8),
  options: z
    .array(
      z.object({ key: z.string().min(1).max(8), content: z.string().min(1) }),
    )
    .max(8)
    .default([]),
  answers: z.array(z.string().min(1)).min(1).max(8),
  analysis: z.string().min(1),
});
const generatedSchema = z.object({ questions: z.array(questionSchema).min(1) });
type ModelResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  content?: Array<{ text?: string }>;
  error?: { message?: string };
};

type PlanScope = {
  occupationId: string;
  occupation: string;
  levelCode: LevelCode;
  assessmentMode: "理论知识" | "操作技能";
  blueprintVersions: {
    outline: { id: string; versionNo: number };
    weights: { id: string; versionNo: number };
  };
};
type PlanQuota = {
  minimumTotal: number;
  points: Array<{
    code: string;
    name: string;
    single: number;
    multiple: number;
    judgement: number;
    total: number;
  }>;
  qualityRequirements: string[];
};

function endpoint(baseUrl: string, provider: string) {
  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/+$/, "");
  const anthropic =
    provider.toLowerCase().includes("claude") ||
    provider.toLowerCase().includes("anthropic") ||
    url.pathname.endsWith("/messages");
  if (anthropic) return { url: url.toString(), protocol: "anthropic" as const };
  if (!url.pathname.endsWith("/v1")) url.pathname = `${url.pathname || ""}/v1`;
  url.pathname = `${url.pathname}/chat/completions`;
  return { url: url.toString(), protocol: "openai" as const };
}

export async function POST(
  _: Request,
  { params }: Readonly<{ params: { planId: string } }>,
) {
  const session = await getVerifiedSession();
  if (!session?.user?.id)
    return NextResponse.json(
      { error: { code: "UNAUTHENTICATED", message: "登录已失效。" } },
      { status: 401 },
    );
  if (session.user.role !== "admin")
    return NextResponse.json(
      { error: { code: "FORBIDDEN", message: "仅管理员可执行命题任务。" } },
      { status: 403 },
    );

  try {
    const plan = await withTransaction(async (connection) => {
      const [rows] = await connection.execute<
        (RowDataPacket & {
          project_id: string;
          raw_requirement: string;
          scope_json: PlanScope | string;
          quota_json: PlanQuota | string;
          status: string;
        })[]
      >(
        "SELECT project_id, raw_requirement, scope_json, quota_json, status FROM authoring_plans WHERE id = ? FOR UPDATE",
        [params.planId],
      );
      const current = rows[0];
      if (!current || current.status !== "confirmed")
        throw new Error("命题计划不存在或尚未通过系统校验。");
      const scope =
        typeof current.scope_json === "string"
          ? (JSON.parse(current.scope_json) as PlanScope)
          : current.scope_json;
      const quota =
        typeof current.quota_json === "string"
          ? (JSON.parse(current.quota_json) as PlanQuota)
          : current.quota_json;
      if (scope.assessmentMode !== "理论知识")
        throw new Error("当前仅支持自动执行理论知识命题任务。");
      return {
        projectId: current.project_id,
        requirement: current.raw_requirement,
        scope,
        quota,
      };
    });

    const connection = await getSavedModelConnection();
    if (!connection) throw new Error("未配置可用模型连接，请先保存模型设置。");
    const qualitySetting = await query<
      (RowDataPacket & { setting_value_json: unknown })[]
    >(
      "SELECT setting_value_json FROM system_settings WHERE setting_key = 'authoring.question_quality_standard' LIMIT 1",
    );
    const qualityStandardValue = qualitySetting[0]?.setting_value_json;
    const qualityStandard =
      typeof qualityStandardValue === "string"
        ? JSON.parse(qualityStandardValue)
        : qualityStandardValue;
    const target = endpoint(connection.baseUrl, connection.provider);
    const requested = plan.quota.points.flatMap((point) => [
      ...Array.from({ length: point.single }, () => ({
        code: point.code,
        type: "single",
      })),
      ...Array.from({ length: point.multiple }, () => ({
        code: point.code,
        type: "multiple",
      })),
      ...Array.from({ length: point.judgement }, () => ({
        code: point.code,
        type: "judgement",
      })),
    ]);
    if (requested.length > 300)
      throw new Error(
        `本次计划需生成 ${requested.length} 道题，超过单批 300 道上限；请拆分命题需求后执行。`,
      );

    const instruction = `你是职业技能理论知识试题编制助手。仅依据给出的考评点生成试题草稿，严格覆盖指定题型和数量。答案必须准确、题目之间避免重复，不得超纲。只返回 JSON，不要 Markdown：
{"questions":[{"assessmentPointCode":"考评点代码","questionType":"single|multiple|judgement","stem":"题干","options":[{"key":"A","content":"选项"}],"answers":["A"],"analysis":"答案解析"}]}。
单选必须有 4 个选项且 answers 仅一个；多选至少 4 个选项且 answers 可多个；判断题 options 必须为空，answers 只能为“正确”或“错误”。`;
    const pointNames = new Map(
      plan.quota.points.map((item) => [item.code, item.name]),
    );
    const generatedQuestions: z.infer<typeof questionSchema>[] = [];
    const batches: (typeof requested)[] = [];
    let pendingBatch: typeof requested = [];
    for (const point of plan.quota.points) {
      const pointRequests = requested.filter(
        (item) => item.code === point.code,
      );
      if (!pointRequests.length) continue;
      // 保持一个考评点的题型配额在同一批，避免末尾残余题量让模型误判为整组配额。
      if (
        pendingBatch.length &&
        pendingBatch.length + pointRequests.length > 20
      ) {
        batches.push(pendingBatch);
        pendingBatch = [];
      }
      pendingBatch.push(...pointRequests);
    }
    if (pendingBatch.length) batches.push(pendingBatch);
    for (const [batchIndex, batch] of batches.entries()) {
      const prompt = JSON.stringify({
        用户命题需求: plan.requirement,
        职业: plan.scope.occupation,
        等级: plan.scope.levelCode,
        质量要求: plan.quota.qualityRequirements,
        试题质量标准:
          typeof qualityStandard?.content === "string"
            ? qualityStandard.content
            : "遵循职业标准与考评点，题干清晰无歧义，答案和解析准确，避免重复。",
        本批考评点: Array.from(new Set(batch.map((item) => item.code))).map(
          (code) => ({ code, name: pointNames.get(code) ?? "" }),
        ),
        本批必须生成的题目清单: batch,
      });
      let completed = false;
      for (let attempt = 1; attempt <= 3 && !completed; attempt += 1) {
        let response: Response;
        try {
          response = await fetch(target.url, {
            method: "POST",
            headers:
              target.protocol === "anthropic"
                ? {
                    "x-api-key": connection.apiKey,
                    "anthropic-version": "2023-06-01",
                    "Content-Type": "application/json",
                  }
                : {
                    Authorization: `Bearer ${connection.apiKey}`,
                    "Content-Type": "application/json",
                  },
            body: JSON.stringify(
              target.protocol === "anthropic"
                ? {
                    model: connection.model,
                    max_tokens: 8192,
                    system: instruction,
                    messages: [
                      {
                        role: "user",
                        content: `${prompt}\n仅输出一个完整、可被 JSON.parse 解析的 JSON 对象，不得使用 Markdown 或附加说明。`,
                      },
                    ],
                  }
                : {
                    model: connection.model,
                    temperature: 0,
                    max_tokens: 4096,
                    response_format: { type: "json_object" },
                    messages: [
                      { role: "system", content: instruction },
                      {
                        role: "user",
                        content: `${prompt}\n仅输出一个完整、可被 JSON.parse 解析的 JSON 对象，不得使用 Markdown 或附加说明。`,
                      },
                    ],
                  },
            ),
            signal: AbortSignal.timeout(10 * 60 * 1000),
          });
        } catch (error) {
          const cause =
            error instanceof Error && error.cause instanceof Error
              ? error.cause.message
              : "";
          const detail = error instanceof Error ? error.message : "";
          throw new Error(
            `第 ${batchIndex + 1}/${batches.length} 批无法连接模型服务 ${target.url}：${cause || detail || "请在模型设置中测试并修正 API 基础地址。"}`,
          );
        }
        const raw = await response.text();
        let payload: ModelResponse | null = null;
        try {
          payload = raw ? (JSON.parse(raw) as ModelResponse) : null;
        } catch {
          throw new Error(
            `第 ${batchIndex + 1}/${batches.length} 批模型服务响应不是有效 JSON。`,
          );
        }
        if (!response.ok)
          throw new Error(
            payload?.error?.message ||
              `第 ${batchIndex + 1}/${batches.length} 批模型服务返回 HTTP ${response.status}。`,
          );
        const content =
          target.protocol === "anthropic"
            ? (payload?.content?.[0]?.text ?? "")
            : (payload?.choices?.[0]?.message?.content ?? "");
        const json = content.match(/\{[\s\S]*\}/)?.[0];
        let parsedContent: unknown;
        let parseFailure = "";
        try {
          parsedContent = json ? JSON.parse(json) : null;
          if (typeof parsedContent === "string")
            parsedContent = JSON.parse(parsedContent);
        } catch (error) {
          parsedContent = null;
          parseFailure =
            error instanceof Error ? error.message : "JSON 解析失败";
        }
        const generated = generatedSchema.safeParse(parsedContent);
        if (
          generated.success &&
          generated.data.questions.length === batch.length
        ) {
          generatedQuestions.push(...generated.data.questions);
          completed = true;
        } else if (attempt === 3) {
          const reason =
            parseFailure ||
            (generated.success
              ? `返回题量不是 ${batch.length} 道`
              : "试题字段不符合要求");
          throw new Error(
            `第 ${batchIndex + 1}/${batches.length} 批连续 3 次生成失败：${reason}。`,
          );
        }
      }
    }

    const result = await withTransaction(async (db) => {
      const [nodes] = await db.execute<
        (RowDataPacket & { id: string; node_code: string; name: string })[]
      >(
        "SELECT id, node_code, name FROM blueprint_nodes WHERE blueprint_version_id = ? AND node_kind = 'assessment_point'",
        [plan.scope.blueprintVersions.outline.id],
      );
      const nodeByCode = new Map(nodes.map((node) => [node.node_code, node]));
      const expected = new Map(
        requested.map((item) => [
          `${item.code}:${item.type}`,
          requested.filter(
            (candidate) =>
              candidate.code === item.code && candidate.type === item.type,
          ).length,
        ]),
      );
      const actual = new Map<string, number>();
      for (const item of generatedQuestions)
        actual.set(
          `${item.assessmentPointCode}:${item.questionType}`,
          (actual.get(`${item.assessmentPointCode}:${item.questionType}`) ??
            0) + 1,
        );
      for (const [key, count] of expected)
        if (actual.get(key) !== count)
          throw new Error(`AI 返回的“${key}”题量不符合计划配额。`);

      const [existing] = await db.execute<
        (RowDataPacket & { count: number })[]
      >(
        `SELECT COUNT(*) AS count FROM question_versions qv
           INNER JOIN questions q ON q.id = qv.question_id
          WHERE q.project_id = ? AND qv.source_snapshot_json LIKE ?`,
        [plan.projectId, `%${params.planId}%`],
      );
      if (Number(existing[0]?.count ?? 0))
        throw new Error("该命题计划已执行，不能重复生成草稿。");

      const created: Array<{
        id: string;
        questionNo: string;
        point: string;
        questionType: string;
        stem: string;
        options: Array<{ key: string; content: string }>;
        answers: string[];
        analysis: string;
        autoCheck: "通过基础检查" | "需人工复核";
      }> = [];
      for (const [index, item] of generatedQuestions.entries()) {
        const node = nodeByCode.get(item.assessmentPointCode);
        if (!node)
          throw new Error(
            `AI 返回了不属于当前细目表的考评点：${item.assessmentPointCode}。`,
          );
        const optionsValid =
          item.questionType === "judgement"
            ? item.options.length === 0 &&
              item.answers.length === 1 &&
              ["正确", "错误"].includes(item.answers[0])
            : item.options.length >= 4 &&
              item.answers.length >= 1 &&
              item.answers.every((answer) =>
                item.options.some((option) => option.key === answer),
              );
        if (!optionsValid)
          throw new Error(
            `AI 返回的第 ${index + 1} 题选项或答案不符合题型规则。`,
          );
        const questionId = createUlid();
        const versionId = createUlid();
        const questionNo = `AI-${params.planId.slice(-6)}-${String(index + 1).padStart(4, "0")}`;
        const questionType =
          item.questionType === "single"
            ? "单项选择题"
            : item.questionType === "multiple"
              ? "多项选择题"
              : "判断题";
        const snapshot = {
          planId: params.planId,
          blueprintVersionId: plan.scope.blueprintVersions.outline.id,
          assessmentPointCode: node.node_code,
          generatedAt: new Date().toISOString(),
        };
        const hash = createHash("sha256")
          .update(
            JSON.stringify({
              stem: item.stem,
              options: item.options,
              answers: item.answers,
              analysis: item.analysis,
              snapshot,
            }),
          )
          .digest("hex");
        await db.execute(
          `INSERT INTO questions (id, project_id, question_no, occupation_id, level_code, assessment_mode, question_type, current_version_id, current_status)
           VALUES (?, ?, ?, ?, ?, 'theory', ?, ?, 'draft')`,
          [
            questionId,
            plan.projectId,
            questionNo,
            plan.scope.occupationId,
            plan.scope.levelCode,
            questionType,
            versionId,
          ],
        );
        await db.execute(
          `INSERT INTO question_versions (id, question_id, version_no, stem, content_json, answer_json, analysis_text, source_snapshot_json, content_hash, created_by)
           VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
          [
            versionId,
            questionId,
            item.stem,
            JSON.stringify({ options: item.options }),
            JSON.stringify({ answers: item.answers }),
            item.analysis,
            JSON.stringify(snapshot),
            hash,
            session.user.id,
          ],
        );
        for (const option of item.options)
          await db.execute(
            "INSERT INTO question_options (id, question_version_id, option_key, content, is_correct) VALUES (?, ?, ?, ?, ?)",
            [
              createUlid(),
              versionId,
              option.key,
              option.content,
              item.answers.includes(option.key) ? 1 : 0,
            ],
          );
        await db.execute(
          "INSERT INTO question_assessment_points (question_version_id, blueprint_node_id) VALUES (?, ?)",
          [versionId, node.id],
        );
        await db.execute(
          `INSERT INTO question_quality_checks (id, question_version_id, check_round, check_code, severity, result, detail_json)
           VALUES (?, ?, 'rule', 'authoring.basic_structure', 'info', 'pass', ?)`,
          [
            createUlid(),
            versionId,
            JSON.stringify({
              planId: params.planId,
              assessmentPoint: node.name,
              optionsValid,
              answerCount: item.answers.length,
            }),
          ],
        );
        await db.execute(
          `INSERT INTO question_status_events (id, question_id, question_version_id, from_status, to_status, reason, actor_id)
           VALUES (?, ?, ?, NULL, 'draft', 'AI 命题计划自动生成，等待人工核查', ?)`,
          [createUlid(), questionId, versionId, session.user.id],
        );
        created.push({
          id: questionId,
          questionNo,
          point: node.name,
          questionType,
          stem: item.stem,
          options: item.options,
          answers: item.answers,
          analysis: item.analysis,
          autoCheck: "通过基础检查",
        });
      }
      await db.execute(
        `INSERT INTO audit_logs (id, project_id, actor_id, action, object_type, object_id, after_json, result)
         VALUES (?, ?, ?, 'authoring.plan.auto_generate', 'authoring_plan', ?, ?, 'success')`,
        [
          createUlid(),
          plan.projectId,
          session.user.id,
          params.planId,
          JSON.stringify({
            questionCount: created.length,
            status: "awaiting_manual_check",
          }),
        ],
      );
      return created;
    });
    return NextResponse.json(
      { data: { planId: params.planId, questions: result } },
      { status: 201 },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: {
          code: "PLAN_EXECUTION_FAILED",
          message:
            error instanceof Error ? error.message : "命题任务执行失败。",
        },
      },
      { status: 422 },
    );
  }
}
