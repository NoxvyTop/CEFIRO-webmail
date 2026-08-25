import { log } from "../../core/logger";
import type { SentRecipientsRepo } from "../../infra/repos/sent-recipients";
import type { UserPreferencesRepo } from "../../infra/repos/user-preferences";
import type { JmapAuth, JmapClient, JmapSession } from "../../infra/jmap/client";
import { extractSentRecipients, type HarvestEmail } from "./contacts-harvest";

// GH #314: how many of the newest Sent messages the one-time backfill reads.
// Bounded because it runs inline with a thread read (the first one that
// resolves trust for this user) and against a mailbox that may hold years of
// mail; 200 covers everyone a person has written to recently, which is the
// population the "known sender" badge is for. Older correspondents become
// known again the next time the user writes to them (POST /send and the
// arrival harvest keep the store current from then on).
export const SENT_RECIPIENTS_BACKFILL_LIMIT = 200;

type BackfillMailbox = { id: string; role?: string | null };

/**
 * One-time, bounded seed of the sent_recipients store from the user's Sent
 * mailbox (GH #314). Without it a user whose correspondence predates this
 * feature would see no "known sender" badge on anyone until their next reply
 * — absent exactly where it is most expected.
 *
 * Runs at most once per user: the first call that completes marks
 * `sentRecipientsBackfilledAt` in user_preferences, and every later call
 * returns after that one preference read. Two concurrent first calls (two
 * thread reads racing) both run the same idempotent upsert — harmless, and
 * cheaper than a lock on a path that executes once in a user's lifetime.
 *
 * Never throws, and does NOT mark the user on failure: the thread route
 * calls this before answering, so an exception here would turn a JMAP or
 * database hiccup into a broken reader for a cosmetic feature. A failed pass
 * is logged and retried on the next thread read; only a completed pass (or an
 * account with no Sent mailbox at all, where there is nothing to backfill and
 * retrying would only repeat the role lookup forever) marks the user done.
 *
 * Two JMAP batches rather than one: the Mailbox/get role lookup is separate
 * from the Email/query + Email/get page for the same reason contacts-harvest.ts
 * keeps them apart — JmapClient.request() rejects the whole batch if any call
 * in it errors, and the role lookup succeeding is what tells this whether a
 * page is even worth requesting.
 */
export async function backfillSentRecipients(input: {
  jmap: JmapClient;
  auth: JmapAuth;
  session: JmapSession;
  userId: string;
  ownerEmails: string[];
  sentRecipients: SentRecipientsRepo;
  userPreferences: UserPreferencesRepo;
}): Promise<void> {
  try {
    if ((await input.userPreferences.getSentRecipientsBackfilledAt(input.userId)) !== null) return;

    const accountId = input.session.accountId;
    const roleLookup = await input.jmap.request(input.auth, input.session, [
      ["Mailbox/get", { accountId, properties: ["id", "role"] }, "mb"],
    ]);
    const mailboxes = ((roleLookup[0]?.[1] ?? {}) as { list?: BackfillMailbox[] }).list ?? [];
    const sentMailboxId = mailboxes.find((m) => m.role === "sent")?.id;

    if (sentMailboxId) {
      const responses = await input.jmap.request(input.auth, input.session, [
        [
          "Email/query",
          {
            accountId,
            filter: { inMailbox: sentMailboxId },
            sort: [{ property: "receivedAt", isAscending: false }],
            position: 0,
            limit: SENT_RECIPIENTS_BACKFILL_LIMIT,
            calculateTotal: false,
          },
          "q",
        ],
        [
          "Email/get",
          {
            accountId,
            "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
            properties: ["id", "mailboxIds", "to", "cc", "bcc"],
          },
          "g",
        ],
      ]);
      const emails = ((responses[1]?.[1] ?? {}) as { list?: HarvestEmail[] }).list ?? [];
      // The query was scoped to Sent, so every message qualifies — but a
      // server that omits `mailboxIds` from the get would make the shared
      // extractor drop them all. Stamp the membership the query already proved.
      const inSent = emails.map((email) => ({
        ...email,
        mailboxIds: { ...(email.mailboxIds ?? {}), [sentMailboxId]: true },
      }));
      const recipients = extractSentRecipients(inSent, mailboxes, input.ownerEmails);
      if (recipients.size > 0) {
        await input.sentRecipients.record(input.userId, [...recipients]);
      }
    }

    await input.userPreferences.markSentRecipientsBackfilled(input.userId);
  } catch (error) {
    log("warn", "sent recipients backfill failed", {
      userId: input.userId,
      error: String(error),
    });
  }
}
