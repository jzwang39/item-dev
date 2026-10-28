const defaultTimeout = 300_000;

export async function jsonRequest(url: string, init?: RequestInit, timeoutMs = defaultTimeout) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  let timedOut = false;
  if (init?.signal?.aborted) abort();
  else init?.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, { cache: "no-store", ...init, signal: controller.signal });
    let body;
    try {
      body = await response.json();
    } catch (error) {
      if (controller.signal.aborted) throw error;
      throw new Error("服务器未返回有效数据，请稍后重试。");
    }
    if (!response.ok) throw new Error(body.error?.message ?? "法律法规命题操作失败。");
    return body.data;
  } catch (error) {
    if (timedOut) {
      const message = !init?.method || init.method.toUpperCase() === "GET"
        ? "加载超时，请稍后重新加载。"
        : "请求超时，请重新打开核对保存结果及任务状态，勿重复提交。";
      throw new Error(message);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    init?.signal?.removeEventListener("abort", abort);
  }
}
