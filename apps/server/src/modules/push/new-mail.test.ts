import { describe, expect, it } from "vitest";
import { notifyNewMail, newMailPayload, NEW_MAIL_SUBJECT_MAX } from "./new-mail";
import type { PushPayload, PushSendResult } from "../../core/push";
import type { StoredPushSubscription } from "../../infra/repos/push-subscriptions";
import type {
  JmapAuth,
  JmapClient,
  JmapMethodCall,
  JmapMethodResponse,
  JmapSession,
} from "../../infra/jmap/client";

const ACCOUNT_ID = "acc-1";
const INBOX_ID = "mb-inbox";

const session: JmapSession = {
  apiUrl: "https://mail.test/jmap/",
  accountId: ACCOUNT_ID,
  eventSourceUrl: "https://mail.test/es",
  uploadUrl: "https://mail.test/upload/{accountId}/",
  downloadUrl: "https://mail.test/download/{accountId}/{blobId}/{name}",
};

const auth = { email: "user@test", password: "pw" };

type FakeEmail = {
  id: string;
  threadId?: string;
  subject?: string | null;
  from?: { name?: string | null; email: string }[];
  mailboxIds?: Record<string, boolean>;
  keywords?: Record<string, boolean>;
};

/**
 * One-batch JMAP stub: the notifier asks for Email/changes + Email/get +
 * Mailbox/get in a single request, so the fake answers all three at once and
 * records every batch it was asked for (the cost assertion below reads it).
 */
function fakeJmap(input: {
  created?: string[];
  emails?: FakeEmail[];
  mailboxes?: { id: string; role: string | null }[];
  calls: JmapMethodCall[][];
  throws?: boolean;
}): JmapClient {
  return {
    getSession: async () => session,
    request: async (
      _auth: JmapAuth,
      _session: JmapSession,
      calls: JmapMethodCall[],
    ): Promise<JmapMethodResponse[]> => {
      input.calls.push(calls);
      if (input.throws) throw new Error("boom: simulated JMAP failure");
      return [
        [
          "Email/changes",
          { created: input.created ?? (input.emails ?? []).map((e) => e.id), newState: "s2" },
          "c",
        ],
        ["Email/get", { list: input.emails ?? [] }, "g"],
        [
          "Mailbox/get",
          { list: input.mailboxes ?? [{ id: INBOX_ID, role: "inbox" }] },
          "mb",
        ],
      ];
    },
    uploadBlob: async () => "blob-id",
  } as unknown as JmapClient;
}

function fakeSender(results: PushSendResult[] = []) {
  const sent: { endpoint: string; payload: PushPayload }[] = [];
  let call = 0;
  return {
    sent,
    sender: {
      async send(subscription: StoredPushSubscription, payload: PushPayload) {
        sent.push({ endpoint: subscription.endpoint, payload });
        const result = results[call] ?? "sent";
        call += 1;
        return result;
      },
    },
  };
}

function fakeSubscriptions(endpoints: string[]) {
  const deleted: string[] = [];
  return {
    deleted,
    repo: {
      listByUser: async () =>
        endpoints.map((endpoint) => ({ endpoint, p256dh: "p", auth: "a" })),
      deleteByEndpoint: async (endpoint: string) => {
        deleted.push(endpoint);
      },
    } as never,
  };
}

function inboxMail(overrides: Partial<FakeEmail> = {}): FakeEmail {
  return {
    id: "e1",
    threadId: "t1",
    subject: "Factura de marzo",
    from: [{ name: "Alice", email: "alice@x.com" }],
    mailboxIds: { [INBOX_ID]: true },
    keywords: {},
    ...overrides,
  };
}

