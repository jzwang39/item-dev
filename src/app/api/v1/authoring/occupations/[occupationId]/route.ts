import { NextResponse } from "next/server";

import { getVerifiedSession } from "@/auth";
import { occupationInputSchema } from "@/modules/authoring/occupations/input";
import {
  archiveOccupation,
  OccupationOperationError,
  updateOccupation
} from "@/modules/authoring/occupations/service";

export async function PUT(
  request: Request,
  { params }: Readonly<{ params: { occupationId: string } }>
) {
  const session = await getVerifiedSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "登录已失效。" } }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return NextResponse.json({ error: { code: "FORBIDDEN", message: "仅管理员可维护职业。" } }, { status: 403 });
  }

  const parsed = occupationInputSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "请检查职业名称、职业代码及职业方向，名称最多 200 字，职业代码最多 64 字。" } }, { status: 400 });
  }

  try {
    const occupation = await updateOccupation(params.occupationId, parsed.data, session.user.id);
    return NextResponse.json({ data: occupation });
  } catch (error) {
    if (error instanceof OccupationOperationError) {
      return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: error.message } }, { status: 422 });
    }
    throw error;
  }
}

export async function DELETE(
  _request: Request,
  { params }: Readonly<{ params: { occupationId: string } }>,
) {
  const session = await getVerifiedSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "登录已失效。" } }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return NextResponse.json({ error: { code: "FORBIDDEN", message: "仅管理员可维护职业。" } }, { status: 403 });
  }
  try {
    return NextResponse.json({ data: await archiveOccupation(params.occupationId, session.user.id) });
  } catch (error) {
    if (error instanceof OccupationOperationError) {
      return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: error.message } }, { status: 422 });
    }
    throw error;
  }
}
