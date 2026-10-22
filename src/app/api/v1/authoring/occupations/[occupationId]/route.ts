import { NextResponse } from "next/server";
import { z } from "zod";

import { getVerifiedSession } from "@/auth";
import {
  OccupationOperationError,
  updateOccupation
} from "@/modules/authoring/occupations/service";

const updateOccupationSchema = z.object({
  name: z.string(),
  code: z.string()
});

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

  const parsed = updateOccupationSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "请输入职业名称和职业代码。" } }, { status: 400 });
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
