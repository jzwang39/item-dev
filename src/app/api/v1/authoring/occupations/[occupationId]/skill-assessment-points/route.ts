import { NextResponse } from "next/server";
import { z } from "zod";

import { getVerifiedSession } from "@/auth";
import { getCurrentSkillAssessmentPoints, saveSkillAssessmentPoint, SkillOutlineError, updateSkillAssessmentPoint } from "@/modules/blueprints/skill-outlines/service";

const schema = z.object({
  levelCode: z.enum(["level_5", "level_4", "level_3", "level_2", "level_1"]),
  name: z.string().min(1).max(500), level1Code: z.string().min(1).max(32), level1Name: z.string().min(1).max(300),
  level2Code: z.string().min(1).max(32), level2Name: z.string().min(1).max(300), level3Code: z.string().min(1).max(32), level3Name: z.string().min(1).max(300),
  ordinal: z.number().int().positive(), weight: z.number().min(0).max(100), importance: z.enum(["low", "medium", "high", "critical"]),
  abilityLevel: z.string().max(100), targetCount: z.number().int().min(1).max(99), selection: z.string().max(100), method: z.string().max(100), minutes: z.number().int().min(0).max(1000),
  standardText: z.string().max(5000), citation: z.string().max(1000), knowledgeMaterial: z.string().max(300), knowledgePoints: z.string().max(5000)
});

export async function GET(request: Request, { params }: Readonly<{ params: { occupationId: string } }>) {
  const session = await getVerifiedSession();
  if (!session?.user?.id) return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "登录已失效。" } }, { status: 401 });
  const levelCode = new URL(request.url).searchParams.get("levelCode") ?? "";
  try {
    return NextResponse.json({ data: { points: await getCurrentSkillAssessmentPoints(params.occupationId, levelCode) } });
  } catch (error) {
    if (error instanceof SkillOutlineError) return NextResponse.json({ error: { code: "SKILL_POINT_READ_FAILED", message: error.message } }, { status: 422 });
    throw error;
  }
}

export async function POST(request: Request, { params }: Readonly<{ params: { occupationId: string } }>) {
  const session = await getVerifiedSession();
  if (!session?.user?.id) return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "登录已失效。" } }, { status: 401 });
  if (session.user.role !== "admin") return NextResponse.json({ error: { code: "FORBIDDEN", message: "仅管理员可维护考评点。" } }, { status: 403 });
  const input = schema.safeParse(await request.json());
  if (!input.success) return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "考评点信息不完整或格式不正确。" } }, { status: 400 });
  const data = input.data;
  const code = `${data.level1Code}-${data.level2Code}-${data.level3Code}-${String(data.ordinal).padStart(3, "0")}`;
  try {
    return NextResponse.json({ data: await saveSkillAssessmentPoint(params.occupationId, data.levelCode, { ...data, code, range: data.level1Name }, session.user.id) }, { status: 201 });
  } catch (error) {
    if (error instanceof SkillOutlineError) return NextResponse.json({ error: { code: "SKILL_POINT_SAVE_FAILED", message: error.message } }, { status: 422 });
    throw error;
  }
}

export async function PUT(request: Request, { params }: Readonly<{ params: { occupationId: string } }>) {
  const session = await getVerifiedSession();
  if (!session?.user?.id) return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "登录已失效。" } }, { status: 401 });
  if (session.user.role !== "admin") return NextResponse.json({ error: { code: "FORBIDDEN", message: "仅管理员可维护考评点。" } }, { status: 403 });
  const payload = await request.json() as unknown;
  const originalCode = typeof payload === "object" && payload && "originalCode" in payload && typeof payload.originalCode === "string" ? payload.originalCode : "";
  const input = schema.safeParse(payload);
  if (!originalCode || !input.success) return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "考评点信息不完整或格式不正确。" } }, { status: 400 });
  const data = input.data;
  const code = `${data.level1Code}-${data.level2Code}-${data.level3Code}-${String(data.ordinal).padStart(3, "0")}`;
  try {
    return NextResponse.json({ data: await updateSkillAssessmentPoint(params.occupationId, data.levelCode, originalCode, { ...data, code, range: data.level1Name }, session.user.id) });
  } catch (error) {
    if (error instanceof SkillOutlineError) return NextResponse.json({ error: { code: "SKILL_POINT_UPDATE_FAILED", message: error.message } }, { status: 422 });
    throw error;
  }
}
