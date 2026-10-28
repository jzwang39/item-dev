import assert from "node:assert/strict";
import test from "node:test";
import { jsonRequest } from "./legal-agent-request";

test("加载成功后返回接口数据", async (context) => {
  context.mock.method(globalThis, "fetch", async () => Response.json({ data: { targets: [] } }));
  assert.deepEqual(await jsonRequest("/test", undefined, 100), { targets: [] });
});

test("接口失败保留业务错误，非 JSON 响应显示可重试提示", async (context) => {
  const fetch = context.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: { message: "登录已失效。" } }, { status: 401 }));
  await assert.rejects(jsonRequest("/test", undefined, 100), /登录已失效/);
  fetch.mock.mockImplementation(async () => new Response("<html>错误</html>", { status: 502 }));
  await assert.rejects(jsonRequest("/test", undefined, 100), /服务器未返回有效数据/);
});

test("挂起的请求超时后被取消并提示重试", async (context) => {
  let signal: AbortSignal | null | undefined;
  context.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  });
  await assert.rejects(jsonRequest("/test", undefined, 10), /加载超时/);
  assert.equal(signal?.aborted, true);
});

test("关闭弹窗可立即取消加载，不误报为超时", async (context) => {
  context.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
  const controller = new AbortController();
  const pending = jsonRequest("/test", { signal: controller.signal }, 100);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});
