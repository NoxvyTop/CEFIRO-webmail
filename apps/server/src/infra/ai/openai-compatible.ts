import type { AiClient } from "../../core/ai";
import { DEFAULT_AI_TIMEOUT_MS, withDeadlineFetch } from "../../core/deadline";
import { DomainError } from "../../core/errors";
import { log } from "../../core/logger";
import {
  DRAFT_REPLY_SYSTEM_PROMPT,
  SUMMARIZE_SYSTEM_PROMPT,
  SUMMARY_BULLET_COUNT,
  THREAD_SUMMARY_BULLET_COUNT,
  THREAD_SUMMARY_SYSTEM_PROMPT,
  buildDraftReplyPrompt,
  buildThreadSummaryPrompt,
  parseBullets,
} from "./prompts";

const MAX_TOKENS = 1024;

type ChatRole = "system" | "user";
type ChatMessage = { role: ChatRole; content: string };

// Reasoning-capable models (e.g. Mistral Small 4, mistral-small-2603) return
// `message.content` as a list of typed chunks instead of a plain string when
// reasoning is active: a "thinking" chunk carries the model's reasoning
// trace, a "text" chunk carries the actual answer. See GitHub issue #138.
type ChatContentChunk = { type?: string; text?: unknown };
type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string | ChatContentChunk[] } }>;
};

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
  /** Outbound deadline per completion — see core/deadline.ts (GH #165). */
  timeoutMs?: number;
}): AiClient {
  const fetchFn = withDeadlineFetch(
    input.fetchFn ?? fetch,
    "ai",
    input.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS,
  );
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
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      // Concatenate only "text" chunks, in order; "thinking" chunks (and any
      // other chunk type) are discarded so reasoning traces never leak into
      // summaries or drafts. See GitHub issue #138.
      const text = content
        .filter((chunk) => chunk?.type === "text" && typeof chunk.text === "string")
        .map((chunk) => chunk.text as string)
        .join("");
      if (text.length > 0) {
        return text;
      }
    }
    throw new Error("openai-compatible provider returned a malformed response");
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
        throw toAiError(error, "summarize");
      }
    },

    async summarizeThread(messages: Array<{ from: string; body: string }>): Promise<string[]> {
      try {
        const content = await chatComplete([
          { role: "system", content: THREAD_SUMMARY_SYSTEM_PROMPT },
          { role: "user", content: buildThreadSummaryPrompt(messages) },
        ]);
        return parseBullets(content, THREAD_SUMMARY_BULLET_COUNT);
      } catch (error) {
        throw toAiError(error, "summarizeThread");
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
        throw toAiError(error, "draft");
      }
    },
  };
}
