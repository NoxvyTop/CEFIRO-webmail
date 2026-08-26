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

// GH #314: how long a FAILED pass suppresses the next one. This runs inline on
// the thread route's critical path, so a user whose backfill keeps failing (a
// Sent mailbox the JMAP server errors on, a permission problem, a store that
// keeps throwing) would otherwise pay the whole bounded pass — a Mailbox/get
// plus a 200-message Email/query + Email/get — on EVERY thread they open, with
// no ceiling, for a cosmetic feature. 24 h is far longer than any transient
// hiccup lasts and far shorter than a user's patience for a missing badge.
export const SENT_RECIPIENTS_BACKFILL_RETRY_MS = 24 * 60 * 60 * 1000;

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
 * Never throws, and does NOT mark the user backfilled on failure: the thread
 * route calls this before answering, so an exception here would turn a JMAP or
 * database hiccup into a broken reader for a cosmetic feature. Only a completed
 * pass (or an account with no Sent mailbox at all, where there is nothing to
 * backfill and retrying would only repeat the role lookup forever) marks the
 * user done.
 *
 * A failure IS bounded, though (GH #314, JD-2). Every pass writes
 * `sentRecipientsBackfillAttemptedAt` BEFORE it does any work, and a user who
 * is not yet backfilled but whose last attempt is younger than
 * SENT_RECIPIENTS_BACKFILL_RETRY_MS is skipped. Without that marker a failure
 * left no trace, so a persistently failing backfill re-ran the whole bounded
 * pass inline on EVERY thread read that user made, indefinitely — the retry was
 * unbounded in frequency even though each pass was bounded in size. Marking
 * before rather than after is deliberate: a pass that never returns at all
 * (a hang, a crashed process) must still cost the next read nothing.
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
  /** Injectable clock for the retry window; defaults to the real one. */
  now?: () => Date;
}): Promise<void> {
  try {
    if ((await input.userPreferences.getSentRecipientsBackfilledAt(input.userId)) !== null) return;

    const now = (input.now ?? (() => new Date()))();
    const attemptedAt = await input.userPreferences.getSentRecipientsBackfillAttemptedAt(input.userId);
    if (attemptedAt !== null) {
      const previous = Date.parse(attemptedAt);
      // An unparseable marker reads as "never attempted" rather than as
      // "attempted at NaN", which would suppress the backfill forever.
      if (Number.isFinite(previous) && now.getTime() - previous < SENT_RECIPIENTS_BACKFILL_RETRY_MS) {
        return;
      }
    }
    // Before any work: see the retry-window paragraph above.
    await input.userPreferences.markSentRecipientsBackfillAttempted(input.userId, now.toISOString());

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
