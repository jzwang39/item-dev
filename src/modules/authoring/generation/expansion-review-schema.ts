import { z } from "zod";
import { parseModelJson } from "./skill-candidate";

export const expansionAuditSchema = z.object({ checks: z.array(z.object({
  sourceId: z.string().trim(), quote: z.string().trim().min(40).max(3000),
  trustworthy: z.boolean(), correctScope: z.boolean(), supportsKnowledge: z.boolean(),
  standardAllowsExpansion: z.boolean(), isLegalQuestion: z.boolean(),
  explanation: z.string().trim().min(4).max(2000),
})).max(3) });

export function expansionReviewMalformed(content: string) {
  try { expansionAuditSchema.parse(parseModelJson(content)); return false; }
  catch { return true; }
}
