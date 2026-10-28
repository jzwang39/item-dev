import assert from "node:assert/strict";
import test from "node:test";
import { BULK_REVIEW_LIMIT, bulkQuestionReviewSchema, canBulkReviewQuestion } from "./bulk-question-review";

const question = (index: number) => ({ questionId: String(index).padStart(26, "0"), versionId: "V".repeat(26) });
const request = {
  action: "bulk_approve", confirmed: true, opinion: "管理员审核，同意通过。",
  questions: [question(1)],
};

test("批量审核接受已确认且有意见的版本快照", () => {
  assert.equal(bulkQuestionReviewSchema.safeParse(request).success, true);
  const parsed = bulkQuestionReviewSchema.parse({ ...request, decision: "returned", stem: "客户端篡改内容" });
  assert.equal("decision" in parsed, false);
  assert.equal("stem" in parsed, false);
});

test("拒绝未确认、无意见、空列表和错误版本标识", () => {
  for (const invalid of [
    { ...request, confirmed: false }, { ...request, confirmed: undefined },
    { ...request, opinion: " " }, { ...request, questions: [] },
    { ...request, questions: [{ ...question(1), versionId: "invalid" }] },
  ]) {
    assert.equal(bulkQuestionReviewSchema.safeParse(invalid).success, false);
  }
});

test("单批最多50道，拒绝超限和重复试题", () => {
  assert.equal(bulkQuestionReviewSchema.safeParse({
    ...request, questions: Array.from({ length: BULK_REVIEW_LIMIT }, (_, index) => question(index)),
  }).success, true);
  assert.equal(bulkQuestionReviewSchema.safeParse({
    ...request, questions: Array.from({ length: BULK_REVIEW_LIMIT + 1 }, (_, index) => question(index)),
  }).success, false);
  assert.equal(bulkQuestionReviewSchema.safeParse({ ...request, questions: [question(1), question(1)] }).success, false);
});

test("仅管理员可代审的待审核和退回题目允许勾选", () => {
  assert.equal(canBulkReviewQuestion({ canAdminReview: true, status: "pending_review" }), true);
  assert.equal(canBulkReviewQuestion({ canAdminReview: true, status: "returned" }), true);
  assert.equal(canBulkReviewQuestion({ canAdminReview: false, status: "pending_review" }), false);
  assert.equal(canBulkReviewQuestion({ canAdminReview: false, status: "returned" }), false);
  for (const status of ["approved", "stored", "draft", "archived"]) {
    assert.equal(canBulkReviewQuestion({ canAdminReview: true, status }), false);
  }
});
