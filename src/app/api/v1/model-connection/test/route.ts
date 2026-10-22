import { NextResponse } from "next/server";
import { z } from "zod";

import { getVerifiedSession } from "@/auth";
import { resolveModelApiKey } from "@/modules/model-connection/service";

const testSchema = z.object({
  provider: z.string().trim().min(1).max(100),
  baseUrl: z.string().trim().url().max(500),
  model: z.string().trim().max(200).optional(),
  apiKey: z.string().trim().max(1000).optional()
});

function getModelEndpoint(baseUrl: string, provider: string) {
  const url = new URL(baseUrl);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("API 基础地址仅支持 HTTP 或 HTTPS。");
  url.pathname = url.pathname.replace(/\/+$/, "");
  const isAnthropic = provider.toLowerCase().includes("claude") || provider.toLowerCase().includes("anthropic") || url.pathname.endsWith("/messages");
  if (isAnthropic) return { url: url.toString(), protocol: "anthropic" as const };
  if (!url.pathname.endsWith("/v1")) url.pathname = `${url.pathname || ""}/v1`;
  url.pathname = `${url.pathname}/chat/completions`;
  return { url: url.toString(), protocol: "openai" as const };
}

export async function POST(request: Request) {
  const session = await getVerifiedSession();
  if (!session?.user?.id) return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "登录已失效。" } }, { status: 401 });
  if (session.user.role !== "admin") return NextResponse.json({ error: { code: "FORBIDDEN", message: "仅管理员可测试模型连接。" } }, { status: 403 });

  const parsed = testSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "请填写有效的 API 地址和 API Key。" } }, { status: 400 });

  const { provider, baseUrl } = parsed.data;
  const apiKey = await resolveModelApiKey(parsed.data.apiKey);
  if (!apiKey) return NextResponse.json({ error: { code: "API_KEY_REQUIRED", message: "请填写 API Key，或先应用已保存的模型连接设置。" } }, { status: 400 });
  const model = parsed.data.model || (provider.toLowerCase().includes("deepseek") ? "deepseek-chat" : "");
  if (!model) return NextResponse.json({ error: { code: "MODEL_REQUIRED", message: "请填写模型名称。" } }, { status: 400 });

  try {
    const endpoint = getModelEndpoint(baseUrl, provider);
    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: endpoint.protocol === "anthropic"
        ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" }
        : { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(endpoint.protocol === "anthropic"
        ? { model, max_tokens: 64, messages: [{ role: "user", content: "你好" }] }
        : { model, messages: [{ role: "user", content: "你好" }], max_tokens: 64 }),
      signal: AbortSignal.timeout(30_000)
    });
    const raw = await response.text();
    const payload = raw ? JSON.parse(raw) as {
      choices?: Array<{ message?: { content?: string } }>;
      content?: Array<{ text?: string }>;
      error?: { message?: string };
    } : null;
    if (!response.ok) {
      return NextResponse.json({ error: { code: "MODEL_API_FAILED", message: payload?.error?.message || `模型服务返回 HTTP ${response.status}。` } }, { status: 422 });
    }
    const reply = endpoint.protocol === "anthropic"
      ? payload?.content?.[0]?.text?.trim()
      : payload?.choices?.[0]?.message?.content?.trim();
    if (!reply) return NextResponse.json({ error: { code: "INVALID_MODEL_RESPONSE", message: "模型服务已响应，但未返回文本内容。" } }, { status: 422 });
    return NextResponse.json({ data: { reply } });
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
    const detail = error instanceof Error ? error.message : "";
    const message = error instanceof Error && error.name === "TimeoutError"
      ? "模型连接超时，请检查 API 地址和网络。"
      : `模型连接失败：${cause || detail || "请检查 API 地址、模型名称和 Key。"}`;
    return NextResponse.json({ error: { code: "MODEL_CONNECTION_FAILED", message } }, { status: 502 });
  }
}
