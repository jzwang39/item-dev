import { NextResponse } from "next/server";
import { z } from "zod";

import { getVerifiedSession } from "@/auth";
import { AccountOperationError, changeOwnPassword } from "@/modules/accounts/service";

const passwordSchema = z.object({
  currentPassword: z.string(),
  newPassword: z.string()
});

export async function PUT(request: Request) {
  const session = await getVerifiedSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "登录已失效。" } }, { status: 401 });
  }

  const parsed = passwordSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "请输入当前密码和新密码。" } }, { status: 400 });
  }

  try {
    await changeOwnPassword(session.user.id, parsed.data);
    return NextResponse.json({ data: { changed: true } });
  } catch (error) {
    if (error instanceof AccountOperationError) {
      return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: error.message } }, { status: 422 });
    }
    throw error;
  }
}
