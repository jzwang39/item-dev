import { NextResponse } from "next/server";
import { z } from "zod";
import { getVerifiedSession } from "@/auth";
import { getSkillGenerationState, startSkillGeneration } from "@/modules/blueprints/skill-outline-generation";
import { uploadTextbook } from "@/modules/blueprints/theory-outline-generation/service";

export const runtime = "nodejs";
const schema = z.object({ action: z.literal("generate"), mode: z.enum(["textbook", "model"]), targetQuestions: z.number().int().min(30).max(50) });
async function guard() {
  const session = await getVerifiedSession();
  if (!session?.user?.id) return { error: NextResponse.json({ error: { message: "登录已失效。" } }, { status: 401 }) };
  if (session.user.role !== "admin") return { error: NextResponse.json({ error: { message: "仅管理员可维护操作技能细目表。" } }, { status: 403 }) };
  return { actor: session.user.id };
}
export async function GET(_request: Request, { params }: { params: { occupationId: string } }) {
  const auth = await guard();
  if (auth.error) return auth.error;
  try {
    return NextResponse.json({ data: await getSkillGenerationState(params.occupationId) });
  } catch (error) {
    return NextResponse.json({ error: { message: error instanceof Error ? error.message : "数据读取失败。" } }, { status: 422 });
  }
}
export async function POST(request: Request, { params }: { params: { occupationId: string } }) {
  const auth = await guard();
  if (auth.error) return auth.error;
  try {
    if (request.headers.get("content-type")?.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      return NextResponse.json({ data: await uploadTextbook(params.occupationId, "level_5", file instanceof File ? file : undefined, auth.actor!, "skill") }, { status: 201 });
    }
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: { message: "请选择生成模式及30～50题的目标题量。" } }, { status: 400 });
    return NextResponse.json({ data: await startSkillGeneration(params.occupationId, parsed.data.mode, parsed.data.targetQuestions, auth.actor!) }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: { message: error instanceof Error ? error.message : "任务创建失败。" } }, { status: 422 });
  }
}
