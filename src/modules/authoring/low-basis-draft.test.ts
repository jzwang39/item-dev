import assert from "node:assert/strict";
import test from "node:test";
import { assertLowBasisEvidence, buildLowBasisDraft, hasLowBasisEvidence, withLowBasisEvidence } from "./low-basis-draft";

test("标题相关草稿默认要求人工补来源摘录", () => {
  const draft = buildLowBasisDraft("宣讲要点", "宣讲要点 / 构成要素");
  assert.equal(draft.manualEvidenceExcerpt, "");
  assert.equal(hasLowBasisEvidence({ lowBasisDraft: draft }), false);
  assert.throws(() => assertLowBasisEvidence({ lowBasisDraft: draft }), /标题相关草稿须先在人工审核时补充来源摘录/);
});

test("人工补充来源摘录后允许确认和入库", () => {
  const updated = withLowBasisEvidence({ lowBasisDraft: buildLowBasisDraft("宣讲要点", "宣讲要点 / 构成要素") }, {
    excerpt: "公益慈善政策法规宣讲要点的构成要素",
    citation: "标题范围人工补录",
  });
  assert.equal(hasLowBasisEvidence(updated), true);
  assert.doesNotThrow(() => assertLowBasisEvidence(updated));
});
