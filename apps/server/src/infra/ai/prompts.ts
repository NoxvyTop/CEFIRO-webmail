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

// A conversation naturally needs more room than a single email: one bullet
// per participant's contribution plus decisions and pending items can
// easily exceed SUMMARY_BULLET_COUNT.
export const THREAD_SUMMARY_BULLET_COUNT = 6;

export const THREAD_SUMMARY_SYSTEM_PROMPT =
  "A continuación tienes los mensajes de una conversación de correo, en orden, cada uno " +
  "precedido por su remitente. Resume la conversación en hasta " +
  `${THREAD_SUMMARY_BULLET_COUNT} viñetas breves, en español: quién dijo qué, qué se decidió ` +
  "y qué queda pendiente o como próxima acción. Responde solo con las viñetas, una por línea, " +
  "cada una comenzando con '- '.";

const THREAD_MESSAGE_DIVIDER = "---";

/**
 * Assembles ordered thread messages into a single user-turn string for
 * summarizeThread — one `De: <from>` + body block per message, separated by
 * a divider, in the same order the caller provides them (chronological).
 */
export function buildThreadSummaryPrompt(messages: Array<{ from: string; body: string }>): string {
  return messages
    .map((message) => `De: ${message.from}\n${message.body}`)
    .join(`\n${THREAD_MESSAGE_DIVIDER}\n`);
}

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

// Matches a bullet marker and nothing beyond it: either a symbol marker, or a
// number immediately followed by `.`/`)` and whitespace.
//
// The previous expression was a character class — `^[\s\-*•\d.]+` — which does
// not stop at the marker at all: it keeps consuming any run of digits, dots,
// dashes and spaces, straight into the content. "- 3 facturas pendientes"
// arrived as "facturas pendientes", and a summary bullet that opens with a
// figure loses precisely the figure, which is usually the point of the bullet.
//
// A numbered marker requires trailing whitespace so that a decimal is not read
// as one: "1.5 millones" has no marker, it has a quantity.
const BULLET_MARKER = /^\s*(?:[-*•]\s*|\d+[.)]\s+)/;

/** Splits a raw model response into up to `limit` cleaned bullet lines. */
export function parseBullets(text: string, limit: number = SUMMARY_BULLET_COUNT): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(BULLET_MARKER, "").trim())
    .filter((line) => line.length > 0)
    .slice(0, limit);
}
