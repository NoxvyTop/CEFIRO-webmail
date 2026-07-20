import { z } from "zod";

export const draftInputSchema = z.object({
  subject: z.string().min(1),
});
export type DraftInput = z.infer<typeof draftInputSchema>;

export const draftResultSchema = z.object({
  body: z.string(),
});
export type DraftResult = z.infer<typeof draftResultSchema>;

export const summaryResultSchema = z.object({
  bullets: z.array(z.string()),
});
export type SummaryResult = z.infer<typeof summaryResultSchema>;
