import { NextResponse } from "next/server";

import { getVerifiedSession } from "@/auth";
import {
  getCurrentTheoryOutline,
  importTheoryOutline,
  TheoryOutlineImportError
} from "@/modules/blueprints/theory-outlines/service";

function rejectUnauthorized(session: Awaited<ReturnType<typeof getVerifiedSession>>) {
  if (!session?.user?.id) {
    return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "登录已失效。" } }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return NextResponse.json({ error: { code: "FORBIDDEN", message: "仅管理员可维护理论知识考评要素细目表。" } }, { status: 403 });
  }
  return null;
}

export async function GET(
  request: Request,
  { params }: Readonly<{ params: { occupationId: string } }>
) {
  const session = await getVerifiedSession();
  const rejection = rejectUnauthorized(session);
  if (rejection) return rejection;

  try {
    const levelCode = new URL(request.url).searchParams.get("levelCode") ?? "";
    const current = await getCurrentTheoryOutline(params.occupationId, levelCode);
    return NextResponse.json({ data: { current } });
  } catch (error) {
    if (error instanceof TheoryOutlineImportError) {
      return NextResponse.json({ error: { code: "THEORY_OUTLINE_READ_FAILED", message: error.message } }, { status: 422 });
    }
    throw error;
  }
}

export async function POST(
  request: Request,
  { params }: Readonly<{ params: { occupationId: string } }>
) {
  const session = await getVerifiedSession();
  const rejection = rejectUnauthorized(session);
  if (rejection) return rejection;

  const formData = await request.formData();
  const candidate = formData.get("file");
  const levelCode = formData.get("levelCode");
  try {
    const data = await importTheoryOutline(
      params.occupationId,
      typeof levelCode === "string" ? levelCode : "",
      candidate instanceof File ? candidate : undefined,
      session!.user.id
    );
    return NextResponse.json({ data }, { status: 201 });
  } catch (error) {
    if (error instanceof TheoryOutlineImportError) {
      return NextResponse.json({ error: { code: "THEORY_OUTLINE_IMPORT_FAILED", message: error.message } }, { status: 422 });
    }
    throw error;
  }
}
