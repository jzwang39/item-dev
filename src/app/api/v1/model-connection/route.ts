import { NextResponse } from "next/server";
import { z } from "zod";

import { getVerifiedSession } from "@/auth";
import { getModelConnectionSettings, saveModelConnectionSettings } from "@/modules/model-connection/service";

const settingsSchema = z.object({
  provider: z.string().trim().min(1).max(100),
  baseUrl: z.string().trim().url().max(500),
  model: z.string().trim().max(200),
  apiKey: z.string().max(1000).optional()
});

async function requireAdmin() {
  const session = await getVerifiedSession();
  if (!session?.user?.id) return null;
  return session.user.role === "admin" ? session : null;
}

export async function GET() {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: { code: "FORBIDDEN", message: "仅管理员可查看模型连接设置。" } }, { status: 403 });
  return NextResponse.json({ data: await getModelConnectionSettings() });
}

export async function PUT(request: Request) {
  const session = await requireAdmin();
  if (!session?.user?.id) return NextResponse.json({ error: { code: "FORBIDDEN", message: "仅管理员可维护模型连接设置。" } }, { status: 403 });
  const parsed = settingsSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "请填写有效的服务商、API 地址和模型名称。" } }, { status: 400 });
  try {
    return NextResponse.json({ data: await saveModelConnectionSettings(parsed.data, session.user.id) });
  } catch (error) {
    return NextResponse.json({ error: { code: "MODEL_CONNECTION_SAVE_FAILED", message: error instanceof Error ? error.message : "模型连接设置保存失败。" } }, { status: 422 });
  }
}
