/**
 * Port for the AI features (summarize / draft-with-AI). Adapters live in
 * `infra/ai/` and implement this interface — the domain and router code never
 * talk to a concrete provider SDK directly.
 *
 * Privacy discipline (non-negotiable): implementations must never log email
 * body/subject content (see core/logger.ts usage elsewhere), and must only
 * send the minimum content needed for the call — never full mailbox data.
 */
export type AiClient = {
  /** Summarizes an email body into a short list of bullet points. */
  summarize(body: string): Promise<string[]>;
  /**
   * Summarizes a whole conversation (thread messages, in order, sender +
   * already-cleaned body — no dragged quote trail) into bullet points
   * covering who said what, decisions made, and pending/action items.
   */
  summarizeThread(messages: Array<{ from: string; body: string }>): Promise<string[]>;
  /**
   * Drafts an email body (in Spanish) by expanding the user's typed `intent`
   * into a natural, human message. `subject` is an optional weak hint and
   * `context` is the original message body on a reply (GH #304).
   */
  draftReply(input: { intent: string; subject?: string; context?: string }): Promise<string>;
};
