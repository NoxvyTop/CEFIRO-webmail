import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../../infra/db/client";
import { testDatabaseUrl } from "../../infra/db/test-db";
import { migrate } from "../../infra/db/migrate";
import { createUsersRepo } from "../../infra/repos/users";
import { createMailCredentialsRepo } from "../../infra/repos/mail-credentials";
import { importMasterKey } from "../credentials/crypto";
import { createSessionStore } from "../auth/sessions";
import { createApp } from "../../app";
import { capThreadMessages, createAiRouter, stripQuotedTrail } from "./router";
import { createRateLimiter, type RateLimiter } from "../../core/rate-limit";
import type { AiClient } from "../../core/ai";
import type { JmapClient, JmapMethodCall } from "../../infra/jmap/client";

const sql = createDb(testDatabaseUrl());

let sessions: ReturnType<typeof createSessionStore>;
let mailCredentials: ReturnType<typeof createMailCredentialsRepo>;
let token: string;

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
  const users = createUsersRepo(sql);
  const key = await importMasterKey(
    btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
  );
  mailCredentials = createMailCredentialsRepo(sql, key);
  sessions = createSessionStore(sql);

  const user = await users.create({
    email: `ai-${crypto.randomUUID()}@noxvytop.com`,
    displayName: "AI Test User",
  });
  await mailCredentials.set(user.id, "mailbox-pw");
  token = (await sessions.create(user.id, 1)).token;
});
afterAll(() => sql.end());

function stubJmap(bodyText: string | null): { client: JmapClient; calls: JmapMethodCall[] } {
  const calls: JmapMethodCall[] = [];
  const client: JmapClient = {
    getSession: async () => ({
      apiUrl: "https://mail.test/jmap/",
      accountId: "acc-1",
      eventSourceUrl: "",
      uploadUrl: "",
      downloadUrl: "",
    }),
    request: async (_auth, _session, methodCalls) => {
      calls.push(...methodCalls);
      if (bodyText === null) {
        return [["Email/get", { list: [] }, "g"]];
      }
      return [
        [
          "Email/get",
          {
            list: [
              {
                id: "e1",
                textBody: [{ partId: "t", type: "text/plain" }],
                bodyValues: { t: { value: bodyText } },
              },
            ],
          },
          "g",
        ],
      ];
    },
    uploadBlob: async () => "blob-id",
  };
  return { client, calls };
}

function fakeAiClient(overrides: Partial<AiClient> = {}): AiClient & {
  summarizeCalls: string[];
  summarizeThreadCalls: Array<{ from: string; body: string }[]>;
  draftCalls: { subject: string; context?: string }[];
} {
  const summarizeCalls: string[] = [];
  const summarizeThreadCalls: Array<{ from: string; body: string }[]> = [];
  const draftCalls: { subject: string; context?: string }[] = [];
  return {
    summarizeCalls,
    summarizeThreadCalls,
    draftCalls,
    async summarize(body: string) {
      summarizeCalls.push(body);
      return overrides.summarize ? overrides.summarize(body) : ["one", "two", "three"];
    },
    async summarizeThread(messages: { from: string; body: string }[]) {
      summarizeThreadCalls.push(messages);
      return overrides.summarizeThread ? overrides.summarizeThread(messages) : ["t-one", "t-two"];
    },
    async draftReply(subject: string, context?: string) {
      draftCalls.push({ subject, context });
      return overrides.draftReply ? overrides.draftReply(subject, context) : "Borrador generado.";
    },
  };
}

type StubThreadMessage = {
  id: string;
  from?: { name?: string | null; email: string }[];
  receivedAt: string;
  bodyText: string;
};

