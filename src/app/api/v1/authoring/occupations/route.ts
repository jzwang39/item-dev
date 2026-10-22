import { NextResponse } from "next/server";
import { z } from "zod";

import { getVerifiedSession } from "@/auth";
import {
  createOccupation,
  listActiveOccupations,
  OccupationOperationError
} from "@/modules/authoring/occupations/service";

const createOccupationSchema = z.object({
  name: z.string(),
  code: z.string()
});

function rejectUnauthorized(session: Awaited<ReturnType<typeof getVerifiedSession>>) {
  if (!session?.user?.id) {
    return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "登录已失效。" } }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return NextResponse.json({ error: { code: "FORBIDDEN", message: "仅管理员可维护职业。" } }, { status: 403 });
  }
  return null;
}

export async function GET() {
  const session = await getVerifiedSession();
  const rejection = rejectUnauthorized(session);
  if (rejection) {
    return rejection;
  }

  try {
    return NextResponse.json({ data: await listActiveOccupations() });
  } catch (error) {
    if (error instanceof OccupationOperationError) {
      return NextResponse.json({ error: { code: "PROJECT_CONTEXT_REQUIRED", message: error.message } }, { status: 422 });
    }
    throw error;
  }
}

export async function POST(request: Request) {
  const session = await getVerifiedSession();
  const rejection = rejectUnauthorized(session);
  if (rejection) {
    return rejection;
  }

  const parsed = createOccupationSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "请输入职业名称和职业代码。" } }, { status: 400 });
  }

  try {
    const occupation = await createOccupation(parsed.data, session!.user.id);
    return NextResponse.json({ data: occupation }, { status: 201 });
  } catch (error) {
    if (error instanceof OccupationOperationError) {
      return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: error.message } }, { status: 422 });
    }
    throw error;
  }
}
