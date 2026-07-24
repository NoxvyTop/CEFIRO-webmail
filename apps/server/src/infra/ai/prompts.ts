/**
 * Prompt wording shared by every AI provider adapter in `infra/ai/`.
 *
 * Centralizing the system instructions and prompt-building logic here
 * guarantees `summarize`/`draftReply` behave the same way regardless of
 * which provider is selected via `AI_PROVIDER` (Anthropic, an
 * OpenAI-compatible endpoint, ...) — adapters differ only in transport
 * (SDK vs `fetch`) and response shape, never in what is asked of the model.
 */

export const SUMMARY_BULLET_COUNT = 3;

export const SUMMARIZE_SYSTEM_PROMPT =
  `Summarize the email below into exactly ${SUMMARY_BULLET_COUNT} short bullet points, ` +
  "one per line, each starting with '- '. Reply with nothing else.";

export const DRAFT_REPLY_SYSTEM_PROMPT =
  "Redacta el cuerpo de un correo de respuesta en español, breve y profesional, " +
  "a partir del asunto (y contexto opcional) provisto por el usuario. " +
  "Responde solo con el cuerpo del correo, sin asunto ni firma.";

/** Builds the user-turn content for draftReply from the subject and optional context. */
export function buildDraftReplyPrompt(subject: string, context?: string): string {
  return context
    ? `Asunto: ${subject}\nContexto adicional: ${context}`
    : `Asunto: ${subject}`;
}

/** Splits a raw model response into up to `limit` cleaned bullet lines. */
export function parseBullets(text: string, limit: number = SUMMARY_BULLET_COUNT): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/^[\s\-*•\d.]+/, "").trim())
    .filter((line) => line.length > 0)
    .slice(0, limit);
}
