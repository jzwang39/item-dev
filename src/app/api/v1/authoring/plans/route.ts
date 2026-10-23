import { NextResponse } from "next/server";
import type { RowDataPacket } from "mysql2/promise";
import { z } from "zod";

import { getVerifiedSession } from "@/auth";
import { getCurrentTheoryOutline } from "@/modules/blueprints/theory-outlines/service";
import { getCurrentTheoryWeights } from "@/modules/blueprints/theory-weights/service";
import { listActiveOccupations } from "@/modules/authoring/occupations/service";
import { getSavedModelConnection } from "@/modules/model-connection/service";
import { query } from "@/shared/database/mysql";

export const dynamic = "force-dynamic";

const requestSchema = z.object({
  requirement: z.string().trim().min(1, "请先描述命题需求。").max(12000)
});

const aiResultSchema = z.object({ 
  occupationName: z.string().trim().min(1),
  levelCode: z.enum(["level_5", "level_4", "level_3", "level_2", "level_1"]),
  assessmentMode: z.enum(["theory", "skill"]),
  temporaryMinimums: z.object({
    single: z.number().int().min(0).max(100).default(0),
    multiple: z.number().int().min(0).max(100).default(0),
    judgement: z.number().int().min(0).max(100).default(0)
  }).default({ single: 0, multiple: 0, judgement: 0 }),
  qualityRequirements: z.array(z.string().trim().min(1).max(200)).max(10).default([])
});

const levelLabels = {
  level_5: "5级",
  level_4: "4级",
  level_3: "3级",
  level_2: "2级",
  level_1: "1级"
} as const;

type LevelCode = keyof typeof levelLabels;
type ParsedRequirement = z.infer<typeof aiResultSchema>;
type Quota = { single: number; multiple: number; judgement: number; total: number; hint: string };
type ModelResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  content?: Array<{ text?: string }>;
  error?: { message?: string };
};

function rejectUnauthorized(session: Awaited<ReturnType<typeof getVerifiedSession>>) {
  if (!session?.user?.id) {
    return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "登录已失效。" } }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return NextResponse.json({ error: { code: "FORBIDDEN", message: "仅管理员可生成命题计划。" } }, { status: 403 });
  }
  return null;
}

