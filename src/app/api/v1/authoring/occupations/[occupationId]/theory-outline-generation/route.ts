import { NextResponse } from "next/server";
import { z } from "zod";

import { getVerifiedSession } from "@/auth";
import {
  getTheoryOutlineGenerationState,
  startTheoryOutlineGeneration,
  TheoryOutlineGenerationError,
  uploadTextbook,
} from "@/modules/blueprints/theory-outline-generation/service";

const startSchema = z.object({
  action: z.literal("generate"),
  levelCode: z.enum(["level_5", "level_4", "level_3", "level_2", "level_1", "all"]),
  mode: z.enum(["textbook", "model"]),
});

function guard(session: Awaited<ReturnType<typeof getVerifiedSession>>) {
  if (!session?.user?.id) return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "登录已失效。" } }, { status: 401 });
  if (session.user.role !== "admin") return NextResponse.json({ error: { code: "FORBIDDEN", message: "仅管理员可维护理论知识细目表。" } }, { status: 403 });
  return null;
}

export async function GET(request: Request, { params }: Readonly<{ params: { occupationId: string } }>) {
  const session = await getVerifiedSession();
  const rejection = guard(session);
  if (rejection) return rejection;
  try {
    const levelCode = new URL(request.url).searchParams.get("levelCode") ?? "";
    return NextResponse.json({ data: await getTheoryOutlineGenerationState(params.occupationId, levelCode) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "生成任务读取失败。";
    return NextResponse.json({ error: { code: "THEORY_OUTLINE_GENERATION_READ_FAILED", message } }, { status: 422 });
  }
}

export async function POST(request: Request, { params }: Readonly<{ params: { occupationId: string } }>) {
  const session = await getVerifiedSession();
  const rejection = guard(session);
  if (rejection) return rejection;
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const levelCode = form.get("levelCode");
      const file = form.get("file");
      if (typeof levelCode !== "string") throw new TheoryOutlineGenerationError("请选择技能等级。");
      return NextResponse.json({
        data: await uploadTextbook(params.occupationId, levelCode, file instanceof File ? file : undefined, session!.user.id),
      }, { status: 201 });
    }
    const payload = startSchema.safeParse(await request.json());
    if (!payload.success) return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "生成参数无效。" } }, { status: 400 });
    const levels = payload.data.levelCode === "all"
      ? ["level_5", "level_4", "level_3", "level_2", "level_1"] as const
      : [payload.data.levelCode];
    const jobs = await Promise.all(
      levels.map((levelCode) =>
        startTheoryOutlineGeneration(params.occupationId, levelCode, payload.data.mode, session!.user.id),
      ),
    );
    return NextResponse.json({ data: { jobs } }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "细目表任务创建失败。";
    return NextResponse.json({ error: { code: "THEORY_OUTLINE_GENERATION_FAILED", message } }, { status: error instanceof TheoryOutlineGenerationError ? 422 : 500 });
  }
}
