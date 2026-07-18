import Anthropic from "@anthropic-ai/sdk";
import type { AiClient } from "../../core/ai";
import { DomainError } from "../../core/errors";
import { log } from "../../core/logger";

// Minimal shape of the SDK's `messages` resource we depend on — lets tests
// inject a fake instead of hitting the network, same DI pattern as
// createJmapClient's injectable `fetchFn` (infra/stalwart/jmap.ts).
export type AnthropicMessagesApi = {
  create(params: {
    model: string;
    max_tokens: number;
    system?: string;
    messages: { role: "user"; content: string }[];
  }): Promise<{ content: Array<{ type: string; text?: string }> }>;
};

const MAX_TOKENS = 1024;
const SUMMARY_BULLET_COUNT = 3;

function firstTextBlock(content: Array<{ type: string; text?: string }>): string {
  return content.find((block) => block.type === "text")?.text ?? "";
}

function parseBullets(text: string, limit: number): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/^[\s\-*•\d.]+/, "").trim())
    .filter((line) => line.length > 0)
    .slice(0, limit);
}

export function createAnthropicAiClient(input: {
  apiKey: string;
  model: string;
  client?: AnthropicMessagesApi;
}): AiClient {
  const messagesApi: AnthropicMessagesApi =
    input.client ?? new Anthropic({ apiKey: input.apiKey }).messages;

  return {
    async summarize(body: string): Promise<string[]> {
      try {
        const response = await messagesApi.create({
          model: input.model,
          max_tokens: MAX_TOKENS,
          system:
            `Summarize the email below into exactly ${SUMMARY_BULLET_COUNT} short bullet points, ` +
            "one per line, each starting with '- '. Reply with nothing else.",
          messages: [{ role: "user", content: body }],
        });
        const text = firstTextBlock(response.content);
        return parseBullets(text, SUMMARY_BULLET_COUNT);
      } catch (error) {
        // Never include email content in logs — only the failure itself.
        log("error", "ai summarize failed", { error: error instanceof Error ? error.message : "unknown" });
        throw new DomainError("ai_provider_error", 502, "errors.ai_provider_error");
      }
    },

    async draftReply(subject: string, context?: string): Promise<string> {
      const prompt = context
        ? `Asunto: ${subject}\nContexto adicional: ${context}`
        : `Asunto: ${subject}`;
      try {
        const response = await messagesApi.create({
          model: input.model,
          max_tokens: MAX_TOKENS,
          system:
            "Redacta el cuerpo de un correo de respuesta en español, breve y profesional, " +
            "a partir del asunto (y contexto opcional) provisto por el usuario. " +
            "Responde solo con el cuerpo del correo, sin asunto ni firma.",
          messages: [{ role: "user", content: prompt }],
        });
        return firstTextBlock(response.content).trim();
      } catch (error) {
        log("error", "ai draft failed", { error: error instanceof Error ? error.message : "unknown" });
        throw new DomainError("ai_provider_error", 502, "errors.ai_provider_error");
      }
    },
  };
}