describe("newMailPayload", () => {
  it("uses the sender display name as the title and the subject as the body", () => {
    expect(newMailPayload(inboxMail())).toEqual({
      title: "Alice",
      body: "Factura de marzo",
      targetId: "t1",
    });
  });

  it("falls back to the sender address when there is no display name", () => {
    expect(newMailPayload(inboxMail({ from: [{ email: "bob@x.com" }] })).title).toBe("bob@x.com");
  });

  it("truncates a long subject so the payload stays small", () => {
    const long = "a".repeat(NEW_MAIL_SUBJECT_MAX + 40);
    const body = newMailPayload(inboxMail({ subject: long })).body;
    expect(body).toHaveLength(NEW_MAIL_SUBJECT_MAX);
    expect(body.endsWith("…")).toBe(true);
  });

  it("never carries anything beyond title, body and the routing ids", () => {
    const payload = newMailPayload(inboxMail(), "acc-shared");
    expect(Object.keys(payload).sort()).toEqual(["accountId", "body", "targetId", "title"]);
  });

  // GH #337 (c): the service worker needs the account to open a shared thread;
  // the personal account is the default and is deliberately never named.
  it("names the account only when the mail is not in the personal one", () => {
    expect(newMailPayload(inboxMail(), "acc-shared").accountId).toBe("acc-shared");
    expect(newMailPayload(inboxMail()).accountId).toBeUndefined();
  });
});

