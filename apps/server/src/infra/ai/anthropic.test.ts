import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AI_TIMEOUT_MS } from "../../core/deadline";
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
      // The body is fenced in the untrusted delimiter (GH #298); nothing else
      // is smuggled into the prompt.
      expect(call.messages[0]!.content).toContain("Hello, please review the attached invoice.");
      expect(call.messages[0]!.content).toMatch(/<<<EMAIL:[0-9a-f]+>>>/);
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

  describe("summarizeThread", () => {
    it("sends all thread messages as one user turn, in order, and returns parsed bullets", async () => {
      const api = fakeMessagesApi(() => ({
        content: [
          {
            type: "text",
            text: "- Ana propuso empezar el lunes\n- Beto confirmó\n- Pendiente: enviar el cronograma",
          },
        ],
      }));
      const client = createAnthropicAiClient({ apiKey: "sk-test", model: "claude-opus-4-8", client: api });

      const result = await client.summarizeThread([
        { from: "Ana <ana@x.com>", body: "Propongo arrancar el lunes." },
        { from: "Beto <beto@x.com>", body: "Confirmado." },
      ]);

      expect(result).toEqual([
        "Ana propuso empezar el lunes",
        "Beto confirmó",
        "Pendiente: enviar el cronograma",
      ]);
      expect(api.calls).toHaveLength(1);
      const call = api.calls[0] as { messages: { content: string }[] };
      // Both messages, in order, land in the single user turn.
      const content = call.messages[0]!.content;
      expect(content.indexOf("Ana <ana@x.com>")).toBeLessThan(content.indexOf("Beto <beto@x.com>"));
      expect(content).toContain("Propongo arrancar el lunes.");
      expect(content).toContain("Confirmado.");
    });

    it("wraps a provider failure in a DomainError without leaking message content", async () => {
      const api: AnthropicMessagesApi = {
        async create() {
          throw new Error("network exploded");
        },
      };
      const client = createAnthropicAiClient({ apiKey: "sk-test", model: "claude-opus-4-8", client: api });

      const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(
        client.summarizeThread([{ from: "Ana <ana@x.com>", body: "super secret body content" }]),
      ).rejects.toBeInstanceOf(DomainError);
      for (const call of logSpy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain("super secret body content");
      }
      logSpy.mockRestore();
    });
  });

  describe("draftReply", () => {
    // GH #304: the draft is built from the user's intent; the subject and
    // context are optional. All three reach the prompt when present.
    it("asks the model for a Spanish draft from the intent, subject hint and context", async () => {
      const api = fakeMessagesApi(() => ({
        content: [{ type: "text", text: "Estimado equipo, adjunto el borrador solicitado." }],
      }));
      const client = createAnthropicAiClient({ apiKey: "sk-test", model: "claude-opus-4-8", client: api });

      const draft = await client.draftReply({
        intent: "confirmar el horario de mañana",
        subject: "Reunión de seguimiento",
        context: "¿A qué hora nos vemos?",
      });

      expect(draft).toBe("Estimado equipo, adjunto el borrador solicitado.");
      const call = api.calls[0] as { system?: string; messages: { content: string }[] };
      expect(call.system ?? call.messages[0]!.content).toMatch(/español/i);
      expect(call.messages[0]!.content).toContain("confirmar el horario de mañana");
      expect(call.messages[0]!.content).toContain("Reunión de seguimiento");
      expect(call.messages[0]!.content).toContain("¿A qué hora nos vemos?");
    });

    it("works from the intent alone, without a subject or context", async () => {
      const api = fakeMessagesApi(() => ({ content: [{ type: "text", text: "Borrador." }] }));
      const client = createAnthropicAiClient({ apiKey: "sk-test", model: "claude-opus-4-8", client: api });

      const draft = await client.draftReply({ intent: "aviso que no voy" });

      expect(draft).toBe("Borrador.");
    });
  });

  describe("outbound deadline (GH #165)", () => {
    /** Anthropic accepts the request and then never answers. */
    function silentMessagesApi(): AnthropicMessagesApi & { signals: (AbortSignal | undefined)[] } {
      const signals: (AbortSignal | undefined)[] = [];
      return {
        signals,
        create(_params, options) {
          signals.push(options?.signal);
          return new Promise(() => {});
        },
      };
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it("fails summarize with upstream_timeout, not the generic ai_provider_error", async () => {
      vi.useFakeTimers();
      const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const client = createAnthropicAiClient({
        apiKey: "sk-test",
        model: "claude-opus-4-8",
        client: silentMessagesApi(),
      });

      const pending = client.summarize("body");
      const assertion = expect(pending).rejects.toMatchObject({
        code: "upstream_timeout",
        httpStatus: 504,
      });
      await vi.advanceTimersByTimeAsync(DEFAULT_AI_TIMEOUT_MS);
      await assertion;
      logSpy.mockRestore();
    });

    it("fails summarizeThread with upstream_timeout when the provider never answers", async () => {
      vi.useFakeTimers();
      const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const client = createAnthropicAiClient({
        apiKey: "sk-test",
        model: "claude-opus-4-8",
        client: silentMessagesApi(),
      });

      const pending = client.summarizeThread([{ from: "Ana <ana@x.com>", body: "hola" }]);
      const assertion = expect(pending).rejects.toMatchObject({ code: "upstream_timeout" });
      await vi.advanceTimersByTimeAsync(DEFAULT_AI_TIMEOUT_MS);
      await assertion;
      logSpy.mockRestore();
    });

    it("fails draftReply with upstream_timeout when the provider never answers", async () => {
      vi.useFakeTimers();
      const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const client = createAnthropicAiClient({
        apiKey: "sk-test",
        model: "claude-opus-4-8",
        client: silentMessagesApi(),
      });

      const pending = client.draftReply({ intent: "aviso que no voy" });
      const assertion = expect(pending).rejects.toMatchObject({ code: "upstream_timeout" });
      await vi.advanceTimersByTimeAsync(DEFAULT_AI_TIMEOUT_MS);
      await assertion;
      logSpy.mockRestore();
    });

    it("cancels the in-flight SDK request instead of only abandoning it", async () => {
      vi.useFakeTimers();
      const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const api = silentMessagesApi();
      const client = createAnthropicAiClient({
        apiKey: "sk-test",
        model: "claude-opus-4-8",
        client: api,
      });

      const pending = client.summarize("body");
      const assertion = expect(pending).rejects.toBeInstanceOf(DomainError);
      await vi.advanceTimersByTimeAsync(DEFAULT_AI_TIMEOUT_MS);
      await assertion;

      expect(api.signals[0]?.aborted).toBe(true);
      logSpy.mockRestore();
    });

    it("still reports ai_provider_error when the provider fails for any other reason", async () => {
      const api: AnthropicMessagesApi = {
        async create() {
          throw new Error("network exploded");
        },
      };
      const client = createAnthropicAiClient({ apiKey: "sk-test", model: "claude-opus-4-8", client: api });

      const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(client.summarize("body")).rejects.toMatchObject({
        code: "ai_provider_error",
        httpStatus: 502,
      });
      logSpy.mockRestore();
    });

    it("honours a configured timeoutMs instead of the default", async () => {
      vi.useFakeTimers();
      const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const client = createAnthropicAiClient({
        apiKey: "sk-test",
        model: "claude-opus-4-8",
        client: silentMessagesApi(),
        timeoutMs: 5_000,
      });

      const pending = client.summarize("body");
      const settled = vi.fn();
      pending.then(settled, settled);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).not.toHaveBeenCalled();

      const assertion = expect(pending).rejects.toMatchObject({ code: "upstream_timeout" });
      await vi.advanceTimersByTimeAsync(1);
      await assertion;
      logSpy.mockRestore();
    });
  });
});
