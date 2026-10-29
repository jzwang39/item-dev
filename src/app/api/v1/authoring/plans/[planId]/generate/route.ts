import { NextResponse } from "next/server";
import { getVerifiedSession } from "@/auth";
import { ensureGenerationWorker, getGenerationState, startGeneration } from "@/modules/authoring/generation/service";
import { terminateGeneration } from "@/modules/authoring/generation/termination";
import { stopGenerationKeepResults } from "@/modules/authoring/generation/stop";

export const dynamic = "force-dynamic";

async function authorize() {
  const session = await getVerifiedSession();
  if (!session?.user?.id) return { response: NextResponse.json({ error: { message: "登录已失效。" } }, { status: 401 }) };
  if (session.user.role !== "admin") return { response: NextResponse.json({ error: { message: "仅管理员可执行命题任务。" } }, { status: 403 }) };
  return { actorId: session.user.id };
}

export async function GET(_: Request, { params }: { params: { planId: string } }) {
  const auth = await authorize();
  if (auth.response) return auth.response;
  try {
    ensureGenerationWorker();
    return NextResponse.json({ data: await getGenerationState(params.planId) });
  } catch (error) {
    return NextResponse.json({ error: { message: error instanceof Error ? error.message : "进度读取失败。" } }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: { params: { planId: string } }) {
  const auth = await authorize();
  if (auth.response) return auth.response;
  try {
    const body = await request.text();
    const action = body ? (JSON.parse(body) as { action?: string }).action : undefined;
    if (action === "stop_keep") {
      const summary = await stopGenerationKeepResults(params.planId, auth.actorId!);
      return NextResponse.json({ data: { summary, ...await getGenerationState(params.planId) } });
    }
    if (action === "terminate") {
      const summary = await terminateGeneration(params.planId, auth.actorId!);
      return NextResponse.json({ data: { summary, ...await getGenerationState(params.planId) } });
    }
    if (action && action !== "retry_failed") return NextResponse.json({ error: { message: "不支持的任务操作。" } }, { status: 400 });
    const data = await startGeneration(params.planId, auth.actorId!, action === "retry_failed");
    return NextResponse.json({ data }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: { code: "PLAN_EXECUTION_FAILED", message: error instanceof Error ? error.message : "任务启动失败。" } }, { status: 422 });
  }
}