export async function GET() {
  const session = await getVerifiedSession();
  const rejection = rejectUnauthorized(session);
  if (rejection) return rejection;

  try {
    type PlanRow = RowDataPacket & {
      id: string;
      name: string;
      raw_requirement: string;
      scope_json: unknown;
      quota_json: unknown;
      status: "draft" | "blocked" | "confirmed" | "cancelled";
      created_at: string;
      updated_at: string;
      question_count: number;
    };
    const rows = await query<PlanRow[]>(
      `SELECT ap.id, ap.name, ap.raw_requirement, ap.scope_json, ap.quota_json, ap.status, ap.created_at, ap.updated_at,
              COUNT(qv.id) AS question_count
         FROM authoring_plans ap
         LEFT JOIN question_versions qv ON JSON_UNQUOTE(JSON_EXTRACT(qv.source_snapshot_json, '$.planId')) = ap.id
         INNER JOIN projects p ON p.id = ap.project_id AND p.status = 'active'
        GROUP BY ap.id
        ORDER BY ap.updated_at DESC
        LIMIT 100`
    );
    return NextResponse.json({ data: rows.map((row) => ({
      ...row,
      question_count: Number(row.question_count),
      scope_json: typeof row.scope_json === "string" ? JSON.parse(row.scope_json) : row.scope_json,
      quota_json: typeof row.quota_json === "string" ? JSON.parse(row.quota_json) : row.quota_json
    })) });
  } catch (error) {
    return NextResponse.json({
      error: { code: "PLAN_LIST_FAILED", message: error instanceof Error ? error.message : "历史命题计划加载失败。" }
    }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await getVerifiedSession();
  const rejection = rejectUnauthorized(session);
  if (rejection) return rejection;

  const parsed = requestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: parsed.error.issues[0]?.message ?? "命题需求无效。" } }, { status: 400 });
  }

  try {
    const occupations = await listActiveOccupations();
    const ai = await parseRequirement(parsed.data.requirement, occupations.map((occupation) => occupation.name));
    const occupation = findOccupation(occupations, ai.occupationName);
    const levelCode = ai.levelCode;
    const systemRule = getQuotaRule(levelCode);

    if (!occupation) {
      return NextResponse.json({
        data: createBlockedPlan(parsed.data.requirement, ai, systemRule, "未能从当前项目的职业范围中匹配解析结果；请先建立对应职业和细目表后再执行。")
      });
    }

    if (ai.assessmentMode !== "theory") {
      return NextResponse.json({
        data: createBlockedPlan(parsed.data.requirement, { ...ai, occupationName: occupation.name }, systemRule, "操作技能计划需加载内容结构表和技能细目表；当前接口暂仅支持理论知识计划确认。")
      });
    }

    const [outline, weights] = await Promise.all([
      getCurrentTheoryOutline(occupation.id, levelCode),
      getCurrentTheoryWeights(occupation.id)
    ]);

    if (!outline) {
      return NextResponse.json({
        data: createBlockedPlan(parsed.data.requirement, { ...ai, occupationName: occupation.name }, systemRule, "当前职业和等级尚未保存理论知识细目表，计划不能确认。")
      });
    }

    const quota = mergeQuota(systemRule, ai.temporaryMinimums);
    const points = outline.points.map((point) => ({
      name: point.name,
      code: point.code,
      single: quota.single,
      multiple: quota.multiple,
      judgement: quota.judgement,
      total: quota.total
    }));
    const weightTotal = weights
      ? weights.items.reduce((sum, item) => sum + (item.weights[levelCode] ?? 0), 0)
      : null;
    const blockers = [
      ...(weights ? (Math.abs(weightTotal! - 100) < 0.001 ? [] : [`权重表合计为 ${weightTotal}%，不等于 100%。`]) : ["当前职业尚未保存理论知识权重表。"])
    ];
    const validations = [
      { name: "职业与等级识别", status: "passed", detail: `${occupation.name} · ${levelLabels[levelCode]} · 理论知识` },
      { name: "理论知识细目表", status: "passed", detail: `已加载 V${outline.versionNo}，共 ${outline.points.length} 个考评点` },
      { name: "理论知识权重表", status: weights && !blockers.length ? "passed" : "blocked", detail: weights ? `已加载 V${weights.versionNo}，当前等级合计 ${weightTotal}%` : "未维护权重表" },
      { name: "题量规则", status: "passed", detail: describeQuota(systemRule, ai.temporaryMinimums, quota) }
    ];

    return NextResponse.json({
      data: {
        requirement: parsed.data.requirement,
        occupation: occupation.name,
        levelCode,
        levelLabel: levelLabels[levelCode],
        assessmentMode: "理论知识",
        source: ai.source,
        status: blockers.length ? "blocked" : "ready",
        message: blockers.length ? blockers.join(" ") : "已完成意图解析，并已关联当前生效的权重表、细目表及强制题量规则；确认后将冻结本次计划快照。",
        blueprintVersions: {
          outline: { id: outline.versionId, versionNo: outline.versionNo },
          weights: weights ? { id: weights.versionId, versionNo: weights.versionNo } : null
        },
        validations,
        temporaryMinimums: ai.temporaryMinimums,
        qualityRequirements: ai.qualityRequirements,
        points,
        minimumTotal: points.reduce((sum, point) => sum + point.total, 0),
        ruleHint: systemRule.hint
      }
    });
  } catch (error) {
    return NextResponse.json({
      error: { code: "PLAN_GENERATION_FAILED", message: error instanceof Error ? error.message : "命题计划生成失败，请稍后重试。" }
    }, { status: 500 });
  }
}

function getModelEndpoint(baseUrl: string, provider: string) {
  const url = new URL(baseUrl);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("模型 API 地址仅支持 HTTP 或 HTTPS。");
  url.pathname = url.pathname.replace(/\/+$/, "");
  const isZhipuPaaS = url.hostname === "open.bigmodel.cn" && url.pathname.startsWith("/api/paas/");
  const isAnthropic = !isZhipuPaaS && (provider.toLowerCase().includes("claude") || provider.toLowerCase().includes("anthropic") || url.pathname.endsWith("/messages"));
  if (isAnthropic) return { url: url.toString(), protocol: "anthropic" as const };
  if (!url.pathname.endsWith("/chat/completions")) {
    const isZhipuV4 = isZhipuPaaS && url.pathname.endsWith("/api/paas/v4");
    if (!isZhipuV4 && !url.pathname.endsWith("/v1")) url.pathname = `${url.pathname || ""}/v1`;
    url.pathname = `${url.pathname}/chat/completions`;
  }
  return { url: url.toString(), protocol: "openai" as const };
}

