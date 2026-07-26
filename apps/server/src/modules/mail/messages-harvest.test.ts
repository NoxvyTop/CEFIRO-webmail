import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../../infra/db/client";
import { migrate } from "../../infra/db/migrate";
import { createUsersRepo } from "../../infra/repos/users";
import { createMailCredentialsRepo } from "../../infra/repos/mail-credentials";
import { createSignaturesRepo } from "../../infra/repos/signatures";
import { createUserPreferencesRepo } from "../../infra/repos/user-preferences";
import { createContactsRepo, type ContactsRepo } from "../../infra/repos/contacts";
import { importMasterKey } from "../credentials/crypto";
import { createSessionStore } from "../auth/sessions";
import { createApp } from "../../app";
import { createMailRouter } from "./router";
import type { JmapClient, JmapMethodCall } from "../../infra/stalwart/jmap";

const url =
  process.env.DATABASE_URL ?? "postgres://webmail:webmail@localhost:5434/webmail";
const sql = createDb(url);

const defaultMailboxRoles = [
  { id: "mb-inbox", role: "inbox" },
  { id: "mb-junk", role: "junk" },
  { id: "mb-trash", role: "trash" },
];

// Branches on the first method call's name so a single stub can answer both
// the GET /messages listing request (Email/query + Email/get) and the
// harvest's own mailbox-role lookup (Mailbox/get) — the same pattern
// send.test.ts uses to answer Identity/get vs Email/set.
function makeStubJmap(input: {
  emails: unknown[];
  mailboxes?: { id: string; role: string | null }[];
  calls: JmapMethodCall[][];
}): JmapClient {
  return {
    getSession: async () => ({
      apiUrl: "https://mail.test/jmap/",
      accountId: "acc-1",
      eventSourceUrl: "https://mail.test/es",
      uploadUrl: "https://mail.test/upload/{accountId}/",
      downloadUrl: "https://mail.test/download/{accountId}/{blobId}/{name}",
    }),
    request: async (_auth, _session, methodCalls) => {
      input.calls.push(methodCalls);
      const name = methodCalls[0]?.[0];
      if (name === "Mailbox/get") {
        return [["Mailbox/get", { list: input.mailboxes ?? defaultMailboxRoles }, "mb"]];
      }
      return [
        ["Email/query", { ids: input.emails.map((e: any) => e.id), total: input.emails.length, position: 0 }, "q"],
        ["Email/get", { list: input.emails }, "g"],
      ];
    },
    uploadBlob: async () => "blob-id",
  };
}

let sessions: ReturnType<typeof createSessionStore>;
let mailCredentials: ReturnType<typeof createMailCredentialsRepo>;
let contacts: ContactsRepo;

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
  const key = await importMasterKey(
    btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
  );
  mailCredentials = createMailCredentialsRepo(sql, key);
  sessions = createSessionStore(sql);
  contacts = createContactsRepo(sql);
});
afterAll(() => sql.end());

async function createTestUser() {
  const users = createUsersRepo(sql);
  const email = `harvest-${crypto.randomUUID()}@noxvytop.com`;
  const user = await users.create({ email, displayName: "Harvest User" });
  await mailCredentials.set(user.id, "mailbox-pw");
  const token = (await sessions.create(user.id, 1)).token;
  return { userId: user.id, email, token };
}

function makeApp(jmap: JmapClient, harvestContacts: ContactsRepo) {
  return createApp({
    mailRouter: createMailRouter({
      sessions,
      mailCredentials,
      signatures: createSignaturesRepo(sql),
      userPreferences: createUserPreferencesRepo(sql),
      jmap,
      contacts: harvestContacts,
    }),
  });
}