function stubThreadJmap(
  thread: { id: string; messages: StubThreadMessage[] } | null,
): { client: JmapClient; calls: JmapMethodCall[] } {
  const calls: JmapMethodCall[] = [];
  const client: JmapClient = {
    getSession: async () => ({
      apiUrl: "https://mail.test/jmap/",
      accountId: "acc-1",
      eventSourceUrl: "",
      uploadUrl: "",
      downloadUrl: "",
    }),
    request: async (_auth, _session, methodCalls) => {
      calls.push(...methodCalls);
      if (thread === null) {
        return [
          ["Thread/get", { list: [] }, "t"],
          ["Email/get", { list: [] }, "g"],
        ];
      }
      return [
        ["Thread/get", { list: [{ id: thread.id, emailIds: thread.messages.map((m) => m.id) }] }, "t"],
        [
          "Email/get",
          {
            list: thread.messages.map((m) => ({
              id: m.id,
              from: m.from,
              receivedAt: m.receivedAt,
              textBody: [{ partId: "t", type: "text/plain" }],
              bodyValues: { t: { value: m.bodyText } },
            })),
          },
          "g",
        ],
      ];
    },
    uploadBlob: async () => "blob-id",
  };
  return { client, calls };
}

function makeApp(aiClient: AiClient | null, jmap: JmapClient | null, aiRateLimiter?: RateLimiter) {
  return createApp({
    aiRouter: createAiRouter({ sessions, mailCredentials, jmap, aiClient, aiRateLimiter }),
  });
}

