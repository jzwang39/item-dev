import { NextResponse } from "next/server";

import { getVerifiedSession } from "@/auth";
import { ensureSharedOccupationStandard } from "@/modules/blueprints/shared-standard";
import {
  getCurrentTheoryWeights,
  importTheoryWeights,
  listOccupationStandards,
  TheoryWeightImportError
} from "@/modules/blueprints/theory-weights/service";

function rejectUnauthorized(session: Awaited<ReturnType<typeof getVerifiedSession>>) {
  if (!session?.user?.id) {
    return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "登录已失效。" } }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return NextResponse.json({ error: { code: "FORBIDDEN", message: "仅管理员可维护理论知识权重表。" } }, { status: 403 });
  }
  return null;
}

export async function GET(
  _request: Request,
  { params }: Readonly<{ params: { occupationId: string } }>
) {
  const session = await getVerifiedSession();
  const rejection = rejectUnauthorized(session);
  if (rejection) return rejection;

  try {
    await ensureSharedOccupationStandard(params.occupationId, session!.user.id);
    const [current, standards] = await Promise.all([
      getCurrentTheoryWeights(params.occupationId),
      listOccupationStandards(params.occupationId)
    ]);
    return NextResponse.json({ data: { current, standards } });
  } catch (error) {
    if (error instanceof TheoryWeightImportError) {
      return NextResponse.json({ error: { code: "THEORY_WEIGHT_READ_FAILED", message: error.message } }, { status: 422 });
    }
    return NextResponse.json({ error: { code: "STANDARD_SYNC_FAILED", message: error instanceof Error ? error.message : "职业标准同步失败。" } }, { status: 422 });
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
  const sourceVersionId = formData.get("sourceVersionId");
  const file = candidate instanceof File ? candidate : undefined;

  try {
    const data = await importTheoryWeights(
      params.occupationId,
      { file, sourceVersionId: typeof sourceVersionId === "string" && sourceVersionId ? sourceVersionId : undefined },
      session!.user.id
    );
    return NextResponse.json({ data }, { status: 201 });
  } catch (error) {
    if (error instanceof TheoryWeightImportError) {
      return NextResponse.json({ error: { code: "THEORY_WEIGHT_IMPORT_FAILED", message: error.message } }, { status: 422 });
    }
    throw error;
  }
}
