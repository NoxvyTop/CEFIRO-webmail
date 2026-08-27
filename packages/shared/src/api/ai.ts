import { z } from "zod";

// GH #304: the AI draft is driven by the INTENT the user types in the body
// ("no voy el 20 de agosto"), which the model expands into a natural email —
// the subject is only a weak hint now, and it used to drive the whole draft.
// `intent` is the required primary instruction; the subject is optional and the
// original message body (on a reply) rides along as optional `context`. All are
// length-capped to bound provider cost/context (the composer caps client-side
// too).
export const DRAFT_INTENT_MAX_CHARS = 4000;
export const DRAFT_SUBJECT_MAX_CHARS = 500;
// GH #299: the original message body when drafting a REPLY, so the model
// grounds the draft in what it is actually replying to. Optional — a brand-new
// compose has no original message.
export const DRAFT_CONTEXT_MAX_CHARS = 4000;

export const draftInputSchema = z.object({
  intent: z.string().min(1).max(DRAFT_INTENT_MAX_CHARS),
  subject: z.string().max(DRAFT_SUBJECT_MAX_CHARS).optional(),
  context: z.string().max(DRAFT_CONTEXT_MAX_CHARS).optional(),
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
