import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../../infra/db/client";
import { testDatabaseUrl } from "../../infra/db/test-db";
import { migrate } from "../../infra/db/migrate";
import { createUsersRepo } from "../../infra/repos/users";
import { createMailCredentialsRepo } from "../../infra/repos/mail-credentials";
import { createSignaturesRepo } from "../../infra/repos/signatures";
import { createUserPreferencesRepo } from "../../infra/repos/user-preferences";
import { createContactsRepo, type ContactsRepo } from "../../infra/repos/contacts";
import { createSentRecipientsRepo, type SentRecipientsRepo } from "../../infra/repos/sent-recipients";
import { importMasterKey } from "../credentials/crypto";
import { createSessionStore } from "../auth/sessions";
import { createApp } from "../../app";
import { createMailRouter } from "./router";
import type { JmapClient, JmapMethodCall } from "../../infra/jmap/client";

const sql = createDb(testDatabaseUrl());

const ACCOUNT_ID = "acc-1";
const defaultMailboxRoles = [
  { id: "mb-inbox", role: "inbox" },
  { id: "mb-junk", role: "junk" },
  { id: "mb-trash", role: "trash" },
  { id: "mb-sent", role: "sent" },
];

// Answers the two batches a mail-arrival harvest makes: the Email/query +
// Email/get that pulls the newest page, and the harvest's own Mailbox/get role
// lookup — the same branch-on-first-call pattern the old read-path harvest test
// used. `calls` records every batch so a test can assert none happened.
function makeStubJmap(input: {
  emails: unknown[];
  mailboxes?: { id: string; role: string | null }[];
  calls: JmapMethodCall[][];
  queryThrows?: boolean;
}): JmapClient {
  return {
    getSession: async () => ({
      apiUrl: "https://mail.test/jmap/",
      accountId: ACCOUNT_ID,
      eventSourceUrl: "https://mail.test/es?types={types}&closeafter={closeafter}&ping={ping}",
      uploadUrl: "https://mail.test/upload/{accountId}/",
      downloadUrl: "https://mail.test/download/{accountId}/{blobId}/{name}",
    }),
    request: async (_auth, _session, methodCalls) => {
      input.calls.push(methodCalls);
      const name = methodCalls[0]?.[0];
      if (name === "Mailbox/get") {
        return [["Mailbox/get", { list: input.mailboxes ?? defaultMailboxRoles }, "mb"]];
      }
      if (input.queryThrows) {
        throw new Error("boom: simulated JMAP failure");
      }
      return [
        ["Email/query", { ids: input.emails.map((e: any) => e.id), position: 0 }, "q"],
        ["Email/get", { list: input.emails }, "g"],
      ];
    },
    uploadBlob: async () => "blob-id",
  };
}

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
  return (async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const frame of frames) {
            controller.enqueue(new TextEncoder().encode(frame));
          }
          controller.close();
        },
      }),
      { status: 200 },
    )) as typeof fetch;
}

let sessions: ReturnType<typeof createSessionStore>;
let mailCredentials: ReturnType<typeof createMailCredentialsRepo>;
let contacts: ContactsRepo;
let sentRecipients: SentRecipientsRepo;

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
  const key = await importMasterKey(
    btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
  );
  mailCredentials = createMailCredentialsRepo(sql, key);
  sessions = createSessionStore(sql);
  contacts = createContactsRepo(sql);
  sentRecipients = createSentRecipientsRepo(sql);
});
afterAll(() => sql.end());

async function createTestUser() {
  const users = createUsersRepo(sql);
  const email = `arrival-${crypto.randomUUID()}@noxvytop.com`;
  const user = await users.create({ email, displayName: "Arrival User" });
  await mailCredentials.set(user.id, "mailbox-pw");
  const token = (await sessions.create(user.id, 1)).token;
  return { userId: user.id, email, token };
}

function makeApp(
  jmap: JmapClient,
  fetchFn: typeof fetch,
  harvestContacts?: ContactsRepo,
  // GH #314: the known-sender store fed from the same arrival page. Optional
  // like `contacts`, so every pre-existing test above runs exactly as before.
  harvestSentRecipients?: SentRecipientsRepo,
) {
  return createApp({
    mailRouter: createMailRouter({
      sessions,
      mailCredentials,
      signatures: createSignaturesRepo(sql),
      userPreferences: createUserPreferencesRepo(sql),
      jmap,
      fetchFn,
      contacts: harvestContacts,
      sentRecipients: harvestSentRecipients,
    }),
  });
}

