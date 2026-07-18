import { describe, expect, it, vi } from "vitest";
import { DomainError } from "../../core/errors";
import { createAnthropicAiClient, type AnthropicMessagesApi } from "./anthropic";

function fakeMessagesApi(
  responder: (params: { model: string; max_tokens: number; system?: string; messages: { role: string; content: string }[] }) => {
    content: Array<{ type: string; text?: string }>;
  },
): AnthropicMessagesApi & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async create(params) {
      calls.push(params);
      return responder(params as never);
    },
  };
}

describe("createAnthropicAiClient", () => {
  describe("summarize", () => {
    it("sends only the message body to the model and returns 3 parsed bullet points", async () => {
      const api = fakeMessagesApi(() => ({
        content: [{ type: "text", text: "- First point\n- Second point\n- Third point" }],
      }));
      const client = createAnthropicAiClient({ apiKey: "sk-test", model: "claude-opus-4-8", client: api });

      const result = await client.summarize("Hello, please review the attached invoice.");

      expect(result).toEqual(["First point", "Second point", "Third point"]);
      expect(api.calls).toHaveLength(1);
      const call = api.calls[0] as { model: string; max_tokens: number; messages: { content: string }[] };
      expect(call.model).toBe("claude-opus-4-8");
      expect(call.max_tokens).toBeLessThanOrEqual(1024);
      // Only the body is sent — no extra mailbox data smuggled into the prompt.
      expect(call.messages[0]!.content).toContain("Hello, please review the attached invoice.");
    });

    it("caps the result at 3 bullet points even if the model returns more", async () => {
      const api = fakeMessagesApi(() => ({
        content: [{ type: "text", text: "- One\n- Two\n- Three\n- Four" }],
      }));
      const client = createAnthropicAiClient({ apiKey: "sk-test", model: "claude-opus-4-8", client: api });

      const result = await client.summarize("body");

      expect(result).toHaveLength(3);
    });

    it("wraps a provider failure in a DomainError without leaking body content", async () => {
      const api: AnthropicMessagesApi = {
        async create() {
          throw new Error("network exploded");
        },
      };
      const client = createAnthropicAiClient({ apiKey: "sk-test", model: "claude-opus-4-8", client: api });

      const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(client.summarize("super secret body content")).rejects.toBeInstanceOf(DomainError);
      for (const call of logSpy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain("super secret body content");
      }
      logSpy.mockRestore();
    });
  });

  describe("draftReply", () => {
    it("asks the model for a Spanish draft from the subject and optional context", async () => {
      const api = fakeMessagesApi(() => ({
        content: [{ type: "text", text: "Estimado equipo, adjunto el borrador solicitado." }],
      }));
      const client = createAnthropicAiClient({ apiKey: "sk-test", model: "claude-opus-4-8", client: api });

      const draft = await client.draftReply("Reunión de seguimiento", "Confirmar horario de mañana");

      expect(draft).toBe("Estimado equipo, adjunto el borrador solicitado.");
      const call = api.calls[0] as { system?: string; messages: { content: string }[] };
      expect(call.system ?? call.messages[0]!.content).toMatch(/español/i);
      expect(call.messages[0]!.content).toContain("Reunión de seguimiento");
      expect(call.messages[0]!.content).toContain("Confirmar horario de mañana");
    });

    it("works without an optional context", async () => {
      const api = fakeMessagesApi(() => ({ content: [{ type: "text", text: "Borrador." }] }));
      const client = createAnthropicAiClient({ apiKey: "sk-test", model: "claude-opus-4-8", client: api });

      const draft = await client.draftReply("Solo asunto");

      expect(draft).toBe("Borrador.");
    });
  });
});
