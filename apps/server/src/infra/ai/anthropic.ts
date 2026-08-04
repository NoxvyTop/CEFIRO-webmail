import Anthropic from "@anthropic-ai/sdk";
import type { AiClient } from "../../core/ai";
import { DEFAULT_AI_TIMEOUT_MS, withDeadline } from "../../core/deadline";
import { DomainError } from "../../core/errors";
import { log } from "../../core/logger";
import {
  DRAFT_REPLY_SYSTEM_PROMPT,
  SUMMARIZE_SYSTEM_PROMPT,
  SUMMARY_BULLET_COUNT,
  THREAD_SUMMARY_BULLET_COUNT,
  THREAD_SUMMARY_SYSTEM_PROMPT,
  buildDraftReplyPrompt,
  buildSummarizeUserPrompt,
  buildThreadSummaryPrompt,
  parseBullets,
} from "./prompts";

// Minimal shape of the SDK's `messages` resource we depend on — lets tests
// inject a fake instead of hitting the network, same DI pattern as
// createJmapClient's injectable `fetchFn` (infra/jmap/client.ts).
export type AnthropicMessagesApi = {
  create(
    params: {
      model: string;
      max_tokens: number;
      system?: string;
      messages: { role: "user"; content: string }[];
    },
    options?: { signal?: AbortSignal },
  ): Promise<{ content: Array<{ type: string; text?: string }> }>;
};

const MAX_TOKENS = 1024;

function firstTextBlock(content: Array<{ type: string; text?: string }>): string {
  return content.find((block) => block.type === "text")?.text ?? "";
}

/**
 * Flattens every provider failure into one opaque `ai_provider_error` — never
 * include email content in logs, only the failure itself.
 *
 * A DomainError is passed through untouched: that is the outbound deadline
 * (`upstream_timeout`), which exists precisely so an operator can tell a
 * provider that stalled from a provider that answered with garbage (GH #165).
 */
function toAiError(error: unknown, task: string): DomainError {
  if (error instanceof DomainError) return error;
  log("error", `ai ${task} failed`, { error: error instanceof Error ? error.message : "unknown" });
  return new DomainError("ai_provider_error", 502, "errors.ai_provider_error");
}

export function createAnthropicAiClient(input: {
  apiKey: string;
  model: string;
  client?: AnthropicMessagesApi;
  /** Outbound deadline per completion — see core/deadline.ts (GH #165). */
  timeoutMs?: number;
}): AiClient {
  const timeoutMs = input.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS;
  // The SDK's own `timeout` defaults to 10 minutes AND is retried, so on its
  // own it is no operator-visible ceiling at all. Setting it here aborts the
  // socket at the right moment; withDeadline below is what bounds the total
  // wall time the caller waits, retries included.
  const messagesApi: AnthropicMessagesApi =
    input.client ?? new Anthropic({ apiKey: input.apiKey, timeout: timeoutMs }).messages;

  function complete(system: string, content: string): Promise<string> {
    return withDeadline("ai", timeoutMs, async (signal) => {
      const response = await messagesApi.create(
        {
          model: input.model,
          max_tokens: MAX_TOKENS,
          system,
          messages: [{ role: "user", content }],
        },
        { signal },
      );
      return firstTextBlock(response.content);
    });
  }

  return {
    async summarize(body: string): Promise<string[]> {
      try {
        return parseBullets(
          await complete(SUMMARIZE_SYSTEM_PROMPT, buildSummarizeUserPrompt(body)),
          SUMMARY_BULLET_COUNT,
        );
      } catch (error) {
        throw toAiError(error, "summarize");
      }
    },

    async summarizeThread(messages: Array<{ from: string; body: string }>): Promise<string[]> {
      try {
        const text = await complete(
          THREAD_SUMMARY_SYSTEM_PROMPT,
          buildThreadSummaryPrompt(messages),
        );
        return parseBullets(text, THREAD_SUMMARY_BULLET_COUNT);
      } catch (error) {
        throw toAiError(error, "summarizeThread");
      }
    },

    async draftReply(input: { intent: string; subject?: string; context?: string }): Promise<string> {
      const prompt = buildDraftReplyPrompt(input.intent, input.subject, input.context);
      try {
        return (await complete(DRAFT_REPLY_SYSTEM_PROMPT, prompt)).trim();
      } catch (error) {
        throw toAiError(error, "draft");
      }
    },
  };
}