describe("contact harvest on the mail-arrival event stream (GH #180)", () => {
  it("harvests senders when the account's Email state advances", async () => {
    const user = await createTestUser();
    const calls: JmapMethodCall[][] = [];
    const jmap = makeStubJmap({
      emails: [
        {
          id: "e1",
          mailboxIds: { "mb-inbox": true },
          from: [{ name: "Alice", email: `alice-${user.userId}@x.com` }],
        },
        {
          id: "e2",
          mailboxIds: { "mb-inbox": true },
          from: [{ name: "Bob", email: `bob-${user.userId}@x.com` }],
        },
      ],
      calls,
    });
    const fetchFn = sseFetch([
      stateChangeFrame({ email: "s1", mailbox: "m1" }),
      stateChangeFrame({ email: "s2", mailbox: "m1" }),
    ]);

    const res = await makeApp(jmap, fetchFn, contacts).request("/api/mail/events", {
      headers: { cookie: `session=${user.token}` },
    });
    expect(res.status).toBe(200);
    await res.text();

    const list = await contacts.list(user.userId);
    expect(list.some((c) => c.email === `alice-${user.userId}@x.com`)).toBe(true);
    expect(list.some((c) => c.email === `bob-${user.userId}@x.com`)).toBe(true);
    // Exactly one delivery -> exactly one harvest: one recent-mail batch + one
    // role lookup, not one per SSE frame.
    expect(calls.filter((c) => c[0]?.[0] === "Email/query")).toHaveLength(1);
    expect(calls.filter((c) => c[0]?.[0] === "Mailbox/get")).toHaveLength(1);
  });

  it("treats the first Email state as a baseline and does not harvest on it", async () => {
    const user = await createTestUser();
    const calls: JmapMethodCall[][] = [];
    const jmap = makeStubJmap({
      emails: [
        {
          id: "e1",
          mailboxIds: { "mb-inbox": true },
          from: [{ name: "Baseline", email: `baseline-${user.userId}@x.com` }],
        },
      ],
      calls,
    });

    const res = await makeApp(
      jmap,
      sseFetch([stateChangeFrame({ email: "s1", mailbox: "m1" })]),
      contacts,
    ).request("/api/mail/events", { headers: { cookie: `session=${user.token}` } });
    expect(res.status).toBe(200);
    await res.text();

    expect(calls).toHaveLength(0);
    const list = await contacts.list(user.userId);
    expect(list.some((c) => c.email === `baseline-${user.userId}@x.com`)).toBe(false);
  });

  it("does not harvest when only the Mailbox state changes", async () => {
    const user = await createTestUser();
    const calls: JmapMethodCall[][] = [];
    const jmap = makeStubJmap({
      emails: [
        {
          id: "e1",
          mailboxIds: { "mb-inbox": true },
          from: [{ name: "Read Flag", email: `readflag-${user.userId}@x.com` }],
        },
      ],
      calls,
    });

    const res = await makeApp(
      jmap,
      // Email state is identical across both frames; only Mailbox advances (a
      // read flag flipping, a move) — that is not new mail.
      sseFetch([
        stateChangeFrame({ email: "s1", mailbox: "m1" }),
        stateChangeFrame({ email: "s1", mailbox: "m2" }),
      ]),
      contacts,
    ).request("/api/mail/events", { headers: { cookie: `session=${user.token}` } });
    expect(res.status).toBe(200);
    await res.text();

    expect(calls).toHaveLength(0);
    const list = await contacts.list(user.userId);
    expect(list.some((c) => c.email === `readflag-${user.userId}@x.com`)).toBe(false);
  });

  it("excludes a sender whose message sits in Junk, harvesting on arrival", async () => {
    const user = await createTestUser();
    const spam = `spam-${user.userId}@x.com`;
    const good = `good-${user.userId}@x.com`;
    const jmap = makeStubJmap({
      emails: [
        { id: "e1", mailboxIds: { "mb-junk": true }, from: [{ name: "Spammer", email: spam }] },
        { id: "e2", mailboxIds: { "mb-inbox": true }, from: [{ name: "Good", email: good }] },
      ],
      calls: [],
    });

    const res = await makeApp(
      jmap,
      sseFetch([
        stateChangeFrame({ email: "s1" }),
        stateChangeFrame({ email: "s2" }),
      ]),
      contacts,
    ).request("/api/mail/events", { headers: { cookie: `session=${user.token}` } });
    expect(res.status).toBe(200);
    await res.text();

    const list = await contacts.list(user.userId);
    expect(list.some((c) => c.email === good)).toBe(true);
    expect(list.some((c) => c.email === spam)).toBe(false);
  });

  it("streams the bytes through unchanged and stays open when the harvest fails", async () => {
    const user = await createTestUser();
    const jmap = makeStubJmap({
      emails: [
        {
          id: "e1",
          mailboxIds: { "mb-inbox": true },
          from: [{ name: "Someone", email: `willfail-${user.userId}@x.com` }],
        },
      ],
      calls: [],
    });
    const failingContacts: ContactsRepo = {
      ...contacts,
      harvestSenders: async () => {
        throw new Error("boom: simulated DB failure");
      },
    };
    const frames = [
      stateChangeFrame({ email: "s1" }),
      stateChangeFrame({ email: "s2" }),
    ];

    const res = await makeApp(jmap, sseFetch(frames), failingContacts).request(
      "/api/mail/events",
      { headers: { cookie: `session=${user.token}` } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    // The proxied body is byte-for-byte the upstream frames despite the failure.
    expect(await res.text()).toBe(frames.join(""));
  });

  it("swallows a failure fetching the recent page and keeps the stream intact", async () => {
    const user = await createTestUser();
    const calls: JmapMethodCall[][] = [];
    const jmap = makeStubJmap({ emails: [], calls, queryThrows: true });
    const frames = [
      stateChangeFrame({ email: "s1" }),
      stateChangeFrame({ email: "s2" }),
    ];

    const res = await makeApp(jmap, sseFetch(frames), contacts).request("/api/mail/events", {
      headers: { cookie: `session=${user.token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(frames.join(""));
    // The Email/query batch was attempted (and threw); no harvest followed.
    expect(calls.filter((c) => c[0]?.[0] === "Email/query")).toHaveLength(1);
    expect(calls.filter((c) => c[0]?.[0] === "Mailbox/get")).toHaveLength(0);
  });

  it("attributes a harvest failure to the request that opened the stream (GH #219)", async () => {
    // The harvest runs off the stream, after the handler returned, so its
    // context is not the ambient one any more. Without the traceId this line
    // says a harvest failed for someone, somewhere — the exact shape of log
    // that cannot be followed back to the report a user filed.
    const user = await createTestUser();
    const jmap = makeStubJmap({ emails: [], calls: [], queryThrows: true });
    const frames = [stateChangeFrame({ email: "s1" }), stateChangeFrame({ email: "s2" })];

    const lines: Record<string, unknown>[] = [];
    const record = (...args: unknown[]) => {
      lines.push(JSON.parse(String(args[0])) as Record<string, unknown>);
    };
    const spies = [
      vi.spyOn(console, "log").mockImplementation(record),
      vi.spyOn(console, "warn").mockImplementation(record),
    ];
    try {
      const res = await makeApp(jmap, sseFetch(frames), contacts).request("/api/mail/events", {
        headers: { cookie: `session=${user.token}` },
      });
      await res.text();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    // The access record names the request; the harvest failure has to be
    // findable by the same id.
    const access = lines.find((line) => line.msg === "request" && line.path === "/api/mail/events");
    expect(access?.traceId).toBeTruthy();
    expect(lines).toContainEqual(
      expect.objectContaining({
        msg: "contacts harvest on mail arrival failed",
        userId: user.userId,
        traceId: access!.traceId,
      }),
    );
  });

  it("does not harvest when the recent page comes back empty", async () => {
    const user = await createTestUser();
    const calls: JmapMethodCall[][] = [];
    const jmap = makeStubJmap({ emails: [], calls });

    const res = await makeApp(
      jmap,
      sseFetch([
        stateChangeFrame({ email: "s1" }),
        stateChangeFrame({ email: "s2" }),
      ]),
      contacts,
    ).request("/api/mail/events", { headers: { cookie: `session=${user.token}` } });
    expect(res.status).toBe(200);
    await res.text();

    // The page fetch ran, found nothing, and skipped the role lookup entirely.
    expect(calls.filter((c) => c[0]?.[0] === "Email/query")).toHaveLength(1);
    expect(calls.filter((c) => c[0]?.[0] === "Mailbox/get")).toHaveLength(0);
  });

  it("ignores keepalive and unparseable frames without harvesting or corrupting the stream", async () => {
    const user = await createTestUser();
    const calls: JmapMethodCall[][] = [];
    const jmap = makeStubJmap({
      emails: [
        {
          id: "e1",
          mailboxIds: { "mb-inbox": true },
          from: [{ name: "Noise", email: `noise-${user.userId}@x.com` }],
        },
      ],
      calls,
    });
    // A keepalive comment (no data line) and a malformed data line, neither of
    // which is an Email state change.
    const frames = [": keepalive\n\n", "event: state\ndata: not-json\n\n"];

    const res = await makeApp(jmap, sseFetch(frames), contacts).request("/api/mail/events", {
      headers: { cookie: `session=${user.token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(frames.join(""));
    expect(calls).toHaveLength(0);
  });
});

// GH #314: the same arrival page feeds the Tier A ("known sender") store —
// the to/cc/bcc of messages sitting in Sent. This is what keeps the store in
// step with mail sent from OTHER clients (a phone, a desktop MUA), which never
// pass through POST /send.
describe("sent-recipient harvest on the mail-arrival event stream (GH #314)", () => {
  const arrival = [stateChangeFrame({ email: "s1" }), stateChangeFrame({ email: "s2" })];

  it("records the to/cc/bcc of messages in Sent, and nothing from received mail", async () => {
    const user = await createTestUser();
    const calls: JmapMethodCall[][] = [];
    const sentTo = `sent-to-${user.userId}@x.com`;
    const sentCc = `sent-cc-${user.userId}@x.com`;
    const sentBcc = `sent-bcc-${user.userId}@x.com`;
    const receivedTo = `received-to-${user.userId}@x.com`;
    const jmap = makeStubJmap({
      emails: [
        {
          id: "e-sent",
          mailboxIds: { "mb-sent": true },
          from: [{ name: "Me", email: user.email }],
          to: [{ name: "To", email: sentTo.toUpperCase() }],
          cc: [{ email: sentCc }],
          bcc: [{ email: sentBcc }],
        },
        {
          id: "e-received",
          mailboxIds: { "mb-inbox": true },
          from: [{ name: "Alice", email: `alice-${user.userId}@x.com` }],
          to: [{ email: receivedTo }],
        },
      ],
      calls,
    });

    const res = await makeApp(jmap, sseFetch(arrival), contacts, sentRecipients).request(
      "/api/mail/events",
      { headers: { cookie: `session=${user.token}` } },
    );
    expect(res.status).toBe(200);
    await res.text();

    const known = await sentRecipients.has(user.userId, [sentTo, sentCc, sentBcc, receivedTo]);
    expect(known).toEqual(new Set([sentTo, sentCc, sentBcc]));

    // The page is fetched ONCE for both harvests, and it must carry the
    // recipient properties the sent side needs.
    const pageCalls = calls.filter((c) => c[0]?.[0] === "Email/query");
    expect(pageCalls).toHaveLength(1);
    const getCall = pageCalls[0]?.find((c) => c[0] === "Email/get");
    const getParams = getCall?.[1] as { properties: string[] } | undefined;
    expect(getParams?.properties).toEqual(
      expect.arrayContaining(["from", "mailboxIds", "to", "cc", "bcc"]),
    );
    // The pre-existing sender harvest still ran off the same page.
    const list = await contacts.list(user.userId);
    expect(list.some((c) => c.email === `alice-${user.userId}@x.com`)).toBe(true);
  });

  it("never records the owner's own address from a message they sent to themselves", async () => {
    const user = await createTestUser();
    const other = `other-${user.userId}@x.com`;
    const jmap = makeStubJmap({
      emails: [
        {
          id: "e-self",
          mailboxIds: { "mb-sent": true },
          from: [{ email: user.email }],
          to: [{ email: user.email.toUpperCase() }, { email: other }],
        },
      ],
      calls: [],
    });

    const res = await makeApp(jmap, sseFetch(arrival), undefined, sentRecipients).request(
      "/api/mail/events",
      { headers: { cookie: `session=${user.token}` } },
    );
    await res.text();

    expect(await sentRecipients.has(user.userId, [user.email, other])).toEqual(new Set([other]));
  });

  it("runs with only the sent-recipients store wired (no contacts repo)", async () => {
    const user = await createTestUser();
    const calls: JmapMethodCall[][] = [];
    const recipient = `solo-${user.userId}@x.com`;
    const jmap = makeStubJmap({
      emails: [{ id: "e1", mailboxIds: { "mb-sent": true }, to: [{ email: recipient }] }],
      calls,
    });

    const res = await makeApp(jmap, sseFetch(arrival), undefined, sentRecipients).request(
      "/api/mail/events",
      { headers: { cookie: `session=${user.token}` } },
    );
    expect(res.status).toBe(200);
    await res.text();

    expect(await sentRecipients.has(user.userId, [recipient])).toEqual(new Set([recipient]));
    expect(calls.filter((c) => c[0]?.[0] === "Email/query")).toHaveLength(1);
  });

  it("streams the bytes through unchanged when recording sent recipients fails", async () => {
    const user = await createTestUser();
    const jmap = makeStubJmap({
      emails: [
        { id: "e1", mailboxIds: { "mb-sent": true }, to: [{ email: `fail-${user.userId}@x.com` }] },
      ],
      calls: [],
    });
    const failing: SentRecipientsRepo = {
      ...sentRecipients,
      record: async () => {
        throw new Error("boom: simulated DB failure");
      },
    };

    const res = await makeApp(jmap, sseFetch(arrival), contacts, failing).request(
      "/api/mail/events",
      { headers: { cookie: `session=${user.token}` } },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(arrival.join(""));
  });
});
