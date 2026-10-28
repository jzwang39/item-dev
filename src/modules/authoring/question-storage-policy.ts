import { z } from "zod";

export const BULK_STORAGE_LIMIT = 50;
export type StorageCandidate = { id: string; versionId: string; questionNo: string };

export const bulkStorageSchema = z.object({
  action: z.literal("bulk_store"),
  confirmed: z.literal(true),
  opinion: z.string().trim().min(1).max(4000),
  questions: z.array(z.object({
    questionId: z.string().length(26),
    versionId: z.string().length(26),
  })).min(1).max(BULK_STORAGE_LIMIT),
}).refine((input) => new Set(input.questions.map((question) => question.questionId)).size === input.questions.length, {
  message: "批量入库不能包含重复试题。",
});

export function canStoreQuestion(question: { status: string; confirmed: boolean; versionId: string | null }) {
  return question.status === "approved" && question.confirmed && Boolean(question.versionId);
}
