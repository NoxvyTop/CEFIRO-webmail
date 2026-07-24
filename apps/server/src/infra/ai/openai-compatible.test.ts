import { describe, expect, it, vi } from "vitest";
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
      // Only the body is sent — no extra mailbox data smuggled into the prompt.
      expect(requestBody.messages[1].content).toBe("Hello, please review the attached invoice.");
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
  });

  describe("draftReply", () => {
    it("asks the model for a Spanish draft from the subject and optional context", async () => {
      const fetchFn = fetchReturning({
        choices: [{ message: { content: "Estimado equipo, adjunto el borrador solicitado." } }],
      });
      const client = createOpenAiCompatibleClient({
        apiKey: "sk-test",
        model: "m",
        baseUrl: "https://api.moonshot.cn/v1",
        fetchFn,
      });

      const draft = await client.draftReply("Reunión de seguimiento", "Confirmar horario de mañana");

      expect(draft).toBe("Estimado equipo, adjunto el borrador solicitado.");
      const [, init] = calls(fetchFn)[0]!;
      const requestBody = JSON.parse(init.body as string);
      expect(requestBody.messages[0].content).toMatch(/español/i);
      expect(requestBody.messages[1].content).toContain("Reunión de seguimiento");
      expect(requestBody.messages[1].content).toContain("Confirmar horario de mañana");
    });

    it("works without an optional context", async () => {
      const fetchFn = fetchReturning({ choices: [{ message: { content: "Borrador." } }] });
      const client = createOpenAiCompatibleClient({
        apiKey: "sk-test",
        model: "m",
        baseUrl: "https://api.moonshot.cn/v1",
        fetchFn,
      });

      const draft = await client.draftReply("Solo asunto");

      expect(draft).toBe("Borrador.");
    });

    it("wraps a provider failure in a DomainError without leaking subject content", async () => {
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
      await expect(client.draftReply("super secret subject")).rejects.toBeInstanceOf(DomainError);
      for (const call of logSpy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain("super secret subject");
      }
      logSpy.mockRestore();
    });
  });
});
