import { NextResponse } from "next/server";
import { z } from "zod";
import { getVerifiedSession } from "@/auth";
import { adoptCommonQuestions, commonQuestionAction, configureCommonGroup, createCommonGroup, getCommonGroup,
  listCommonGroups, prepareCommonGeneration, publishCommonGroup, syncCommonBasis } from "@/modules/authoring/common-questions";
import { getGenerationState, startGeneration } from "@/modules/authoring/generation/service";
import { commonQuotaSchema } from "@/modules/authoring/common-question-policy";
import { stopGenerationKeepResults } from "@/modules/authoring/generation/stop";
import { terminateGeneration } from "@/modules/authoring/generation/termination";

export const dynamic = "force-dynamic";
const id = z.string().length(26);
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), occupationId: id }),
  z.object({ action: z.literal("configure"), groupId: id, rowVersion: z.number().int().positive(), quota: commonQuotaSchema }),
  z.object({ action: z.literal("adopt"), groupId: id, confirmed: z.literal(true),
    selections: z.array(z.object({ questionId: id, versionId: id })).min(1).max(100) }),
  z.object({ action: z.literal("generate"), groupId: id, retry: z.boolean().default(false) }),
  z.object({ action: z.literal("publish"), groupId: id, rowVersion: z.number().int().positive(), confirmed: z.literal(true) }),
  z.object({ action: z.literal("sync_basis"), groupId: id, confirmed: z.literal(true) }),
  z.object({ action: z.literal("stop"), groupId: id, confirmed: z.literal(true) }),
  z.object({ action: z.literal("terminate"), groupId: id, confirmed: z.literal(true) }),
  z.object({ action: z.literal("reopen"), groupId: id, questionId: id, versionId: id, confirmed: z.literal(true), opinion: z.string().trim().min(1).max(1000) }),
  z.object({ action: z.literal("suspend"), groupId: id, questionId: id, versionId: id, confirmed: z.literal(true), opinion: z.string().trim().min(1).max(1000) }),
]);
async function authorized() {
  const session = await getVerifiedSession();
  return session?.user.role === "admin" ? session.user.id : null;
}
export async function GET(request: Request) {
  if (!await authorized()) return NextResponse.json({ error: { message: "仅管理员可管理公共题组。" } }, { status: 403 });
  try {
    const params = new URL(request.url).searchParams;
    const groupId = params.get("groupId");
    if (!groupId) return NextResponse.json({ data: await listCommonGroups() });
    id.parse(groupId);
    const page = z.coerce.number().int().min(1).max(100000).parse(params.get("page") ?? 1);
    const data = await getCommonGroup(groupId, page, params.get("view") === "candidates");
    return NextResponse.json({ data: { ...data, generation: data.generationPlanId ? await getGenerationState(data.generationPlanId) : null } });
  } catch (error) {
    return NextResponse.json({ error: { message: error instanceof Error ? error.message : "公共题组加载失败。" } }, { status: 422 });
  }
}
export async function POST(request: Request) {
  const actor = await authorized();
  if (!actor) return NextResponse.json({ error: { message: "仅管理员可管理公共题组。" } }, { status: 403 });
  try {
    const input = schema.parse(await request.json());
    let data: unknown;
    switch (input.action) {
      case "create": data = await createCommonGroup(input.occupationId, actor); break;
      case "configure": data = await configureCommonGroup(input.groupId, input.quota, input.rowVersion, actor); break;
      case "adopt": data = await adoptCommonQuestions(input.groupId, input.selections, actor); break;
      case "publish": data = await publishCommonGroup(input.groupId, input.rowVersion, actor); break;
      case "sync_basis": data = await syncCommonBasis(input.groupId, actor); break;
      case "generate": {
        const planId = await prepareCommonGeneration(input.groupId, actor);
        data = await startGeneration(planId, actor, input.retry);
        break;
      }
      case "stop":
      case "terminate": {
        const group = await getCommonGroup(input.groupId, 1);
        if (!group.generationPlanId) throw new Error("公共题组尚未生成。");
        data = input.action === "stop" ? await stopGenerationKeepResults(group.generationPlanId, actor)
          : await terminateGeneration(group.generationPlanId, actor);
        break;
      }
      default: data = await commonQuestionAction(input.groupId, input.questionId, input.versionId, input.action, input.opinion, actor);
    }
    return NextResponse.json({ data: data ?? { saved: true } });
  } catch (error) {
    return NextResponse.json({ error: { message: error instanceof Error ? error.message : "公共题组操作失败。" } }, { status: 422 });
  }
}