async function parseRequirement(requirement: string, occupationNames: string[]): Promise<ParsedRequirement & { source: "AI 智能规划" }> {
  const connection = await getSavedModelConnection();
  if (!connection) throw new Error("未配置可用模型连接，请先在管理员菜单的“模型设置”中保存 API 地址、模型名称和 API Key。");
  const endpoint = getModelEndpoint(connection.baseUrl, connection.provider);
  const instruction = `你是职业技能题库命题计划助手。请依据用户提供的完整提示词，仅提取命题意图和本次临时最低题量，不生成试题、不编造职业标准。只返回 JSON，不要 Markdown：
{"occupationName":"职业名称","levelCode":"level_5|level_4|level_3|level_2|level_1","assessmentMode":"theory|skill","temporaryMinimums":{"single":0,"multiple":0,"judgement":0},"qualityRequirements":["答案准确","避免重复"]}。
temporaryMinimums 表示“每个考评点至少”的题量；提示词未明确时填 0。当前可用职业：${occupationNames.join("、") || "未建立职业"}。`;
  let response: Response;
  try {
    response = await fetch(endpoint.url, {
      method: "POST",
      headers: endpoint.protocol === "anthropic"
        ? { "x-api-key": connection.apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" }
        : { Authorization: `Bearer ${connection.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(endpoint.protocol === "anthropic"
        ? { model: connection.model, max_tokens: 512, system: instruction, messages: [{ role: "user", content: requirement }] }
        : { model: connection.model, temperature: 0, messages: [{ role: "system", content: instruction }, { role: "user", content: requirement }] }),
      signal: AbortSignal.timeout(60000)
    });
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
    const detail = error instanceof Error ? error.message : "";
    throw new Error(`无法连接模型服务 ${endpoint.url}：${cause || detail || "请在模型设置中测试并修正 API 基础地址。"}`);
  }
  const raw = await response.text();
  let payload: ModelResponse | null = null;
  if (raw) {
    try {
      payload = JSON.parse(raw) as ModelResponse;
    } catch {
      throw new Error("模型服务返回的响应不是有效 JSON，请检查模型服务地址、协议与代理配置后重试。");
    }
  }
  if (!response.ok) throw new Error(payload?.error?.message || `AI 接口调用失败（${response.status}）。`);
  const content = endpoint.protocol === "anthropic"
    ? payload?.content?.[0]?.text ?? ""
    : payload?.choices?.[0]?.message?.content ?? "";
  const json = content.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error("AI 未返回可解析的命题范围。");
  let parsedContent: unknown;
  try {
    parsedContent = JSON.parse(json);
  } catch {
    throw new Error("AI 返回的命题范围 JSON 格式不正确，请调整模型输出格式后重试。");
  }
  const result = aiResultSchema.safeParse(parsedContent);
  if (!result.success) throw new Error("AI 返回的职业、等级或考核方式无效。");
  return { ...result.data, source: "AI 智能规划" };
}

function findOccupation<T extends { name: string }>(occupations: T[], occupationName: string) {
  return occupations.find((occupation) => occupation.name === occupationName)
    ?? occupations.find((occupation) => occupationName.includes(occupation.name) || occupation.name.includes(occupationName));
}

function getQuotaRule(levelCode: LevelCode): Quota {
  if (levelCode === "level_3") {
    return { single: 3, multiple: 2, judgement: 2, total: 7, hint: "三级每考评点至少 3 道单选、2 道多选、2 道判断。" };
  }
  if (levelCode === "level_1" || levelCode === "level_2") {
    return { single: 0, multiple: 0, judgement: 0, total: 0, hint: "二级、一级采用试卷库方式，需按已确认的试卷结构规划。"};
  }
  return { single: 4, multiple: 0, judgement: 2, total: 6, hint: "五级、四级每考评点至少 4 道单选、2 道判断。" };
}

function mergeQuota(systemRule: Quota, temporaryMinimums: ParsedRequirement["temporaryMinimums"]): Quota {
  const single = Math.max(systemRule.single, temporaryMinimums.single);
  const multiple = Math.max(systemRule.multiple, temporaryMinimums.multiple);
  const judgement = Math.max(systemRule.judgement, temporaryMinimums.judgement);
  return { ...systemRule, single, multiple, judgement, total: single + multiple + judgement };
}

function describeQuota(systemRule: Quota, temporaryMinimums: ParsedRequirement["temporaryMinimums"], appliedQuota: Quota) {
  const requested = [
    temporaryMinimums.single ? `单选≥${temporaryMinimums.single}` : "",
    temporaryMinimums.multiple ? `多选≥${temporaryMinimums.multiple}` : "",
    temporaryMinimums.judgement ? `判断≥${temporaryMinimums.judgement}` : ""
  ].filter(Boolean);
  const applied = `每考评点执行单选${appliedQuota.single}、多选${appliedQuota.multiple}、判断${appliedQuota.judgement}`;
  return requested.length ? `本次临时要求：${requested.join("、")}；与系统最低规则取较高值，${applied}。` : `${systemRule.hint} ${applied}。`;
}

function createBlockedPlan(
  requirement: string,
  parsed: ParsedRequirement,
  rule: Quota,
  message: string
) {
  return {
    requirement,
    occupation: parsed.occupationName,
    levelCode: parsed.levelCode,
    levelLabel: levelLabels[parsed.levelCode],
    assessmentMode: parsed.assessmentMode === "theory" ? "理论知识" : "操作技能",
    source: "AI 智能规划",
    status: "blocked",
    message,
    blueprintVersions: { outline: null, weights: null },
    validations: [],
    temporaryMinimums: parsed.temporaryMinimums,
    qualityRequirements: parsed.qualityRequirements,
    points: [],
    minimumTotal: 0,
    ruleHint: rule.hint
  };
}
