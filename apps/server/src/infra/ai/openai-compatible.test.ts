import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AI_TIMEOUT_MS } from "../../core/deadline";
import { DomainError } from "../../core/errors";
import { createOpenAiCompatibleClient } from "./openai-compatible";

function fetchReturning(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

function calls(fetchFn: typeof fetch) {
  return (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls;
}

describe("createOpenAiCompatibleClient", () => {
  describe("summarize", () => {
    it("POSTs to {baseUrl}/chat/completions with model/messages/auth header and parses 3 bullets", async () => {
      const fetchFn = fetchReturning({
        choices: [{ message: { content: "- First point\n- Second point\n- Third point" } }],
      });
      const client = createOpenAiCompatibleClient({
        apiKey: "sk-test",
        model: "moonshot-v1-8k",
        baseUrl: "https://api.moonshot.cn/v1",
        fetchFn,
      });

      const result = await client.summarize("Hello, please review the attached invoice.");

      expect(result).toEqual(["First point", "Second point", "Third point"]);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [url, init] = calls(fetchFn)[0]!;
      expect(String(url)).toBe("https://api.moonshot.cn/v1/chat/completions");
      expect(init.method).toBe("POST");
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer sk-test");
      expect(headers["Content-Type"]).toBe("application/json");
      const requestBody = JSON.parse(init.body as string);
      expect(requestBody.model).toBe("moonshot-v1-8k");
      expect(requestBody.messages[0].role).toBe("system");
      expect(requestBody.messages[1].role).toBe("user");
      // The body is fenced in the untrusted delimiter (GH #298) and nothing
      // else is smuggled in — no extra mailbox data reaches the prompt.
      expect(requestBody.messages[1].content).toContain("Hello, please review the attached invoice.");
      expect(requestBody.messages[1].content).toMatch(/<<<EMAIL:[0-9a-f]+>>>/);
      expect(requestBody.messages[1].content).toMatch(/<<<END EMAIL:[0-9a-f]+>>>/);
    });

    it("caps the result at 3 bullet points even if the model returns more", async () => {
      const fetchFn = fetchReturning({
        choices: [{ message: { content: "- One\n- Two\n- Three\n- Four" } }],
      });
      const client = createOpenAiCompatibleClient({
        apiKey: "sk-test",
        model: "moonshot-v1-8k",
        baseUrl: "https://api.moonshot.cn/v1",
        fetchFn,
      });

      const result = await client.summarize("body");

      expect(result).toHaveLength(3);
    });

    it("strips a trailing slash from baseUrl before appending /chat/completions", async () => {
      const fetchFn = fetchReturning({ choices: [{ message: { content: "- A\n- B\n- C" } }] });
      const client = createOpenAiCompatibleClient({
        apiKey: "sk-test",
        model: "m",
        baseUrl: "https://api.moonshot.cn/v1/",
        fetchFn,
      });

      await client.summarize("body");

      const [url] = calls(fetchFn)[0]!;
      expect(String(url)).toBe("https://api.moonshot.cn/v1/chat/completions");
    });

    it("wraps a non-OK HTTP response in a DomainError without leaking body content", async () => {
      const fetchFn = fetchReturning({ error: "boom" }, 500);
      const client = createOpenAiCompatibleClient({
        apiKey: "sk-test",
        model: "m",
        baseUrl: "https://api.moonshot.cn/v1",
        fetchFn,
      });

      const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(client.summarize("super secret body content")).rejects.toBeInstanceOf(DomainError);
      for (const call of logSpy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain("super secret body content");
      }
      logSpy.mockRestore();
    });

    it("wraps a malformed response (missing choices) in a DomainError without leaking body content", async () => {
      const fetchFn = fetchReturning({});
      const client = createOpenAiCompatibleClient({
        apiKey: "sk-test",
        model: "m",
        baseUrl: "https://api.moonshot.cn/v1",
        fetchFn,
      });

      const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(client.summarize("super secret body content")).rejects.toBeInstanceOf(DomainError);
      for (const call of logSpy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain("super secret body content");
      }
      logSpy.mockRestore();
    });

    // Reasoning models (e.g. Mistral Small 4, mistral-small-2603) return
    // `message.content` as an array of typed chunks instead of a plain
    // string when reasoning is active. See GitHub issue #138.
    it("parses content returned as an array of typed chunks, discarding thinking chunks", async () => {
      const fetchFn = fetchReturning({
        choices: [
          {
            message: {
              content: [
                { type: "thinking", text: "internal reasoning trace, never surfaced" },
                { type: "text", text: "- First point\n- Second point\n- Third point" },
              ],
            },
          },
        ],
      });
      const client = createOpenAiCompatibleClient({
        apiKey: "sk-test",
        model: "m",
        baseUrl: "https://api.moonshot.cn/v1",
        fetchFn,
      });

      const result = await client.summarize("body");

      expect(result).toEqual(["First point", "Second point", "Third point"]);
    });

    it("concatenates multiple text chunks in order, ignoring interleaved thinking chunks", async () => {
      const fetchFn = fetchReturning({
        choices: [
          {
            message: {
              content: [
                { type: "text", text: "- First point\n" },
                { type: "thinking", text: "reasoning noise that must not leak" },
                { type: "text", text: "- Second point\n- Third point" },
              ],
            },
          },
        ],
      });
      const client = createOpenAiCompatibleClient({
        apiKey: "sk-test",
        model: "m",
        baseUrl: "https://api.moonshot.cn/v1",
        fetchFn,
      });

      const result = await client.summarize("body");

      expect(result).toEqual(["First point", "Second point", "Third point"]);
    });

    it("wraps a content array with zero usable text chunks in a DomainError without leaking thinking content", async () => {
      const fetchFn = fetchReturning({
        choices: [{ message: { content: [{ type: "thinking", text: "secret internal reasoning" }] } }],
      });
      const client = createOpenAiCompatibleClient({
        apiKey: "sk-test",
        model: "m",
        baseUrl: "https://api.moonshot.cn/v1",
        fetchFn,
      });

      const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(client.summarize("body")).rejects.toBeInstanceOf(DomainError);
      for (const call of logSpy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain("secret internal reasoning");
      }
      logSpy.mockRestore();
    });

    it("wraps an empty content array in a DomainError", async () => {
      const fetchFn = fetchReturning({ choices: [{ message: { content: [] } }] });
      const client = createOpenAiCompatibleClient({
        apiKey: "sk-test",
        model: "m",
        baseUrl: "https://api.moonshot.cn/v1",
        fetchFn,
      });

      const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(client.summarize("body")).rejects.toBeInstanceOf(DomainError);
      logSpy.mockRestore();
    });

    it("ignores a text chunk with no usable string payload", async () => {
      const fetchFn = fetchReturning({
        choices: [
          {
            message: {
              content: [{ type: "text" }, { type: "text", text: "- First point\n- Second point\n- Third point" }],
            },
          },
        ],
      });
      const client = createOpenAiCompatibleClient({
        apiKey: "sk-test",
        model: "m",
        baseUrl: "https://api.moonshot.cn/v1",
        fetchFn,
      });

      const result = await client.summarize("body");

      expect(result).toEqual(["First point", "Second point", "Third point"]);
    });

    it("wraps a non-string, non-array content value (e.g. a number) in a DomainError", async () => {
      const fetchFn = fetchReturning({ choices: [{ message: { content: 42 } }] });
      const client = createOpenAiCompatibleClient({
        apiKey: "sk-test",
        model: "m",
        baseUrl: "https://api.moonshot.cn/v1",
        fetchFn,
      });

      const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(client.summarize("body")).rejects.toBeInstanceOf(DomainError);
      logSpy.mockRestore();
    });
  });

  describe("summarizeThread", () => {
    it("POSTs the assembled conversation as a single user message and parses bullets", async () => {
      const fetchFn = fetchReturning({
        choices: [{ message: { content: "- Ana propuso empezar el lunes\n- Beto confirmó" } }],
      });
      const client = createOpenAiCompatibleClient({
        apiKey: "sk-test",
        model: "moonshot-v1-8k",
        baseUrl: "https://api.moonshot.cn/v1",
        fetchFn,
      });

      const result = await client.summarizeThread([
        { from: "Ana <ana@x.com>", body: "Propongo arrancar el lunes." },
        { from: "Beto <beto@x.com>", body: "Confirmado." },
      ]);

      expect(result).toEqual(["Ana propuso empezar el lunes", "Beto confirmó"]);
      const [, init] = calls(fetchFn)[0]!;
      const requestBody = JSON.parse(init.body as string);
      expect(requestBody.messages[0].role).toBe("system");
      expect(requestBody.messages[1].role).toBe("user");
      const content = requestBody.messages[1].content as string;
      expect(content.indexOf("Ana <ana@x.com>")).toBeLessThan(content.indexOf("Beto <beto@x.com>"));
      expect(content).toContain("Propongo arrancar el lunes.");
      expect(content).toContain("Confirmado.");
    });

    it("wraps a non-OK HTTP response in a DomainError without leaking message content", async () => {
      const fetchFn = fetchReturning({ error: "boom" }, 500);
      const client = createOpenAiCompatibleClient({
        apiKey: "sk-test",
        model: "m",
        baseUrl: "https://api.moonshot.cn/v1",
        fetchFn,
      });

      const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(
        client.summarizeThread([{ from: "Ana <ana@x.com>", body: "super secret body content" }]),
      ).rejects.toBeInstanceOf(DomainError);
      for (const call of logSpy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain("super secret body content");
      }
      logSpy.mockRestore();
    });

    it("parses content returned as an array of typed chunks, discarding thinking chunks", async () => {
      const fetchFn = fetchReturning({
        choices: [
          {
            message: {
              content: [
                { type: "thinking", text: "internal reasoning trace, never surfaced" },
                { type: "text", text: "- Ana propuso empezar el lunes\n- Beto confirmó" },
              ],
            },
          },
        ],
      });
      const client = createOpenAiCompatibleClient({
        apiKey: "sk-test",
        model: "m",
        baseUrl: "https://api.moonshot.cn/v1",
        fetchFn,
      });

      const result = await client.summarizeThread([{ from: "Ana <ana@x.com>", body: "Propongo." }]);

      expect(result).toEqual(["Ana propuso empezar el lunes", "Beto confirmó"]);
    });
  });

  describe("draftReply", () => {
    // GH #304: the draft is built from the user's intent; the subject and
    // context are optional. All three reach the prompt when present.
    it("asks the model for a Spanish draft from the intent, subject hint and context", async () => {
      const fetchFn = fetchReturning({
        choices: [{ message: { content: "Estimado equipo, adjunto el borrador solicitado." } }],
      });
      const client = createOpenAiCompatibleClient({
        apiKey: "sk-test",
        model: "m",
        baseUrl: "https://api.moonshot.cn/v1",
        fetchFn,
      });

      const draft = await client.draftReply({
        intent: "confirmar el horario de mañana",
        subject: "Reunión de seguimiento",
        context: "¿A qué hora nos vemos?",
      });

      expect(draft).toBe("Estimado equipo, adjunto el borrador solicitado.");
      const [, init] = calls(fetchFn)[0]!;
      const requestBody = JSON.parse(init.body as string);
      expect(requestBody.messages[0].content).toMatch(/español/i);
      expect(requestBody.messages[1].content).toContain("confirmar el horario de mañana");
      expect(requestBody.messages[1].content).toContain("Reunión de seguimiento");
      expect(requestBody.messages[1].content).toContain("¿A qué hora nos vemos?");
    });

    it("works from the intent alone, without a subject or context", async () => {
      const fetchFn = fetchReturning({ choices: [{ message: { content: "Borrador." } }] });
      const client = createOpenAiCompatibleClient({
        apiKey: "sk-test",
        model: "m",
        baseUrl: "https://api.moonshot.cn/v1",
        fetchFn,
      });

      const draft = await client.draftReply({ intent: "aviso que no voy" });

      expect(draft).toBe("Borrador.");
    });

    it("wraps a provider failure in a DomainError without leaking intent content", async () => {
      const fetchFn = vi.fn(async () => {
        throw new Error("network exploded");
      }) as unknown as typeof fetch;
      const client = createOpenAiCompatibleClient({
        apiKey: "sk-test",
        model: "m",
        baseUrl: "https://api.moonshot.cn/v1",
        fetchFn,
      });

      const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(client.draftReply({ intent: "super secret intent" })).rejects.toBeInstanceOf(DomainError);
      for (const call of logSpy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain("super secret intent");
      }
      logSpy.mockRestore();
    });

    it("concatenates multiple text chunks in order and discards thinking content", async () => {
      const fetchFn = fetchReturning({
        choices: [
          {
            message: {
              content: [
                { type: "text", text: "Estimado equipo, " },
                { type: "thinking", text: "internal reasoning that must never reach the draft" },
                { type: "text", text: "adjunto el borrador solicitado." },
              ],
            },
          },
        ],
      });
      const client = createOpenAiCompatibleClient({
        apiKey: "sk-test",
        model: "m",
        baseUrl: "https://api.moonshot.cn/v1",
        fetchFn,
      });

      const draft = await client.draftReply({ intent: "confirmar el horario de mañana" });

      expect(draft).toBe("Estimado equipo, adjunto el borrador solicitado.");
      expect(draft).not.toContain("internal reasoning");
    });

    it("wraps a content array with zero usable text chunks in a DomainError without leaking thinking content", async () => {
      const fetchFn = fetchReturning({
        choices: [{ message: { content: [{ type: "thinking", text: "secret internal reasoning" }] } }],
      });
      const client = createOpenAiCompatibleClient({
        apiKey: "sk-test",
        model: "m",
        baseUrl: "https://api.moonshot.cn/v1",
        fetchFn,
      });

      const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(client.draftReply({ intent: "confirmar el horario de mañana" })).rejects.toBeInstanceOf(DomainError);
      for (const call of logSpy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain("secret internal reasoning");
      }
      logSpy.mockRestore();
    });

    it("wraps a null content value in a DomainError", async () => {
      const fetchFn = fetchReturning({ choices: [{ message: { content: null } }] });
      const client = createOpenAiCompatibleClient({
        apiKey: "sk-test",
        model: "m",
        baseUrl: "https://api.moonshot.cn/v1",
        fetchFn,
      });

      const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(client.draftReply({ intent: "confirmar el horario de mañana" })).rejects.toBeInstanceOf(DomainError);
      logSpy.mockRestore();
    });
  });

  describe("outbound deadline (GH #165)", () => {
    /** The provider accepts the connection and then never answers. */
    function silentFetch(): typeof fetch {
      return vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    }

    function clientWith(fetchFn: typeof fetch, timeoutMs?: number) {
      return createOpenAiCompatibleClient({
        apiKey: "sk-test",
        model: "m",
        baseUrl: "https://api.moonshot.cn/v1",
        fetchFn,
        timeoutMs,
      });
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it("fails summarize with upstream_timeout, not the generic ai_provider_error", async () => {
      vi.useFakeTimers();
      const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const client = clientWith(silentFetch());

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
      const client = clientWith(silentFetch());

      const pending = client.summarizeThread([{ from: "Ana <ana@x.com>", body: "hola" }]);
      const assertion = expect(pending).rejects.toMatchObject({ code: "upstream_timeout" });
      await vi.advanceTimersByTimeAsync(DEFAULT_AI_TIMEOUT_MS);
      await assertion;
      logSpy.mockRestore();
    });

    it("fails draftReply with upstream_timeout when the provider never answers", async () => {
      vi.useFakeTimers();
      const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const client = clientWith(silentFetch());

      const pending = client.draftReply({ intent: "aviso que no voy" });
      const assertion = expect(pending).rejects.toMatchObject({ code: "upstream_timeout" });
      await vi.advanceTimersByTimeAsync(DEFAULT_AI_TIMEOUT_MS);
      await assertion;
      logSpy.mockRestore();
    });

    it("still reports ai_provider_error when the provider answers with garbage", async () => {
      // The timeout must be distinguishable from a bad answer, not replace it.
      const fetchFn = fetchReturning({ choices: [{ message: { content: null } }] });
      const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await expect(clientWith(fetchFn).summarize("body")).rejects.toMatchObject({
        code: "ai_provider_error",
        httpStatus: 502,
      });
      logSpy.mockRestore();
    });

    it("waits longer than the Stalwart deadline before giving up, by default", async () => {
      vi.useFakeTimers();
      const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const client = clientWith(silentFetch());

      const pending = client.summarize("body");
      const settled = vi.fn();
      pending.then(settled, settled);
      // A generation that takes half a minute is normal, not broken.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(settled).not.toHaveBeenCalled();

      const assertion = expect(pending).rejects.toMatchObject({ code: "upstream_timeout" });
      await vi.advanceTimersByTimeAsync(DEFAULT_AI_TIMEOUT_MS - 30_000);
      await assertion;
      logSpy.mockRestore();
    });

    it("honours a configured timeoutMs instead of the default", async () => {
      vi.useFakeTimers();
      const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const client = clientWith(silentFetch(), 5_000);

      const pending = client.summarize("body");
      const assertion = expect(pending).rejects.toMatchObject({ code: "upstream_timeout" });
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
      logSpy.mockRestore();
    });
  });
});
