import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../../infra/db/client";
import { testDatabaseUrl } from "../../infra/db/test-db";
import { migrate } from "../../infra/db/migrate";
import { createUsersRepo } from "../../infra/repos/users";
import { createMailCredentialsRepo } from "../../infra/repos/mail-credentials";
import { createSignaturesRepo } from "../../infra/repos/signatures";
import { createUserPreferencesRepo } from "../../infra/repos/user-preferences";
import {
  createPushSubscriptionsRepo,
  type PushSubscriptionsRepo,
} from "../../infra/repos/push-subscriptions";
import { importMasterKey } from "../credentials/crypto";
import { createSessionStore } from "../auth/sessions";
import { createApp } from "../../app";
import { createMailRouter } from "./router";
import type { PushPayload, PushSender, PushSendResult } from "../../core/push";
import type {
  JmapAuth,
  JmapClient,
  JmapMethodCall,
  JmapMethodResponse,
  JmapSession,
} from "../../infra/jmap/client";

// GH #337: the emitter's wiring. The unit behaviour lives in
// modules/push/new-mail.test.ts; what is asserted here is that an Email state
// advance on GET /api/mail/events actually reaches PushSender.send — the link
// that did not exist (`PushSender.send` had no caller at all).

const sql = createDb(testDatabaseUrl());
const ACCOUNT_ID = "acc-1";
const INBOX_ID = "mb-inbox";

function stateChangeFrame(states: { email?: string; mailbox?: string }): string {
  const changed: Record<string, string> = {};
  if (states.email !== undefined) changed.Email = states.email;
  if (states.mailbox !== undefined) changed.Mailbox = states.mailbox;
  return `event: state\ndata: ${JSON.stringify({
    "@type": "StateChange",
    changed: { [ACCOUNT_ID]: changed },
  })}\n\n`;
}

function sseFetch(frames: string[]): typeof fetch {
  return (async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
          controller.close();
        },
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
}

function stubJmap(input: { emails: unknown[]; calls: JmapMethodCall[][] }): JmapClient {
  return {
    getSession: async () => ({
      apiUrl: "https://mail.test/jmap/",
      accountId: ACCOUNT_ID,
      eventSourceUrl: "https://mail.test/es?types={types}&closeafter={closeafter}&ping={ping}",
      uploadUrl: "https://mail.test/upload/{accountId}/",
      downloadUrl: "https://mail.test/download/{accountId}/{blobId}/{name}",
    }),
    request: async (
      _auth: JmapAuth,
      _session: JmapSession,
      calls: JmapMethodCall[],
    ): Promise<JmapMethodResponse[]> => {
      input.calls.push(calls);
      return [
        [
          "Email/changes",
          { created: input.emails.map((e) => (e as { id: string }).id), newState: "s2" },
          "c",
        ],
        ["Email/get", { list: input.emails }, "g"],
        ["Mailbox/get", { list: [{ id: INBOX_ID, role: "inbox" }] }, "mb"],
      ];
    },
    uploadBlob: async () => "blob-id",
  } as unknown as JmapClient;
}

function recordingSender(result: PushSendResult = "sent") {
  const sent: { endpoint: string; payload: PushPayload }[] = [];
  const sender: PushSender = {
    async send(subscription, payload) {
      sent.push({ endpoint: subscription.endpoint, payload });
      return result;
    },
  };
  return { sent, sender };
}

let sessions: ReturnType<typeof createSessionStore>;
let mailCredentials: ReturnType<typeof createMailCredentialsRepo>;
let pushSubscriptions: PushSubscriptionsRepo;

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
  const key = await importMasterKey(
    btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
  );
  mailCredentials = createMailCredentialsRepo(sql, key);
  sessions = createSessionStore(sql);
  pushSubscriptions = createPushSubscriptionsRepo(sql);
});
afterAll(() => sql.end());

async function createTestUser() {
  const users = createUsersRepo(sql);
  const email = `push-${crypto.randomUUID()}@noxvytop.com`;
  const user = await users.create({ email, displayName: "Push User" });
  await mailCredentials.set(user.id, "mailbox-pw");
  const token = (await sessions.create(user.id, 1)).token;
  return { userId: user.id, email, token };
}

function makeApp(jmap: JmapClient, fetchFn: typeof fetch, pushClient: PushSender | null) {
  return createApp({
    mailRouter: createMailRouter({
      sessions,
      mailCredentials,
      signatures: createSignaturesRepo(sql),
      userPreferences: createUserPreferencesRepo(sql),
      jmap,
      fetchFn,
      pushClient,
      pushSubscriptions,
    }),
  });
}

const arrival = [
  {
    id: "e1",
    threadId: "t1",
    subject: "Presupuesto revisado",
    from: [{ name: "Alice", email: "alice@x.com" }],
    mailboxIds: { [INBOX_ID]: true },
    keywords: {},
  },
];

describe("web push on mail arrival (GH #337)", () => {
  it("pushes to the user's subscriptions when the Email state advances", async () => {
    const user = await createTestUser();
    await pushSubscriptions.upsert({
      userId: user.userId,
      endpoint: `https://push.test/${user.userId}`,
      p256dh: "p",
      auth: "a",
    });
    const calls: JmapMethodCall[][] = [];
    const { sent, sender } = recordingSender();

    const res = await makeApp(
      stubJmap({ emails: arrival, calls }),
      sseFetch([stateChangeFrame({ email: "s1" }), stateChangeFrame({ email: "s2" })]),
      sender,
    ).request("/api/mail/events", { headers: { cookie: `session=${user.token}` } });
    expect(res.status).toBe(200);
    await res.text();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.endpoint).toBe(`https://push.test/${user.userId}`);
    expect(sent[0]?.payload).toEqual({
      title: "Alice",
      body: "Presupuesto revisado",
      targetId: "t1",
    });
    // The baseline frame must not cost a round trip, and the advance must cost
    // exactly one: Email/changes, never a listing.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]?.[0]).toBe("Email/changes");
    expect(calls[0]?.[0]?.[1]).toMatchObject({ sinceState: "s1" });
  });

  it("does not push when the server has no push client configured", async () => {
    const user = await createTestUser();
    await pushSubscriptions.upsert({
      userId: user.userId,
      endpoint: `https://push.test/off-${user.userId}`,
      p256dh: "p",
      auth: "a",
    });
    const calls: JmapMethodCall[][] = [];

    const res = await makeApp(
      stubJmap({ emails: arrival, calls }),
      sseFetch([stateChangeFrame({ email: "s1" }), stateChangeFrame({ email: "s2" })]),
      null,
    ).request("/api/mail/events", { headers: { cookie: `session=${user.token}` } });
    expect(res.status).toBe(200);
    await res.text();

    expect(calls).toHaveLength(0);
  });

  it("prunes a subscription the push service reports as gone", async () => {
    const user = await createTestUser();
    const endpoint = `https://push.test/dead-${user.userId}`;
    await pushSubscriptions.upsert({ userId: user.userId, endpoint, p256dh: "p", auth: "a" });
    const { sender } = recordingSender("expired");

    const res = await makeApp(
      stubJmap({ emails: arrival, calls: [] }),
      sseFetch([stateChangeFrame({ email: "s1" }), stateChangeFrame({ email: "s2" })]),
      sender,
    ).request("/api/mail/events", { headers: { cookie: `session=${user.token}` } });
    expect(res.status).toBe(200);
    await res.text();

    expect(await pushSubscriptions.listByUser(user.userId)).toEqual([]);
  });
});
