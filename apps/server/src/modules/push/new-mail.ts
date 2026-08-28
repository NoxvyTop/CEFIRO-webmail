/**
 * The Web Push EMITTER (GH #337). The delivery slice of #294 built everything
 * except this: `PushSender.send` had no caller, so every subscription stored by
 * `POST /api/push/subscribe` was written and never read.
 *
 * What triggers it is the design doc's "camino B" (docs/design/push-notifications.md
 * → Detection): the account's JMAP `Email` state advancing on the EventSource
 * subscription, observed by `tapEmailStateChanges`. The Stalwart `store.ingest`
 * webhook — the doc's primary path — is still blocked on the payload spike, and
 * this needs neither a webhook nor new configuration.
 *
 * "New mail" is decided from `Email/changes`, not from a listing:
 *
 *   - `created` is the only thing that means a message came into existence, so
 *     a flag flip, a move, or a read receipt (which arrive as `updated`) can
 *     never produce a notification. That was the whole defect of the in-tab
 *     notice this replaces.
 *   - a created id still has to be IN the Inbox and still unread to count: a
 *     message the user just sent is created in Sent, a filed copy lands
 *     elsewhere, and a copy that arrives with `$seen` is not news.
 *
 * Cost discipline: ONE JMAP batch per state change, and only when the user
 * actually has a subscription to push to. The batch is `Email/changes` +
 * a back-referenced `Email/get` + the account's mailbox roles — never a full
 * `Email/query` listing, which is what makes this affordable on a hot stream.
 *
 * Privacy discipline (core/push.ts): the payload carries the sender's display
 * name, a truncated subject and the routing ids. Never a message body.
 */

import { log } from "../../core/logger";
import type { PushPayload, PushSender } from "../../core/push";
import type { JmapAuth, JmapClient, JmapSession } from "../../infra/jmap/client";
import type { PushSubscriptionsRepo } from "../../infra/repos/push-subscriptions";

/**
 * Ceiling on the ids one `Email/changes` may hand back. A delivery is normally
 * one or a few messages; this only bounds the read when a burst (or a long
 * silence) piles up, so the batch can never grow without limit.
 */
export const NEW_MAIL_MAX_CHANGES = 50;

/**
 * How many of those become notifications. Twenty messages arriving at once must
 * not become twenty buzzes on a phone; the rest are visible in the mailbox the
 * notification opens.
 */
export const NEW_MAIL_MAX_NOTIFICATIONS = 5;

/** Subject characters kept in the body, ellipsis included. */
export const NEW_MAIL_SUBJECT_MAX = 120;

/**
 * Ceiling on the per-stream "already notified" set. A stream can stay open for
 * hours, so the set is emptied once it grows past this rather than retaining an
 * id per message forever — re-notifying an id from before the reset is possible
 * in theory and harmless in practice (the message would have to change state
 * again to be re-observed at all).
 */
export const NEW_MAIL_SEEN_LIMIT = 500;

/** The slice of an Email the notification composer reads. */
export type NewMailEmail = {
  id: string;
  threadId?: string;
  subject?: string | null;
  from?: { name?: string | null; email: string }[];
  mailboxIds?: Record<string, boolean>;
  keywords?: Record<string, boolean>;
};

type ChangesResponse = { created?: string[] };
type EmailGetResponse = { list?: NewMailEmail[] };
type MailboxGetResponse = { list?: { id: string; role?: string | null }[] };

function truncateSubject(subject: string): string {
  if (subject.length <= NEW_MAIL_SUBJECT_MAX) return subject;
  return `${subject.slice(0, NEW_MAIL_SUBJECT_MAX - 1)}…`;
}

/**
 * Compose the notification for one message. Pure, so the privacy contract (what
 * a push is allowed to say) is asserted directly in tests rather than inferred
 * from a delivery.
 */
export function newMailPayload(email: NewMailEmail, sharedAccountId?: string): PushPayload {
  const sender = email.from?.[0];
  const title = sender?.name?.trim() || sender?.email?.trim() || "Céfiro";
  const subject = email.subject?.trim() ?? "";
  const payload: PushPayload = { title, body: subject === "" ? "" : truncateSubject(subject) };
  if (email.threadId) payload.targetId = email.threadId;
  // Only a shared account is named: the personal one is the service worker's
  // default, and spelling it out would push every notification through the
  // shared-mailbox view for no reason (GH #337).
  if (sharedAccountId) payload.accountId = sharedAccountId;
  return payload;
}

/** A created id only counts when it is sitting unread in the Inbox. */
function isNewInboxMail(email: NewMailEmail, inboxId: string): boolean {
  if (email.mailboxIds?.[inboxId] !== true) return false;
  return email.keywords?.$seen !== true;
}

/**
 * Fan one payload out to every live subscription, pruning the dead ones.
 *
 * `410 Gone` / `404` is the push service saying the subscription will never
 * work again (see infra/push/web-push.ts): the row is deleted AND the endpoint
 * is dropped from `subscriptions` so the rest of this batch does not keep
 * pushing to it. A `failed` is transient and keeps the device.
 */
