import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { createDb } from "../../infra/db/client";
import { testDatabaseUrl } from "../../infra/db/test-db";
import { migrate } from "../../infra/db/migrate";
import { createUsersRepo } from "../../infra/repos/users";
import { createUserPreferencesRepo } from "../../infra/repos/user-preferences";
import { createSentRecipientsRepo, type SentRecipientsRepo } from "../../infra/repos/sent-recipients";
import type { JmapClient, JmapMethodCall, JmapSession } from "../../infra/jmap/client";
import {
  backfillSentRecipients,
  SENT_RECIPIENTS_BACKFILL_LIMIT,
  SENT_RECIPIENTS_BACKFILL_RETRY_MS,
} from "./sent-recipients-backfill";

const sql = createDb(testDatabaseUrl());
let users: ReturnType<typeof createUsersRepo>;
let userPreferences: ReturnType<typeof createUserPreferencesRepo>;
let sentRecipients: SentRecipientsRepo;

const auth = { email: "me@noxvytop.com", password: "pw" };
const session: JmapSession = {
  apiUrl: "https://mail.test/jmap/",
  accountId: "acc-1",
  eventSourceUrl: "https://mail.test/es",
  uploadUrl: "https://mail.test/upload/{accountId}/",
  downloadUrl: "https://mail.test/download/{accountId}/{blobId}/{name}",
};

beforeAll(async () => {
  await migrate(sql, fileURLToPath(new URL("../../../migrations", import.meta.url)));
  users = createUsersRepo(sql);
  userPreferences = createUserPreferencesRepo(sql);
  sentRecipients = createSentRecipientsRepo(sql);
});
afterAll(() => sql.end());

async function freshUser() {
  const email = `bf-${crypto.randomUUID()}@noxvytop.com`;
  const user = await users.create({ email, displayName: "Backfill User" });
  return { userId: user.id, email };
}

// Answers the two batches a backfill makes — the Mailbox/get role lookup and
// the Email/query + Email/get page of the Sent mailbox — recording every
// batch so a test can assert how many (or that none) happened.
function makeStubJmap(input: {
  mailboxes?: { id: string; role: string | null }[];
  emails?: unknown[];
  calls: JmapMethodCall[][];
  throws?: boolean;
}): JmapClient {
  return {
    getSession: async () => session,
    request: async (_auth, _session, methodCalls) => {
      input.calls.push(methodCalls);
      if (input.throws) throw new Error("boom: simulated JMAP failure");
      const name = methodCalls[0]?.[0];
      if (name === "Mailbox/get") {
        return [
          [
            "Mailbox/get",
            { list: input.mailboxes ?? [{ id: "mb-inbox", role: "inbox" }, { id: "mb-sent", role: "sent" }] },
            "mb",
          ],
        ];
      }
      const emails = input.emails ?? [];
      return [
        ["Email/query", { ids: emails.map((e) => (e as { id: string }).id), position: 0 }, "q"],
        ["Email/get", { list: emails }, "g"],
      ];
    },
    uploadBlob: async () => "blob-id",
  };
}

function run(
  user: { userId: string; email: string },
  jmap: JmapClient,
  repo = sentRecipients,
  // GH #314 (JD-2): the injectable clock the retry window is measured against.
  now?: () => Date,
) {
  return backfillSentRecipients({
    jmap,
    auth,
    session,
    userId: user.userId,
    ownerEmails: [user.email],
    sentRecipients: repo,
    userPreferences,
    now,
  });
}

