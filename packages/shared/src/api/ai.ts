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

// GH #292: whether the AI features are usable on this server, so the front can
// hide the "draft with AI" CTA (and the AI hint in the body placeholder) when
// they are off — the default. `enabled` mirrors the server's own gate: the AI
// client is only built when AI_ENABLED and an API key are both present.
export const aiStatusSchema = z.object({
  enabled: z.boolean(),
});
export type AiStatus = z.infer<typeof aiStatusSchema>;
