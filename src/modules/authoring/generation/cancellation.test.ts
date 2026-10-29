import assert from "node:assert/strict";
import test from "node:test";
import { abortGenerationJob, registerGenerationRequest } from "./cancellation";

test("终止只撤销对应任务，不影响另一任务的模型请求", () => {
  const a = registerGenerationRequest("a", "job-a");
  const b = registerGenerationRequest("b", "job-b");
  try {
    abortGenerationJob("job-a");
    assert.equal(a.controller.signal.aborted, true);
    assert.equal(b.controller.signal.aborted, false);
    assert.throws(() => a.controller.signal.throwIfAborted(), /已终止/);
  } finally { a.release(); b.release(); }
});

test("旧租约释放不删除同一请求的新控制器，重复终止幂等", () => {
  const old = registerGenerationRequest("same-unit", "job");
  const current = registerGenerationRequest("same-unit", "job");
  old.release();
  try {
    abortGenerationJob("job");
    abortGenerationJob("job");
    assert.equal(current.controller.signal.aborted, true);
    assert.equal(old.controller.signal.aborted, false);
  } finally { current.release(); }
  assert.equal(globalThis.__authoringGenerationControllers?.size, 0);
});
