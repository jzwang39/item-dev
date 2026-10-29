import { NextResponse } from "next/server";
import { getVerifiedSession } from "@/auth";
import { exportConfirmedOutline } from "@/modules/blueprints/outline-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await getVerifiedSession();
  if (!session?.user?.id) return NextResponse.json({ error: { message: "登录已失效。" } }, { status: 401 });
  if (session.user.role !== "admin") return NextResponse.json({ error: { message: "仅管理员可导出已确认细目表。" } }, { status: 403 });
  const versionId = new URL(request.url).searchParams.get("versionId") ?? "";
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(versionId)) return NextResponse.json({ error: { message: "细目表版本无效。" } }, { status: 400 });
  try {
    const { bytes, filename } = await exportConfirmedOutline(versionId, session.user.id, session.user.role);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: { message: error instanceof Error ? error.message : "细目表导出失败。" } }, { status: 422 });
  }
}
