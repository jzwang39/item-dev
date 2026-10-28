import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sharedStandardNeedsSync, type StandardBinding } from "./shared-standard";
import { parseSkillStandard } from "./skill-standard";
import { parseDirectionalTheoryWeights, parseStandardRequirements } from "./theory-weights/standard";

function binding(mode: "theory" | "skill", fileObjectId = "same-file", time = 1): StandardBinding {
  return {
    mode, fileObjectId, sourceVersionId: null, createdAt: new Date(time),
    snapshot: mode === "theory" ? { scopes: [{}] } : { columns: [{}] },
  };
}

test("只有理论标准或只有技能标准时，另一边应复用原件同步", () => {
  for (const mode of ["theory", "skill"] as const) {
    const current = binding(mode);
    assert.equal(sharedStandardNeedsSync([current]), current);
  }
});

test("两流程已经共用同一标准时不重复创建版本", () => {
  assert.equal(sharedStandardNeedsSync([binding("theory"), binding("skill", "same-file", 2)]), null);
});

test("不同标准版本以最新已确认原件为准，缺少来源不能视为已上传", () => {
  const latest = binding("skill", "new-file", 2);
  assert.equal(sharedStandardNeedsSync([binding("theory", "old-file"), latest]), latest);
  assert.equal(sharedStandardNeedsSync([]), null);
  assert.equal(sharedStandardNeedsSync([{ ...binding("skill"), fileObjectId: null }]), null);
  assert.ok(sharedStandardNeedsSync([binding("theory"), { ...binding("skill"), snapshot: {} }]));
});

test("真实劝募员完整标准一次解析出两流程的五个等级数据", async () => {
  const { extractPdfText } = await import("@/modules/documents/extraction/service");
  const { text } = await extractPdfText(await readFile("docs/测试真实数据/劝募员-标准（技能水平和理论知识&一级到五级）.pdf"));
  const theory = parseDirectionalTheoryWeights(text, { name: "劝募员", code: "3-01-01-05", directions: [] });
  const requirements = parseStandardRequirements(text, theory);
  const skill = parseSkillStandard(text);
  assert.equal(requirements.length, 5);
  assert.equal(skill.scopes.length, 5);
  assert.deepEqual(new Set(requirements.map((scope) => scope.levelCode)), new Set(skill.scopes.map((scope) => scope.column.levelCode)));
});
