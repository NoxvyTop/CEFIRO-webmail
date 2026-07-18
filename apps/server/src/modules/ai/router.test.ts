import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../../infra/db/client";
import { migrate } from "../../infra/db/migrate";
import { createUsersRepo } from "../../infra/repos/users";
import { createMailCredentialsRepo } from "../../infra/repos/mail-credentials";
import { importMasterKey } from "../credentials/crypto";
import { createSessionStore } from "../auth/sessions";
import { createApp } from "../../app";
import { createAiRouter } from "./router";
import type { AiClient } from "../../core/ai";
import type { JmapClient, JmapMethodCall } from "../../infra/stalwart/jmap";

const url = process.env.DATABASE_URL ?? "postgres://webmail:webmail@localhost:5434/webmail";
const sql = createDb(url);

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

function fakeAiClient(overrides: Partial<AiClient> = {}): AiClient & { summarizeCalls: string[]; draftCalls: { subject: string; context?: string }[] } {
  const summarizeCalls: string[] = [];
  const draftCalls: { subject: string; context?: string }[] = [];
  return {
    summarizeCalls,
    draftCalls,
    async summarize(body: string) {
      summarizeCalls.push(body);
      return overrides.summarize ? overrides.summarize(body) : ["one", "two", "three"];
    },
    async draftReply(subject: string, context?: string) {
      draftCalls.push({ subject, context });
      return overrides.draftReply ? overrides.draftReply(subject, context) : "Borrador generado.";
    },
  };
}

function makeApp(aiClient: AiClient | null, jmap: JmapClient | null) {
  return createApp({
    aiRouter: createAiRouter({ sessions, mailCredentials, jmap, aiClient }),
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

  it("rejects an empty subject with invalid_body", async () => {
    const ai = fakeAiClient();
    const app = makeApp(ai, null);
    const res = await post(app, "/api/mail/compose/draft", { subject: "" });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { code: string };
    expect(json.code).toBe("invalid_body");
  });
});
