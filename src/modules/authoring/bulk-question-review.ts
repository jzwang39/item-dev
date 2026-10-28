import { z } from "zod";

export const BULK_REVIEW_LIMIT = 50;

export const bulkQuestionReviewSchema = z.object({
  action: z.literal("bulk_approve"),
  confirmed: z.literal(true),
  opinion: z.string().trim().min(1).max(4000),
  questions: z.array(z.object({
    questionId: z.string().length(26),
    versionId: z.string().length(26),
  })).min(1).max(BULK_REVIEW_LIMIT),
}).refine((input) => new Set(input.questions.map((question) => question.questionId)).size === input.questions.length, {
  message: "批量审核不能包含重复试题。",
});

export function canBulkReviewQuestion(task: { canAdminReview: boolean; status: string }) {
  return task.canAdminReview && ["pending_review", "returned"].includes(task.status);
}

export const bulkQuestionConfirmSchema = z.object({
  action: z.literal("bulk_confirm"),
  confirmed: z.literal(true),
  opinion: z.string().trim().min(1).max(4000),
  questions: z.array(z.object({
    questionId: z.string().length(26),
    versionId: z.string().length(26),
  })).min(1).max(BULK_REVIEW_LIMIT),
}).refine((input) => new Set(input.questions.map((question) => question.questionId)).size === input.questions.length, {
  message: "批量确认不能包含重复试题。",
});

export function canBulkConfirmQuestion(task: { status: string; confirmedAt: string | null }) {
  return task.status === "approved" && !task.confirmedAt;
}
