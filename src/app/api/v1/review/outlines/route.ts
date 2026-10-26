import { NextResponse } from "next/server";
import { z } from "zod";
import { getVerifiedSession } from "@/auth";
import { actOnOutline, listOutlineReviews } from "@/modules/blueprints/point-review";
import { withTransaction } from "@/shared/database/mysql";

const schema = z.object({
  versionId: z.string().length(26), nodeId: z.string().length(26).optional(),
  action: z.enum(["approve", "return", "confirm", "assign"]),
  opinion: z.string().trim().max(5000).default(""), expertId: z.string().length(26).optional(),
}).refine((data) => !["approve", "return"].includes(data.action) || data.opinion.length > 0, "请填写审核意见。");

export async function GET(request: Request) {
  const session = await getVerifiedSession();
  if (!session?.user?.id) return NextResponse.json({ error: { message: "登录已失效。" } }, { status: 401 });
  try {
    return NextResponse.json({ data: await listOutlineReviews(session.user.id, session.user.role, new URL(request.url).searchParams.get("versionId") ?? undefined) });
  } catch (error) {
    return NextResponse.json({ error: { message: error instanceof Error ? error.message : "细目表加载失败。" } }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await getVerifiedSession();
  if (!session?.user?.id) return NextResponse.json({ error: { message: "登录已失效。" } }, { status: 401 });
  const body = await request.json();
  if (Array.isArray(body.versionIds)) {
    if (session.user.role !== "admin") return NextResponse.json({ error: { message: "仅管理员可分配任务。" } }, { status: 403 });
    const batch = z.object({ versionIds: z.array(z.string().length(26)).min(1).max(100), expertId: z.string().length(26) }).safeParse(body);
    if (!batch.success || new Set(batch.data.versionIds).size !== batch.data.versionIds.length) return NextResponse.json({ error: { message: "分配数据无效。" } }, { status: 400 });
    try {
      const changed = await withTransaction(async (db) => {
        let total = 0;
        for (const versionId of batch.data.versionIds.slice().sort()) {
          total += (await actOnOutline({ versionId, action: "assign", expertId: batch.data.expertId, opinion: "" }, session.user.id, "admin", db)).changed;
        }
        return total;
      });
      return NextResponse.json({ data: { assigned: batch.data.versionIds.length, changed } });
    } catch (error) {
      return NextResponse.json({ error: { message: error instanceof Error ? error.message : "分配失败。" } }, { status: 422 });
    }
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: { message: "审核数据无效，请填写意见并选择版本。" } }, { status: 400 });
  try {
    return NextResponse.json({ data: await actOnOutline(parsed.data, session.user.id, session.user.role) });
  } catch (error) {
    return NextResponse.json({ error: { message: error instanceof Error ? error.message : "审核失败。" } }, { status: 422 });
  }
}
