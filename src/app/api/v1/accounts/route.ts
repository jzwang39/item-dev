import { NextResponse } from "next/server";
import { z } from "zod";

import { getVerifiedSession } from "@/auth";
import {
  AccountOperationError,
  createExpertAccount,
  listAccounts
} from "@/modules/accounts/service";

const createAccountSchema = z.object({
  username: z.string(),
  displayName: z.string(),
  password: z.string(),
  phone: z.string().optional(),
  email: z.string().optional()
});

export async function GET() {
  const session = await getVerifiedSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "登录已失效。" } }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return NextResponse.json({ error: { code: "FORBIDDEN", message: "仅管理员可查看成员。" } }, { status: 403 });
  }

  return NextResponse.json({ data: await listAccounts() });
}

export async function POST(request: Request) {
  const session = await getVerifiedSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "登录已失效。" } }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return NextResponse.json({ error: { code: "FORBIDDEN", message: "仅管理员可创建专家账号。" } }, { status: 403 });
  }

  const parsed = createAccountSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "输入数据不完整。" } }, { status: 400 });
  }

  try {
    await createExpertAccount(parsed.data, session.user.id);
    return NextResponse.json({ data: { created: true } }, { status: 201 });
  } catch (error) {
    if (error instanceof AccountOperationError) {
      return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: error.message } }, { status: 422 });
    }
    throw error;
  }
}
