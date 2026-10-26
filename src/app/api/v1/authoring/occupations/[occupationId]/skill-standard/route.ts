import { NextResponse } from "next/server";
import { getVerifiedSession } from "@/auth";
import { getSkillStandard, importSkillStandard, listSkillStandards } from "@/modules/blueprints/skill-standard-import";

export const runtime = "nodejs";

async function authorize() {
  const session = await getVerifiedSession();
  if (!session?.user?.id) return { rejection: NextResponse.json({ error: { message: "登录已失效。" } }, { status: 401 }) };
  if (session.user.role !== "admin") return { rejection: NextResponse.json({ error: { message: "仅管理员可导入国家职业标准。" } }, { status: 403 }) };
  return { actorId: session.user.id };
}

export async function GET(_request: Request, { params }: { params: { occupationId: string } }) {
  const auth = await authorize();
  if (auth.rejection) return auth.rejection;
  const [current, standards] = await Promise.all([getSkillStandard(params.occupationId), listSkillStandards(params.occupationId)]);
  return NextResponse.json({ data: { current, standards } });
}

export async function POST(request: Request, { params }: { params: { occupationId: string } }) {
  const auth = await authorize();
  if (auth.rejection) return auth.rejection;
  try {
    const form = await request.formData();
    const candidate = form.get("file");
    const source = form.get("sourceVersionId");
    if (source && (typeof source !== "string" || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(source))) {
      return NextResponse.json({ error: { message: "资料版本格式不正确。" } }, { status: 400 });
    }
    const data = await importSkillStandard(params.occupationId, {
      file: candidate instanceof File ? candidate : undefined,
      sourceVersionId: typeof source === "string" && source ? source : undefined,
      preview: form.get("preview") === "true",
    }, auth.actorId!);
    return NextResponse.json({ data }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: { message: error instanceof Error ? error.message : "标准识别失败。" } }, { status: 422 });
  }
}
