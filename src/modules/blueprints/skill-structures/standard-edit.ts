import { z } from "zod";
import type { StandardScope } from "../skill-standard";

export const structureEditSchema = z.object({
  standardVersionId: z.string().length(26),
  structureVersionId: z.string().length(26),
  scopeKey: z.string().min(1).max(128),
  totalMinutes: z.number().finite().positive(),
  rows: z.array(z.object({
    code: z.string().min(1).max(128),
    name: z.string().min(1).max(500),
    score: z.number().finite().positive().max(100),
    selection: z.enum(["必考", "选考"]),
    minutes: z.number().finite().positive(),
    method: z.string().trim().min(1).max(100),
  })).min(1).max(100),
});
export type StructureEdit = z.infer<typeof structureEditSchema>;

export function applyStructureEdit(scope: StandardScope, input: StructureEdit): StandardScope {
  structureEditSchema.parse(input);
  if (scope.column.key !== input.scopeKey || scope.rows.length !== input.rows.length ||
    scope.rows.some((row, index) => {
      const edited = input.rows[index];
      return edited.code !== row.code || edited.name !== row.name || edited.score !== row.score;
    })) throw new Error("考评范围及权重必须与当前职业标准一致，请刷新后重试。");
  if (Math.abs(input.rows.reduce((sum, row) => sum + row.score, 0) - 100) > 0.001)
    throw new Error("各范围考核权重合计必须为100%。");
  if (Math.abs(input.rows.reduce((sum, row) => sum + row.minutes, 0) - input.totalMinutes) > 0.001)
    throw new Error("各范围考试时间合计必须等于总考试时间。");
  if (scope.assessmentRules?.minimumMinutes && input.totalMinutes < scope.assessmentRules.minimumMinutes)
    throw new Error(`总考试时间不得少于职业标准规定的${scope.assessmentRules.minimumMinutes}分钟。`);
  return { ...scope, totalMinutes: input.totalMinutes, rows: input.rows.map((row) => ({ ...row })) };
}