describe("notifyNewMail", () => {
  it("names a shared account in the payload so the click opens the right view", async () => {
    const { sent, sender } = fakeSender();

    await notifyNewMail({
      pushClient: sender,
      pushSubscriptions: fakeSubscriptions(["https://push.test/a"]).repo,
      jmap: fakeJmap({ emails: [inboxMail()], calls: [] }),
      auth,
      session,
      userId: "u1",
      accountId: "acc-shared",
      sinceState: "s1",
      seen: new Set(),
    });

    expect(sent[0]?.payload.accountId).toBe("acc-shared");
  });

  it("sends one push per subscription for a new unread Inbox message", async () => {
    const calls: JmapMethodCall[][] = [];
    const { sent, sender } = fakeSender();
    const { repo } = fakeSubscriptions(["https://push.test/a", "https://push.test/b"]);

    await notifyNewMail({
      pushClient: sender,
      pushSubscriptions: repo,
      jmap: fakeJmap({ emails: [inboxMail()], calls }),
      auth,
      session,
      userId: "u1",
      sinceState: "s1",
      seen: new Set(),
    });

    expect(sent).toHaveLength(2);
    expect(sent[0]?.payload).toEqual({ title: "Alice", body: "Factura de marzo", targetId: "t1" });
    expect(sent.map((s) => s.endpoint)).toEqual(["https://push.test/a", "https://push.test/b"]);
  });

  it("costs exactly one JMAP batch per state change", async () => {
    const calls: JmapMethodCall[][] = [];
    const { repo } = fakeSubscriptions(["https://push.test/a"]);

    await notifyNewMail({
      pushClient: fakeSender().sender,
      pushSubscriptions: repo,
      jmap: fakeJmap({ emails: [inboxMail(), inboxMail({ id: "e2", threadId: "t2" })], calls }),
      auth,
      session,
      userId: "u1",
      sinceState: "s1",
      seen: new Set(),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.map((c) => c[0])).toEqual(["Email/changes", "Email/get", "Mailbox/get"]);
    // The whole point of Email/changes: never a full listing.
    expect(calls[0]?.some((c) => c[0] === "Email/query")).toBe(false);
  });

  it("asks JMAP nothing when the user has no subscriptions", async () => {
    const calls: JmapMethodCall[][] = [];
    const { sent, sender } = fakeSender();

    await notifyNewMail({
      pushClient: sender,
      pushSubscriptions: fakeSubscriptions([]).repo,
      jmap: fakeJmap({ emails: [inboxMail()], calls }),
      auth,
      session,
      userId: "u1",
      sinceState: "s1",
      seen: new Set(),
    });

    expect(calls).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("ignores a message created outside the Inbox (a send, a filed copy)", async () => {
    const { sent, sender } = fakeSender();

    await notifyNewMail({
      pushClient: sender,
      pushSubscriptions: fakeSubscriptions(["https://push.test/a"]).repo,
      jmap: fakeJmap({
        emails: [inboxMail({ mailboxIds: { "mb-sent": true } })],
        calls: [],
      }),
      auth,
      session,
      userId: "u1",
      sinceState: "s1",
      seen: new Set(),
    });

    expect(sent).toHaveLength(0);
  });

  it("ignores a message that arrived already read", async () => {
    const { sent, sender } = fakeSender();

    await notifyNewMail({
      pushClient: sender,
      pushSubscriptions: fakeSubscriptions(["https://push.test/a"]).repo,
      jmap: fakeJmap({ emails: [inboxMail({ keywords: { $seen: true } })], calls: [] }),
      auth,
      session,
      userId: "u1",
      sinceState: "s1",
      seen: new Set(),
    });

    expect(sent).toHaveLength(0);
  });

  it("notifies each message id only once", async () => {
    const seen = new Set<string>();
    const { sent, sender } = fakeSender();
    const jmap = fakeJmap({ emails: [inboxMail()], calls: [] });
    const repo = fakeSubscriptions(["https://push.test/a"]).repo;
    const input = {
      pushClient: sender,
      pushSubscriptions: repo,
      jmap,
      auth,
      session,
      userId: "u1",
      sinceState: "s1",
      seen,
    };

    await notifyNewMail(input);
    await notifyNewMail(input);

    expect(sent).toHaveLength(1);
  });

  it("does nothing when the account has no Inbox to compare against", async () => {
    const { sent, sender } = fakeSender();

    await notifyNewMail({
      pushClient: sender,
      pushSubscriptions: fakeSubscriptions(["https://push.test/a"]).repo,
      jmap: fakeJmap({ emails: [inboxMail()], mailboxes: [{ id: "mb-x", role: null }], calls: [] }),
      auth,
      session,
      userId: "u1",
      sinceState: "s1",
      seen: new Set(),
    });

    expect(sent).toHaveLength(0);
  });

  it("prunes a subscription the push service reports as expired", async () => {
    const { sender } = fakeSender(["expired", "sent"]);
    const { repo, deleted } = fakeSubscriptions(["https://push.test/dead", "https://push.test/ok"]);

    await notifyNewMail({
      pushClient: sender,
      pushSubscriptions: repo,
      jmap: fakeJmap({ emails: [inboxMail()], calls: [] }),
      auth,
      session,
      userId: "u1",
      sinceState: "s1",
      seen: new Set(),
    });

    expect(deleted).toEqual(["https://push.test/dead"]);
  });

  it("stops using an endpoint once it has expired, for the rest of the batch", async () => {
    const { sent, sender } = fakeSender(["expired"]);
    const { repo, deleted } = fakeSubscriptions(["https://push.test/dead"]);

    await notifyNewMail({
      pushClient: sender,
      pushSubscriptions: repo,
      jmap: fakeJmap({
        emails: [inboxMail(), inboxMail({ id: "e2", threadId: "t2" })],
        calls: [],
      }),
      auth,
      session,
      userId: "u1",
      sinceState: "s1",
      seen: new Set(),
    });

    expect(sent).toHaveLength(1);
    expect(deleted).toEqual(["https://push.test/dead"]);
  });

  it("keeps a subscription that merely failed to receive one push", async () => {
    const { sender } = fakeSender(["failed"]);
    const { repo, deleted } = fakeSubscriptions(["https://push.test/flaky"]);

    await notifyNewMail({
      pushClient: sender,
      pushSubscriptions: repo,
      jmap: fakeJmap({ emails: [inboxMail()], calls: [] }),
      auth,
      session,
      userId: "u1",
      sinceState: "s1",
      seen: new Set(),
    });

    expect(deleted).toEqual([]);
  });

  it("swallows a JMAP failure instead of breaking the caller's stream", async () => {
    const { sent, sender } = fakeSender();

    await expect(
      notifyNewMail({
        pushClient: sender,
        pushSubscriptions: fakeSubscriptions(["https://push.test/a"]).repo,
        jmap: fakeJmap({ calls: [], throws: true }),
        auth,
        session,
        userId: "u1",
        sinceState: "s1",
        seen: new Set(),
      }),
    ).resolves.toBeUndefined();

    expect(sent).toHaveLength(0);
  });

  it("does nothing when Email/changes reports no created messages", async () => {
    const { sent, sender } = fakeSender();

    await notifyNewMail({
      pushClient: sender,
      pushSubscriptions: fakeSubscriptions(["https://push.test/a"]).repo,
      jmap: fakeJmap({ created: [], emails: [], calls: [] }),
      auth,
      session,
      userId: "u1",
      sinceState: "s1",
      seen: new Set(),
    });

    expect(sent).toHaveLength(0);
  });
});
