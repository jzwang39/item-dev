import { z } from "zod";

export const occupationInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  code: z.string().trim().min(1).max(64),
  directions: z.array(z.object({
    id: z.string().length(26).optional(),
    name: z.string().trim().min(1).max(200),
  })).max(1000).optional(),
});
