import { z } from "zod";
import { parseModelJson } from "./skill-candidate";

const coreSchema = z.object({
  evidenceSupported: z.boolean(), completeTask: z.boolean(), correctScope: z.boolean(), distinctTask: z.boolean(),
  meetsQualityStandard: z.boolean(), explanation: z.string().trim().min(4).max(4000),
  sourceIds: z.array(z.string()).min(1).max(12),
});
export const designRequirementsSchema = z.array(z.object({
  requirement: z.string().trim().min(2), passed: z.boolean(), explanation: z.string().trim().min(2),
})).min(1).max(100);

export function parseDesignReviewCore(content: string) {
  return coreSchema.parse(parseModelJson(content));
}

export function parseDesignRequirements(content: string) {
  const payload = parseModelJson(content) as { requirements?: unknown };
  return designRequirementsSchema.parse(payload?.requirements);
}

export function designCorePassed(core: z.infer<typeof coreSchema>) {
  return core.evidenceSupported && core.completeTask && core.correctScope && core.distinctTask && core.meetsQualityStandard;
}