/** Runs `fn` with the logger's console writers silenced. */
async function quietly(fn: () => Promise<void>) {
  const spies = [
    vi.spyOn(console, "log").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
  ];
  try {
    await fn();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

// GH #314: the one-time, bounded pass over the Sent mailbox that seeds the
// Tier A store for users whose correspondence predates this feature. Without
// it every long-standing correspondent would read as "none" until the next
// reply — the badge would be absent exactly where it is most expected.
describe("backfillSentRecipients (GH #314)", () => {
  it("records the recipients of the newest Sent messages and marks the user as backfilled", async () => {
    const user = await freshUser();
    const calls: JmapMethodCall[][] = [];
    const jmap = makeStubJmap({
      emails: [
        {
          id: "s1",
          to: [{ email: "Ana@partner.test" }],
          cc: [{ email: "bob@partner.test" }],
          bcc: [{ email: "carol@partner.test" }, { email: user.email }],
        },
        { id: "s2", to: [{ email: "dave@partner.test" }] },
      ],
      calls,
    });

    await run(user, jmap);

    const known = await sentRecipients.has(user.userId, [
      "ana@partner.test",
      "bob@partner.test",
      "carol@partner.test",
      "dave@partner.test",
      user.email,
    ]);
    expect(known).toEqual(
      new Set(["ana@partner.test", "bob@partner.test", "carol@partner.test", "dave@partner.test"]),
    );
    expect(await userPreferences.getSentRecipientsBackfilledAt(user.userId)).not.toBeNull();

    // One bounded query, scoped to the Sent mailbox, newest first.
    const page = calls.find((c) => c[0]?.[0] === "Email/query");
    const query = page?.[0]?.[1] as {
      accountId: string;
      filter: { inMailbox: string };
      sort: { property: string; isAscending: boolean }[];
      limit: number;
    };
    expect(query.accountId).toBe("acc-1");
    expect(query.filter).toEqual({ inMailbox: "mb-sent" });
    expect(query.sort).toEqual([{ property: "receivedAt", isAscending: false }]);
    expect(query.limit).toBe(SENT_RECIPIENTS_BACKFILL_LIMIT);
    expect(SENT_RECIPIENTS_BACKFILL_LIMIT).toBe(200);
    const get = page?.[1]?.[1] as { properties: string[] };
    expect(get.properties).toEqual(expect.arrayContaining(["to", "cc", "bcc"]));
  });

  it("runs once: a second call for the same user makes no JMAP request at all", async () => {
    const user = await freshUser();
    const calls: JmapMethodCall[][] = [];
    const jmap = makeStubJmap({ emails: [{ id: "s1", to: [{ email: "ana@partner.test" }] }], calls });

    await run(user, jmap);
    const afterFirst = calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    await run(user, jmap);
    expect(calls).toHaveLength(afterFirst);
  });

  it("marks the user as backfilled when the account has no Sent mailbox, without querying mail", async () => {
    const user = await freshUser();
    const calls: JmapMethodCall[][] = [];
    const jmap = makeStubJmap({ mailboxes: [{ id: "mb-inbox", role: "inbox" }], calls });

    await run(user, jmap);

    expect(calls.filter((c) => c[0]?.[0] === "Email/query")).toHaveLength(0);
    expect(await userPreferences.getSentRecipientsBackfilledAt(user.userId)).not.toBeNull();
  });

  it("marks the user as backfilled when Sent is empty", async () => {
    const user = await freshUser();
    const jmap = makeStubJmap({ emails: [], calls: [] });
    await run(user, jmap);
    expect(await userPreferences.getSentRecipientsBackfilledAt(user.userId)).not.toBeNull();
  });

  it("swallows a JMAP failure, logs it, and leaves the user un-backfilled so it is retried after the window", async () => {
    const user = await freshUser();
    const jmap = makeStubJmap({ calls: [], throws: true });
    // The logger writes JSON lines through console.log/console.warn depending
    // on level (see core/logger.ts); capture both, as events-harvest.test does.
    const lines: Record<string, unknown>[] = [];
    const record = (...args: unknown[]) => {
      lines.push(JSON.parse(String(args[0])) as Record<string, unknown>);
    };
    const spies = [
      vi.spyOn(console, "log").mockImplementation(record),
      vi.spyOn(console, "warn").mockImplementation(record),
    ];
    try {
      await expect(run(user, jmap)).resolves.toBeUndefined();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(lines).toContainEqual(
      expect.objectContaining({ msg: "sent recipients backfill failed", userId: user.userId }),
    );
    expect(await userPreferences.getSentRecipientsBackfilledAt(user.userId)).toBeNull();
  });

  it("swallows a store failure and leaves the user un-backfilled", async () => {
    const user = await freshUser();
    const jmap = makeStubJmap({ emails: [{ id: "s1", to: [{ email: "ana@partner.test" }] }], calls: [] });
    const failing: SentRecipientsRepo = {
      ...sentRecipients,
      record: async () => {
        throw new Error("boom: simulated DB failure");
      },
    };
    const spies = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
    ];
    try {
      await expect(run(user, jmap, failing)).resolves.toBeUndefined();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(await userPreferences.getSentRecipientsBackfilledAt(user.userId)).toBeNull();
  });

  // GH #314 (JD-2): a failure used to leave NO trace, so a user whose backfill
  // fails persistently (a Sent mailbox the JMAP server errors on, a permission
  // problem, a repo that keeps throwing) re-ran the whole bounded pass —
  // Mailbox/get plus a 200-message Email/query + Email/get — inline on EVERY
  // thread read they made, for a cosmetic feature, forever. The attempt marker
  // bounds it to one pass per retry window.
  describe("bounded retry after a failure (JD-2)", () => {
    const T0 = new Date("2026-08-01T10:00:00.000Z");

    it("makes no JMAP request at all on a read inside the retry window", async () => {
      const user = await freshUser();
      await quietly(async () => {
        await run(user, makeStubJmap({ calls: [], throws: true }), sentRecipients, () => T0);
      });
      expect(await userPreferences.getSentRecipientsBackfilledAt(user.userId)).toBeNull();

      const calls: JmapMethodCall[][] = [];
      const working = makeStubJmap({ emails: [{ id: "s1", to: [{ email: "ana@partner.test" }] }], calls });
      // One millisecond short of the window: still the same attempt.
      await run(user, working, sentRecipients, () => new Date(T0.getTime() + SENT_RECIPIENTS_BACKFILL_RETRY_MS - 1));

      expect(calls).toHaveLength(0);
      expect(await userPreferences.getSentRecipientsBackfilledAt(user.userId)).toBeNull();
    });

    it("retries once the window has elapsed, and then marks the user backfilled", async () => {
      const user = await freshUser();
      await quietly(async () => {
        await run(user, makeStubJmap({ calls: [], throws: true }), sentRecipients, () => T0);
      });

      const calls: JmapMethodCall[][] = [];
      const working = makeStubJmap({ emails: [{ id: "s1", to: [{ email: "ana@partner.test" }] }], calls });
      await run(user, working, sentRecipients, () => new Date(T0.getTime() + SENT_RECIPIENTS_BACKFILL_RETRY_MS));

      expect(calls.filter((c) => c[0]?.[0] === "Email/query")).toHaveLength(1);
      expect(await sentRecipients.has(user.userId, ["ana@partner.test"])).toEqual(
        new Set(["ana@partner.test"]),
      );
      expect(await userPreferences.getSentRecipientsBackfilledAt(user.userId)).not.toBeNull();
    });

    it("records the attempt BEFORE running, so a pass that never returns is still bounded", async () => {
      const user = await freshUser();
      await quietly(async () => {
        await run(user, makeStubJmap({ calls: [], throws: true }), sentRecipients, () => T0);
      });
      expect(await userPreferences.getSentRecipientsBackfillAttemptedAt(user.userId)).toBe(
        T0.toISOString(),
      );
    });

    it("keeps the attempt marker out of the preferences a client can read or write", async () => {
      const user = await freshUser();
      await quietly(async () => {
        await run(user, makeStubJmap({ calls: [], throws: true }), sentRecipients, () => T0);
      });
      expect(Object.keys(await userPreferences.get(user.userId))).not.toContain(
        "sentRecipientsBackfillAttemptedAt",
      );
    });

    it("bounds the retry at 24 hours", () => {
      expect(SENT_RECIPIENTS_BACKFILL_RETRY_MS).toBe(24 * 60 * 60 * 1000);
    });
  });
});
