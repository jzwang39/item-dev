import { NextResponse } from "next/server";
import { z } from "zod";

import { getVerifiedSession } from "@/auth";
import { getCurrentSkillStructure, saveSkillStructure, SkillStructureError } from "@/modules/blueprints/skill-structures/service";

const inputSchema = z.object({
  name: z.string().max(300),
  levelCode: z.enum(["level_5", "level_4", "level_3", "level_2", "level_1"]),
  ruleBasis: z.string().max(300),
  pathway: z.string().max(300),
  totalMinutes: z.number().finite().positive(),
  rows: z.array(z.object({
    code: z.string().min(1).max(128),
    name: z.string().min(1).max(500),
    selection: z.enum(["required", "optional"]),
    score: z.number().finite().min(0).max(100),
    minutes: z.number().finite().min(0),
    method: z.string().min(1).max(100)
  })).min(1).max(30)
});

function rejectUnauthorized(session: Awaited<ReturnType<typeof getVerifiedSession>>) {
  if (!session?.user?.id) return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "登录已失效。" } }, { status: 401 });
  if (session.user.role !== "admin") return NextResponse.json({ error: { code: "FORBIDDEN", message: "仅管理员可维护操作技能内容结构。" } }, { status: 403 });
  return null;
}

export async function GET(request: Request, { params }: Readonly<{ params: { occupationId: string } }>) {
  const session = await getVerifiedSession();
  const rejection = rejectUnauthorized(session);
  if (rejection) return rejection;
  try {
    const levelCode = new URL(request.url).searchParams.get("levelCode") ?? "";
    return NextResponse.json({ data: { current: await getCurrentSkillStructure(params.occupationId, levelCode) } });
  } catch (error) {
    if (error instanceof SkillStructureError) return NextResponse.json({ error: { code: "SKILL_STRUCTURE_READ_FAILED", message: error.message } }, { status: 422 });
    throw error;
  }
}

export async function PUT(request: Request, { params }: Readonly<{ params: { occupationId: string } }>) {
  const session = await getVerifiedSession();
  const rejection = rejectUnauthorized(session);
  if (rejection) return rejection;
  const parsed = inputSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "内容结构数据格式不正确。" } }, { status: 400 });
  try {
    return NextResponse.json({ data: await saveSkillStructure(params.occupationId, parsed.data, session!.user.id) }, { status: 201 });
  } catch (error) {
    if (error instanceof SkillStructureError) return NextResponse.json({ error: { code: "SKILL_STRUCTURE_SAVE_FAILED", message: error.message } }, { status: 422 });
    throw error;
  }
}
