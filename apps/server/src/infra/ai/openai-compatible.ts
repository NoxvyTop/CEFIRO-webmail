import type { AiClient } from "../../core/ai";
import { DomainError } from "../../core/errors";
import { log } from "../../core/logger";
import {
  DRAFT_REPLY_SYSTEM_PROMPT,
  SUMMARIZE_SYSTEM_PROMPT,
  SUMMARY_BULLET_COUNT,
  buildDraftReplyPrompt,
  parseBullets,
} from "./prompts";

const MAX_TOKENS = 1024;

type ChatRole = "system" | "user";
type ChatMessage = { role: ChatRole; content: string };
type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string } }>;
};

/**
 * Adapter for any provider that speaks the OpenAI `/v1/chat/completions`
 * shape: MiniMax, Kimi/Moonshot, or a self-hosted Ollama/vLLM/LiteLLM
 * server — one adapter, configurable via `baseUrl` (see core/config.ts
 * `aiBaseUrl` / `AI_BASE_URL`).
 *
 * `baseUrl` is the API root INCLUDING any provider-required `/v1` segment
 * (OpenAI-SDK convention, e.g. `https://api.moonshot.cn/v1`); this adapter
 * appends `/chat/completions` to it.
 */
export function createOpenAiCompatibleClient(input: {
  apiKey: string;
  model: string;
  baseUrl: string;
  fetchFn?: typeof fetch;
}): AiClient {
  const fetchFn = input.fetchFn ?? fetch;
  const endpoint = `${input.baseUrl.replace(/\/$/, "")}/chat/completions`;

  // Note: both tasks currently reuse the single configured `model`. Per-task
  // model selection (e.g. a cheaper model for summarize vs. draftReply) is a
  // future enhancement — see GitHub issue #115 ("consider").
  async function chatComplete(messages: ChatMessage[]): Promise<string> {
    const res = await fetchFn(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: input.model,
        max_tokens: MAX_TOKENS,
        messages,
      }),
    });
    if (!res.ok) {
      throw new Error(`openai-compatible provider responded with http ${res.status}`);
    }
    const data = (await res.json()) as ChatCompletionResponse;
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error("openai-compatible provider returned a malformed response");
    }
    return content;
  }

  return {
    async summarize(body: string): Promise<string[]> {
      try {
        const content = await chatComplete([
          { role: "system", content: SUMMARIZE_SYSTEM_PROMPT },
          { role: "user", content: body },
        ]);
        return parseBullets(content, SUMMARY_BULLET_COUNT);
      } catch (error) {
        // Never include email content in logs — only the failure itself.
        log("error", "ai summarize failed", { error: error instanceof Error ? error.message : "unknown" });
        throw new DomainError("ai_provider_error", 502, "errors.ai_provider_error");
      }
    },

    async draftReply(subject: string, context?: string): Promise<string> {
      const prompt = buildDraftReplyPrompt(subject, context);
      try {
        const content = await chatComplete([
          { role: "system", content: DRAFT_REPLY_SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ]);
        return content.trim();
      } catch (error) {
        log("error", "ai draft failed", { error: error instanceof Error ? error.message : "unknown" });
        throw new DomainError("ai_provider_error", 502, "errors.ai_provider_error");
      }
    },
  };
}