describe("contact harvest on GET /api/mail/messages", () => {
  it("adds new senders from a fetched inbox page", async () => {
    const user = await createTestUser();
    const calls: JmapMethodCall[][] = [];
    const jmap = makeStubJmap({
      emails: [
        {
          id: "e1",
          threadId: "t1",
          mailboxIds: { "mb-inbox": true },
          from: [{ name: "Alice", email: `alice-${user.userId}@x.com` }],
          to: [],
          receivedAt: "2026-07-05T10:00:00Z",
          size: 10,
        },
        {
          id: "e2",
          threadId: "t2",
          mailboxIds: { "mb-inbox": true },
          from: [{ name: "Bob", email: `bob-${user.userId}@x.com` }],
          to: [],
          receivedAt: "2026-07-06T10:00:00Z",
          size: 10,
        },
      ],
      calls,
    });

    const res = await makeApp(jmap, contacts).request("/api/mail/messages?mailboxId=mb-inbox", {
      headers: { cookie: `session=${user.token}` },
    });
    expect(res.status).toBe(200);

    const list = await contacts.list(user.userId);
    expect(list.some((c) => c.email === `alice-${user.userId}@x.com`)).toBe(true);
    expect(list.some((c) => c.email === `bob-${user.userId}@x.com`)).toBe(true);
    expect(list.find((c) => c.email === `alice-${user.userId}@x.com`)?.source).toBe("harvested");

    // The harvest resolves mailbox roles itself, as a separate JMAP call from
    // the listing's own Email/query + Email/get.
    expect(calls.some((c) => c[0]?.[0] === "Mailbox/get")).toBe(true);
  });

  it("does not harvest a sender whose message sits in Junk", async () => {
    const user = await createTestUser();
    const spamEmail = `spam-${user.userId}@x.com`;
    const jmap = makeStubJmap({
      emails: [
        {
          id: "e1",
          threadId: "t1",
          mailboxIds: { "mb-junk": true },
          from: [{ name: "Spammer", email: spamEmail }],
          to: [],
          receivedAt: "2026-07-05T10:00:00Z",
          size: 10,
        },
      ],
      calls: [],
    });

    const res = await makeApp(jmap, contacts).request("/api/mail/messages?mailboxId=mb-junk", {
      headers: { cookie: `session=${user.token}` },
    });
    expect(res.status).toBe(200);

    const list = await contacts.list(user.userId);
    expect(list.some((c) => c.email === spamEmail)).toBe(false);
  });

  it("does not harvest a sender whose message sits in Trash", async () => {
    const user = await createTestUser();
    const trashedEmail = `trashed-${user.userId}@x.com`;
    const jmap = makeStubJmap({
      emails: [
        {
          id: "e1",
          threadId: "t1",
          mailboxIds: { "mb-trash": true },
          from: [{ name: "Deleted Sender", email: trashedEmail }],
          to: [],
          receivedAt: "2026-07-05T10:00:00Z",
          size: 10,
        },
      ],
      calls: [],
    });

    const res = await makeApp(jmap, contacts).request("/api/mail/messages?mailboxId=mb-trash", {
      headers: { cookie: `session=${user.token}` },
    });
    expect(res.status).toBe(200);

    const list = await contacts.list(user.userId);
    expect(list.some((c) => c.email === trashedEmail)).toBe(false);
  });

  it("does not resurrect a contact the user deleted", async () => {
    const user = await createTestUser();
    const winEmail = `wontstay-${user.userId}@x.com`;
    const created = await contacts.create(user.userId, { name: "Will Be Deleted", email: winEmail });
    expect(created).not.toBeNull();
    await contacts.remove(user.userId, created!.id);

    const jmap = makeStubJmap({
      emails: [
        {
          id: "e1",
          threadId: "t1",
          mailboxIds: { "mb-inbox": true },
          from: [{ name: "Trying Again", email: winEmail }],
          to: [],
          receivedAt: "2026-07-05T10:00:00Z",
          size: 10,
        },
      ],
      calls: [],
    });

    const res = await makeApp(jmap, contacts).request("/api/mail/messages?mailboxId=mb-inbox", {
      headers: { cookie: `session=${user.token}` },
    });
    expect(res.status).toBe(200);

    const list = await contacts.list(user.userId);
    expect(list.some((c) => c.email === winEmail)).toBe(false);
  });

  it("does not harvest the user's own address", async () => {
    const user = await createTestUser();
    const jmap = makeStubJmap({
      emails: [
        {
          id: "e1",
          threadId: "t1",
          mailboxIds: { "mb-inbox": true },
          from: [{ name: "Myself", email: user.email.toUpperCase() }],
          to: [],
          receivedAt: "2026-07-05T10:00:00Z",
          size: 10,
        },
      ],
      calls: [],
    });

    const res = await makeApp(jmap, contacts).request("/api/mail/messages?mailboxId=mb-inbox", {
      headers: { cookie: `session=${user.token}` },
    });
    expect(res.status).toBe(200);

    const list = await contacts.list(user.userId);
    expect(list.some((c) => c.email.toLowerCase() === user.email.toLowerCase())).toBe(false);
  });

  it("still returns the mail listing when the harvest fails", async () => {
    const user = await createTestUser();
    const jmap = makeStubJmap({
      emails: [
        {
          id: "e1",
          threadId: "t1",
          mailboxIds: { "mb-inbox": true },
          from: [{ name: "Someone", email: `willfail-${user.userId}@x.com` }],
          to: [],
          subject: "Hi",
          receivedAt: "2026-07-05T10:00:00Z",
          size: 10,
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

    const res = await makeApp(jmap, failingContacts).request(
      "/api/mail/messages?mailboxId=mb-inbox",
      { headers: { cookie: `session=${user.token}` } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; emails: { subject: string }[] };
    expect(body.total).toBe(1);
    expect(body.emails[0]?.subject).toBe("Hi");
  });

  it("still returns the mail listing when the mailbox-role lookup itself throws", async () => {
    const user = await createTestUser();
    const jmap: JmapClient = {
      getSession: async () => ({
        apiUrl: "https://mail.test/jmap/",
        accountId: "acc-1",
        eventSourceUrl: "https://mail.test/es",
        uploadUrl: "https://mail.test/upload/{accountId}/",
        downloadUrl: "https://mail.test/download/{accountId}/{blobId}/{name}",
      }),
      request: async (_auth, _session, methodCalls) => {
        if (methodCalls[0]?.[0] === "Mailbox/get") {
          throw new Error("boom: simulated JMAP failure");
        }
        return [
          ["Email/query", { ids: ["e1"], total: 1, position: 0 }, "q"],
          [
            "Email/get",
            {
              list: [
                {
                  id: "e1",
                  threadId: "t1",
                  mailboxIds: { "mb-inbox": true },
                  from: [{ name: "Someone", email: `stillok-${user.userId}@x.com` }],
                  to: [],
                  subject: "Still here",
                  receivedAt: "2026-07-05T10:00:00Z",
                  size: 10,
                },
              ],
            },
            "g",
          ],
        ];
      },
      uploadBlob: async () => "blob-id",
    };

    const res = await makeApp(jmap, contacts).request("/api/mail/messages?mailboxId=mb-inbox", {
      headers: { cookie: `session=${user.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { emails: { subject: string }[] };
    expect(body.emails[0]?.subject).toBe("Still here");
  });

  it("does not add the extra Mailbox/get call or attempt a harvest when no contacts repo is wired", async () => {
    const user = await createTestUser();
    const calls: JmapMethodCall[][] = [];
    const jmap = makeStubJmap({
      emails: [
        {
          id: "e1",
          threadId: "t1",
          mailboxIds: { "mb-inbox": true },
          from: [{ name: "Someone", email: `nowire-${user.userId}@x.com` }],
          to: [],
          receivedAt: "2026-07-05T10:00:00Z",
          size: 10,
        },
      ],
      calls,
    });

    const app = createApp({
      mailRouter: createMailRouter({
        sessions,
        mailCredentials,
        signatures: createSignaturesRepo(sql),
        userPreferences: createUserPreferencesRepo(sql),
        jmap,
        // no `contacts` dep at all
      }),
    });

    const res = await app.request("/api/mail/messages?mailboxId=mb-inbox", {
      headers: { cookie: `session=${user.token}` },
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]?.[0]).toBe("Email/query");
  });
});
