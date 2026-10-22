import { NextResponse } from "next/server";
import { z } from "zod";

import { getVerifiedSession } from "@/auth";
import {
  AccountDeletionBlockedError,
  AccountOperationError,
  softDeleteAccount,
  updateAccount
} from "@/modules/accounts/service";

const updateAccountSchema = z.object({
  displayName: z.string().trim().min(1).max(128),
  phone: z.string().trim().max(32).optional(),
  email: z.string().trim().max(254).optional(),
  status: z.enum(["active", "disabled"])
});

export async function PATCH(
  request: Request,
  { params }: Readonly<{ params: { accountId: string } }>
) {
  const session = await getVerifiedSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "登录已失效。" } }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return NextResponse.json({ error: { code: "FORBIDDEN", message: "仅管理员可更新成员信息。" } }, { status: 403 });
  }

  const parsed = updateAccountSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "成员信息填写不完整或格式不正确。" } }, { status: 400 });
  }

  try {
    await updateAccount(params.accountId, parsed.data, session.user.id);
    return NextResponse.json({ data: { updated: true } });
  } catch (error) {
    if (error instanceof AccountOperationError) {
      return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: error.message } }, { status: 422 });
    }
    throw error;
  }
}

export async function DELETE(
  _request: Request,
  { params }: Readonly<{ params: { accountId: string } }>
) {
  const session = await getVerifiedSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "登录已失效。" } }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return NextResponse.json({ error: { code: "FORBIDDEN", message: "仅管理员可删除账号。" } }, { status: 403 });
  }

  try {
    await softDeleteAccount(params.accountId, session.user.id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof AccountDeletionBlockedError) {
      return NextResponse.json(
        { error: { code: "BUSINESS_RULE_BLOCKED", message: error.message } },
        { status: 422 }
      );
    }
    throw error;
  }
}
