import { NextResponse } from "next/server";
import { z } from "zod";

import { getVerifiedSession } from "@/auth";
import {
  getCurrentSkillWeights,
  saveSkillWeights,
  SkillWeightError
} from "@/modules/blueprints/skill-weights/service";

const levelSchema = z.object({
  level_5: z.number().finite(),
  level_4: z.number().finite(),
  level_3: z.number().finite(),
  level_2: z.number().finite(),
  level_1: z.number().finite()
});
const inputSchema = z.object({
  items: z.array(z.object({ name: z.string().max(500), weights: levelSchema })).max(20)
});

function rejectUnauthorized(session: Awaited<ReturnType<typeof getVerifiedSession>>) {
  if (!session?.user?.id) {
    return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "登录已失效。" } }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return NextResponse.json({ error: { code: "FORBIDDEN", message: "仅管理员可维护职业技能要求权重表。" } }, { status: 403 });
  }
  return null;
}

export async function GET(
  _request: Request,
  { params }: Readonly<{ params: { occupationId: string } }>
) {
  const session = await getVerifiedSession();
  const rejection = rejectUnauthorized(session);
  if (rejection) return rejection;
  try {
    return NextResponse.json({ data: { current: await getCurrentSkillWeights(params.occupationId) } });
  } catch (error) {
    if (error instanceof SkillWeightError) {
      return NextResponse.json({ error: { code: "SKILL_WEIGHT_READ_FAILED", message: error.message } }, { status: 422 });
    }
    throw error;
  }
}

export async function PUT(
  request: Request,
  { params }: Readonly<{ params: { occupationId: string } }>
) {
  const session = await getVerifiedSession();
  const rejection = rejectUnauthorized(session);
  if (rejection) return rejection;
  const parsed = inputSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "权重表数据格式不正确。" } }, { status: 400 });
  }
  try {
    return NextResponse.json(
      { data: await saveSkillWeights(params.occupationId, parsed.data.items, session!.user.id) },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof SkillWeightError) {
      return NextResponse.json({ error: { code: "SKILL_WEIGHT_SAVE_FAILED", message: error.message } }, { status: 422 });
    }
    throw error;
  }
}