async function post(app: ReturnType<typeof makeApp>, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { cookie: `session=${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("ai router — software-level gate", () => {
  it("returns ai_disabled for summarize without attempting any JMAP call when aiClient is null", async () => {
    const { client, calls } = stubJmap("hello");
    const app = makeApp(null, client);
    const res = await post(app, "/api/mail/messages/e1/summarize", {});
    expect(res.status).toBe(501);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe("ai_disabled");
    expect(calls).toHaveLength(0);
  });

  it("returns ai_disabled for draft without calling the AI provider when aiClient is null", async () => {
    const app = makeApp(null, null);
    const res = await post(app, "/api/mail/compose/draft", { subject: "Hola" });
    expect(res.status).toBe(501);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe("ai_disabled");
  });

  it("returns ai_disabled for thread summarize without attempting any JMAP call when aiClient is null", async () => {
    const { client, calls } = stubThreadJmap({
      id: "th1",
      messages: [{ id: "e1", receivedAt: "2026-07-20T10:00:00Z", bodyText: "hi" }],
    });
    const app = makeApp(null, client);
    const res = await post(app, "/api/mail/threads/th1/summarize", {});
    expect(res.status).toBe(501);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe("ai_disabled");
    expect(calls).toHaveLength(0);
  });
});

describe("ai router — status (GH #292)", () => {
  it("reports enabled=true when an AI client is configured", async () => {
    const app = makeApp(fakeAiClient(), null);
    const res = await app.request("/api/mail/ai/status", {
      headers: { cookie: `session=${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true });
  });

  it("reports enabled=false when no AI client is configured", async () => {
    const app = makeApp(null, null);
    const res = await app.request("/api/mail/ai/status", {
      headers: { cookie: `session=${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
  });

  it("requires a session", async () => {
    const app = makeApp(fakeAiClient(), null);
    const res = await app.request("/api/mail/ai/status");
    expect(res.status).toBe(401);
  });
});

describe("ai router — summarize", () => {
  it("fetches the message body via JMAP and returns 3 bullets from the AI client", async () => {
    const { client } = stubJmap("Please review the invoice attached.");
    const ai = fakeAiClient();
    const app = makeApp(ai, client);
    const res = await post(app, "/api/mail/messages/e1/summarize", {});
    expect(res.status).toBe(200);
    const json = (await res.json()) as { bullets: string[] };
    expect(json.bullets).toEqual(["one", "two", "three"]);
    expect(ai.summarizeCalls).toEqual(["Please review the invoice attached."]);
  });

  it("returns 404 when the message does not exist", async () => {
    const { client } = stubJmap(null);
    const ai = fakeAiClient();
    const app = makeApp(ai, client);
    const res = await post(app, "/api/mail/messages/missing/summarize", {});
    expect(res.status).toBe(404);
  });
});

describe("ai router — summarize thread", () => {
  it("fetches all thread messages, strips dragged quotes, and calls summarizeThread with the assembled in-order messages", async () => {
    // Messages arrive from JMAP out of chronological order on purpose — this
    // asserts the route re-sorts by receivedAt itself (mirrors GET /threads/:id).
    const { client } = stubThreadJmap({
      id: "th1",
      messages: [
        {
          id: "e2",
          from: [{ name: "Beto", email: "beto@x.com" }],
          receivedAt: "2026-07-21T09:00:00Z",
          bodyText:
            "Perfecto, confirmo.\n\nEl 20/07/2026, Ana <ana@x.com> escribió:\n> Hola equipo, arrancamos el proyecto mañana.",
        },
        {
          id: "e1",
          from: [{ name: "Ana", email: "ana@x.com" }],
          receivedAt: "2026-07-20T10:00:00Z",
          bodyText: "Hola equipo, arrancamos el proyecto mañana.",
        },
      ],
    });
    const ai = fakeAiClient();
    const app = makeApp(ai, client);

    const res = await post(app, "/api/mail/threads/th1/summarize", {});

    expect(res.status).toBe(200);
    const json = (await res.json()) as { bullets: string[] };
    expect(json.bullets).toEqual(["t-one", "t-two"]);
    expect(ai.summarizeThreadCalls).toEqual([
      [
        { from: "Ana <ana@x.com>", body: "Hola equipo, arrancamos el proyecto mañana." },
        { from: "Beto <beto@x.com>", body: "Perfecto, confirmo." },
      ],
    ]);
  });

  it("returns 404 when the thread has no messages", async () => {
    const { client } = stubThreadJmap(null);
    const ai = fakeAiClient();
    const app = makeApp(ai, client);

    const res = await post(app, "/api/mail/threads/missing/summarize", {});

    expect(res.status).toBe(404);
  });
});

describe("stripQuotedTrail", () => {
  it("removes '>'-quoted lines from a reply body", () => {
    const body = "Suena bien, avancemos.\n> Propongo arrancar el lunes.\n> Saludos,\n> Ana";
    expect(stripQuotedTrail(body)).toBe("Suena bien, avancemos.");
  });

  it("truncates at the Spanish Gmail separator 'El ... escribió:'", () => {
    const body =
      "Confirmado, gracias.\n\nEl mar., 21 de jul. de 2026 a las 10:00, Ana <ana@x.com> escribió:\n> Arrancamos el lunes.";
    expect(stripQuotedTrail(body)).toBe("Confirmado, gracias.");
  });

  it("truncates at the English Gmail separator 'On ... wrote:'", () => {
    const body =
      "Confirmed, thanks.\n\nOn Tue, Jul 21, 2026 at 10:00 AM Ana <ana@x.com> wrote:\n> We start Monday.";
    expect(stripQuotedTrail(body)).toBe("Confirmed, thanks.");
  });

  it("truncates at an Outlook '-----Original Message-----' banner", () => {
    const body = "Sounds good.\n\n-----Original Message-----\nFrom: Ana\nSent: Monday";
    expect(stripQuotedTrail(body)).toBe("Sounds good.");
  });

  it("truncates at an Outlook underscore divider", () => {
    const body = "Sounds good.\n\n________________________________\nFrom: Ana <ana@x.com>";
    expect(stripQuotedTrail(body)).toBe("Sounds good.");
  });

  it("leaves a clean single-message body intact", () => {
    const body = "Hola equipo,\nArrancamos el proyecto el lunes.\nSaludos.";
    expect(stripQuotedTrail(body)).toBe(body);
  });
});

describe("ai router — compose draft", () => {
  it("drafts a reply body from the subject", async () => {
    const ai = fakeAiClient();
    const app = makeApp(ai, null);
    const res = await post(app, "/api/mail/compose/draft", { subject: "Reunión de mañana" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { body: string };
    expect(json.body).toBe("Borrador generado.");
    expect(ai.draftCalls).toEqual([{ subject: "Reunión de mañana", context: undefined }]);
  });

  // GH #299: the draft route used to call draftReply(subject) only, so the
  // original body the composer sent as `context` was silently dropped and the
  // draft ignored the email being replied to. Assert the route now forwards it.
  it("forwards the optional context (the original body) to draftReply (GH #299)", async () => {
    const ai = fakeAiClient();
    const app = makeApp(ai, null);
    const res = await post(app, "/api/mail/compose/draft", {
      subject: "Re: Presupuesto",
      context: "¿Puedes confirmar el total antes del viernes?",
    });
    expect(res.status).toBe(200);
    expect(ai.draftCalls).toEqual([
      { subject: "Re: Presupuesto", context: "¿Puedes confirmar el total antes del viernes?" },
    ]);
  });

  it("rejects a context over the length cap with invalid_body (GH #299)", async () => {
    const ai = fakeAiClient();
    const app = makeApp(ai, null);
    const res = await post(app, "/api/mail/compose/draft", {
      subject: "Re: Presupuesto",
      context: "a".repeat(4001),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_body");
    // Rejected before the paid provider is ever reached.
    expect(ai.draftCalls).toHaveLength(0);
  });

  it("rejects an empty subject with invalid_body", async () => {
    const ai = fakeAiClient();
    const app = makeApp(ai, null);
    const res = await post(app, "/api/mail/compose/draft", { subject: "" });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe("invalid_body");
  });
});

describe("ai router — per-user quota (GH #194)", () => {
  it("returns 429 ai_rate_limited with Retry-After once the user exceeds the quota", async () => {
    const ai = fakeAiClient();
    const app = makeApp(ai, null, createRateLimiter({ limit: 2, windowMs: 60_000 }));

    expect((await post(app, "/api/mail/compose/draft", { subject: "one" })).status).toBe(200);
    expect((await post(app, "/api/mail/compose/draft", { subject: "two" })).status).toBe(200);

    const blocked = await post(app, "/api/mail/compose/draft", { subject: "three" });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(((await blocked.json()) as { code: string }).code).toBe("ai_rate_limited");
    // The blocked request must not have reached the paid AI provider.
    expect(ai.draftCalls).toHaveLength(2);
  });

  it("does not count a request rejected by the software-level gate (ai_disabled)", async () => {
    // aiClient is null → ai_disabled fires before the quota, so a disabled
    // server never burns the caller's budget.
    const app = makeApp(null, null, createRateLimiter({ limit: 1, windowMs: 60_000 }));
    expect((await post(app, "/api/mail/compose/draft", { subject: "a" })).status).toBe(501);
    expect((await post(app, "/api/mail/compose/draft", { subject: "b" })).status).toBe(501);
  });

  it("shares one budget across the different AI endpoints for the same user", async () => {
    const ai = fakeAiClient();
    const { client } = stubJmap("hello");
    const app = makeApp(ai, client, createRateLimiter({ limit: 1, windowMs: 60_000 }));

    expect((await post(app, "/api/mail/compose/draft", { subject: "x" })).status).toBe(200);
    const blocked = await post(app, "/api/mail/messages/e1/summarize", {});
    expect(blocked.status).toBe(429);
    expect(((await blocked.json()) as { code: string }).code).toBe("ai_rate_limited");
  });
});

describe("capThreadMessages (GH #195)", () => {
  const msg = (from: string, body: string) => ({ from, body });

  it("keeps every message when under both caps", () => {
    const input = [msg("a", "hi"), msg("b", "there")];
    const result = capThreadMessages(input, { maxMessages: 10, maxChars: 1000 });
    expect(result.truncated).toBe(false);
    expect(result.messages).toEqual(input);
    expect(result.droppedMessages).toBe(0);
  });

  it("keeps only the most recent messages when the count cap is exceeded", () => {
    const input = [msg("a", "1"), msg("b", "2"), msg("c", "3"), msg("d", "4")];
    const result = capThreadMessages(input, { maxMessages: 2, maxChars: 100_000 });
    expect(result.truncated).toBe(true);
    expect(result.droppedMessages).toBe(2);
    // Most recent two, still in chronological order.
    expect(result.messages).toEqual([msg("c", "3"), msg("d", "4")]);
  });

  it("truncates the total character budget from the oldest kept message", () => {
    const input = [msg("a", "AAAAA"), msg("b", "BBBBB"), msg("c", "CCCCC")];
    const result = capThreadMessages(input, { maxMessages: 10, maxChars: 12 });
    expect(result.truncated).toBe(true);
    // 12 char budget: newest two whole (10 chars) + 2 chars of the oldest kept.
    const totalChars = result.messages.reduce((n, m) => n + m.body.length, 0);
    expect(totalChars).toBeLessThanOrEqual(12);
    expect(result.messages.at(-1)).toEqual(msg("c", "CCCCC"));
  });
});
