import { NextResponse } from "next/server";
import { getVerifiedSession } from "@/auth";
import { getSkillStandard, importSkillStandard, listSkillStandards, saveStandardStructure } from "@/modules/blueprints/skill-standard-import";
import { ensureSharedOccupationStandard } from "@/modules/blueprints/shared-standard";
import { structureEditSchema } from "@/modules/blueprints/skill-structures/standard-edit";

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
  try {
    await ensureSharedOccupationStandard(params.occupationId, auth.actorId!);
    const [current, standards] = await Promise.all([getSkillStandard(params.occupationId), listSkillStandards(params.occupationId)]);
    return NextResponse.json({ data: { current, standards } });
  } catch (error) {
    return NextResponse.json({ error: { message: error instanceof Error ? error.message : "职业标准同步失败。" } }, { status: 422 });
  }
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

export async function PUT(request: Request, { params }: { params: { occupationId: string } }) {
  const auth = await authorize();
  if (auth.rejection) return auth.rejection;
  try {
    const parsed = structureEditSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: { message: "请完整填写选考方式、各范围时间、考核方式和总考试时间。" } }, { status: 400 });
    const data = await saveStandardStructure(params.occupationId, parsed.data, auth.actorId!);
    return NextResponse.json({ data });
  } catch (error) {
    return NextResponse.json({ error: { message: error instanceof Error ? error.message : "内容结构保存失败。" } }, { status: 422 });
  }
}
