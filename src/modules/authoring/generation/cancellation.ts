declare global {
  var __authoringGenerationControllers: Map<string, { jobId: string; controller: AbortController }> | undefined;
}

export function registerGenerationRequest(unitId: string, jobId: string) {
  const requests = globalThis.__authoringGenerationControllers ??= new Map();
  const controller = new AbortController();
  requests.set(unitId, { jobId, controller });
  return {
    controller,
    release: () => { if (requests.get(unitId)?.controller === controller) requests.delete(unitId); },
  };
}

export function abortGenerationJob(jobId: string) {
  for (const request of globalThis.__authoringGenerationControllers?.values() ?? []) {
    if (request.jobId === jobId) request.controller.abort(new Error("命题任务已终止。"));
  }
}

export function abortGenerationUnits(unitIds: string[]) {
  for (const unitId of unitIds) {
    globalThis.__authoringGenerationControllers?.get(unitId)?.controller.abort(new Error("命题请求已停止。"));
  }
}
