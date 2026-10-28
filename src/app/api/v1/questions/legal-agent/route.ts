import { NextResponse } from "next/server";
import { z } from "zod";
import { getVerifiedSession } from "@/auth";
import { extractDocxText, extractPdfText } from "@/modules/documents/extraction/service";
import { legalConfigSchema } from "@/modules/authoring/legal-contracts";
import { getLegalConfig, listLegalJobs, saveLegalConfig, startLegalJob } from "@/modules/authoring/legal-service";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
const generateSchema = z.object({
  topicIds: z.array(z.string().max(30)).min(1).max(10),
  instructions: z.string().trim().max(12000), revision: z.number().int().positive(),
});
function guard(session: Awaited<ReturnType<typeof getVerifiedSession>>) {
  if (!session?.user?.id) return NextResponse.json({ error: { message: "登录已失效。" } }, { status: 401 });
  if (session.user.role !== "admin") return NextResponse.json({ error: { message: "仅管理员可使用法律法规命题及提示词管理。" } }, { status: 403 });
  return null;
}
function failure(error: unknown) {
  return NextResponse.json({ error: { message: error instanceof Error ? error.message : "法规命题操作失败。" } }, { status: 422 });
}
export async function GET(request: Request) {
  const session = await getVerifiedSession(), rejection = guard(session);
  if (rejection) return rejection;
  try {
    if (new URL(request.url).searchParams.get("view") === "jobs") return NextResponse.json({ data: { jobs: await listLegalJobs() } });
    const [config, jobs] = await Promise.all([getLegalConfig(), listLegalJobs()]);
    return NextResponse.json({ data: { config, jobs } });
  } catch (error) { return failure(error); }
}
export async function PUT(request: Request) {
  const session = await getVerifiedSession(), rejection = guard(session);
  if (rejection) return rejection;
  try {
    const input = z.object({ topics: z.array(legalConfigSchema).length(10), revision: z.number().int().positive() }).parse(await request.json());
    return NextResponse.json({ data: await saveLegalConfig(input.topics, input.revision, session!.user.id) });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  const session = await getVerifiedSession(), rejection = guard(session);
  if (rejection) return rejection;
  try {
    if (request.headers.get("content-type")?.includes("multipart/form-data")) {
      const form = await request.formData(), file = form.get("file");
      if (!(file instanceof File) || !file.size || file.size > 15 * 1024 * 1024) throw new Error("请选择不超过15MB的正式法规原文文件。");
      const bytes = Buffer.from(await file.arrayBuffer());
      const extension = file.name.split(".").pop()?.toLowerCase();
      const text = extension === "pdf" ? (await extractPdfText(bytes)).text
        : extension === "docx" ? await extractDocxText(bytes)
          : extension === "txt" ? bytes.toString("utf8") : "";
      if (!text.trim() || text.length > 300000) throw new Error("文件无可提取文字或超过30万字，仅支持PDF、DOCX、TXT。");
      return NextResponse.json({ data: { text, originalName: file.name } });
    }
    const input = generateSchema.parse(await request.json());
    return NextResponse.json({ data: await startLegalJob(input.topicIds, input.instructions, input.revision, session!.user.id) }, { status: 202 });
  } catch (error) { return failure(error); }
}