async function fanOut(
  input: {
    pushClient: PushSender;
    pushSubscriptions: PushSubscriptionsRepo;
  },
  subscriptions: { endpoint: string; p256dh: string; auth: string }[],
  payload: PushPayload,
): Promise<void> {
  for (const subscription of [...subscriptions]) {
    const result = await input.pushClient.send(subscription, payload);
    if (result !== "expired") continue;
    const index = subscriptions.indexOf(subscription);
    if (index !== -1) subscriptions.splice(index, 1);
    await input.pushSubscriptions.deleteByEndpoint(subscription.endpoint);
  }
}

/**
 * Push "you have new mail" for everything created in the account's Inbox since
 * `sinceState`, once per message and once per device.
 *
 * `seen` is the caller's dedupe set, owned per stream: the same message can be
 * reported by more than one state change (a second change lands before the
 * first batch resolves, a reconnect replays), and a device must be buzzed once.
 *
 * Never throws. Everything here is best-effort decoration on a stream whose job
 * is to proxy mail events; a JMAP hiccup, a push service outage or a repo error
 * is logged and swallowed exactly as the contact harvest does.
 */
export async function notifyNewMail(input: {
  pushClient: PushSender;
  pushSubscriptions: PushSubscriptionsRepo;
  jmap: JmapClient;
  auth: JmapAuth;
  session: JmapSession;
  userId: string;
  /**
   * The account whose Inbox is being watched. Defaults to the session's own —
   * the only thing the /events tap watches today — and exists so a future
   * shared-mailbox trigger reads and addresses that account instead, without
   * this function having to learn a second shape.
   */
  accountId?: string;
  /** The Email state the account was at BEFORE the change being handled. */
  sinceState: string;
  seen: Set<string>;
}): Promise<void> {
  try {
    // Asked first, and the only thing asked when it is empty: a user with no
    // device subscribed must cost this stream nothing at all.
    const subscriptions = await input.pushSubscriptions.listByUser(input.userId);
    if (subscriptions.length === 0) return;

    const accountId = input.accountId ?? input.session.accountId;
    const sharedAccountId = accountId === input.session.accountId ? undefined : accountId;
    const responses = await input.jmap.request(input.auth, input.session, [
      [
        "Email/changes",
        { accountId, sinceState: input.sinceState, maxChanges: NEW_MAIL_MAX_CHANGES },
        "c",
      ],
      [
        "Email/get",
        {
          accountId,
          "#ids": { resultOf: "c", name: "Email/changes", path: "/created" },
          properties: ["id", "threadId", "subject", "from", "mailboxIds", "keywords"],
        },
        "g",
      ],
      ["Mailbox/get", { accountId, properties: ["id", "role"] }, "mb"],
    ]);

    const created = ((responses[0]?.[1] ?? {}) as ChangesResponse).created ?? [];
    if (created.length === 0) return;

    const inboxId = (((responses[2]?.[1] ?? {}) as MailboxGetResponse).list ?? []).find(
      (mailbox) => mailbox.role === "inbox",
    )?.id;
    if (!inboxId) return;

    const emails = ((responses[1]?.[1] ?? {}) as EmailGetResponse).list ?? [];
    const fresh = emails
      .filter((email) => !input.seen.has(email.id) && isNewInboxMail(email, inboxId))
      .slice(0, NEW_MAIL_MAX_NOTIFICATIONS);

    // Every created id is remembered, not only the notified ones: a message
    // that was filed elsewhere or arrived read has been judged, and judging it
    // again on the next state change would be wasted work.
    if (input.seen.size > NEW_MAIL_SEEN_LIMIT) input.seen.clear();
    for (const id of created) input.seen.add(id);

    for (const email of fresh) {
      await fanOut(input, subscriptions, newMailPayload(email, sharedAccountId));
    }
  } catch (error) {
    log("warn", "new mail push notification failed", {
      userId: input.userId,
      error: String(error),
    });
  }
}

/**
 * Bind the notifier to one open event stream: the dedupe set lives as long as
 * the connection, and the caller only has to hand over the state that moved.
 *
 * Returns undefined when push is not configured (no VAPID keys), so the tap
 * site can skip wiring it at all rather than calling a no-op per frame.
 */
export function createNewMailNotifier(input: {
  pushClient: PushSender | null;
  pushSubscriptions: PushSubscriptionsRepo;
  jmap: JmapClient;
  auth: JmapAuth;
  session: JmapSession;
  userId: string;
}): ((change: { previousState: string }) => Promise<void>) | undefined {
  const pushClient = input.pushClient;
  if (!pushClient) return undefined;
  const seen = new Set<string>();
  return (change) =>
    notifyNewMail({
      pushClient,
      pushSubscriptions: input.pushSubscriptions,
      jmap: input.jmap,
      auth: input.auth,
      session: input.session,
      userId: input.userId,
      sinceState: change.previousState,
      seen,
    });
}
