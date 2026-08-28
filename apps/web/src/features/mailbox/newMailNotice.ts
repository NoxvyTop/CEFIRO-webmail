import type { QueryClient } from "@tanstack/react-query";
import type { Mailbox } from "@webmail/shared";
import { getExistingPushSubscription } from "../notifications/push";

// GH #338: deciding when an in-tab "Correo nuevo" alert is warranted.
//
// It used to fire on any StateChange frame that mentioned `Email` — a flag
// flipped in another tab, a message moved or deleted, a message SENT, and every
// change in every shared account the session can reach. None of those is new
// mail. The only thing that is: the personal Inbox's unread count going UP.

/**
 * The personal account's mailboxes, as MailPage keys them (the third segment is
 * the active shared account, `null` for the user's own). Spelled out here so
 * the notice reads exactly the entry the sidebar's unread badge renders from,
 * and never a shared account's.
 */
export const PERSONAL_MAILBOXES_QUERY_KEY = ["mail", "mailboxes", null] as const;

/** One notification per window, however many messages land inside it. */
export const NEW_MAIL_NOTICE_DEBOUNCE_MS = 10_000;

/**
 * Collapses repeats into one notification instead of stacking them. A constant
 * tag (not a per-thread one) because this alert is about the mailbox, not about
 * any single message: five arrivals must replace each other, not pile up.
 */
export const NEW_MAIL_NOTICE_TAG = "cefiro-new-mail";

/**
 * The personal Inbox's unread count from cache, or null when it is unknown
 * (mailboxes not loaded yet, or an account with no Inbox role). Null is a real
 * answer and deliberately not 0: "we do not know" must never look like a drop
 * to zero, which would make the next load look like an arrival.
 */
export function inboxUnreadCount(client: QueryClient): number | null {
  const mailboxes = client.getQueryData<Mailbox[]>(PERSONAL_MAILBOXES_QUERY_KEY);
  if (!mailboxes) return null;
  const inbox = mailboxes.find((mailbox) => mailbox.role === "inbox");
  return inbox ? inbox.unreadEmails : null;
}

/**
 * Build the "new mail" notifier for one live stream.
 *
 * `now` is injectable so the debounce is asserted against a pinned clock rather
 * than by sleeping; `translate` keeps i18n out of this module (the hook holds
 * the live `t`).
 */
export function createNewMailNotice(input: {
  translate: (count: number) => { title: string; body: string };
  now?: () => number;
}): (before: number | null, after: number | null) => Promise<void> {
  const now = input.now ?? (() => Date.now());
  let lastNotifiedAt: number | null = null;

  return async (before, after) => {
    if (before === null || after === null || after <= before) return;
    // An alert the user is already looking at is noise; the title/favicon badge
    // covers the foreground case (see useUnreadBadge).
    if (!document.hidden) return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;

    const at = now();
    if (lastNotifiedAt !== null && at - lastNotifiedAt < NEW_MAIL_NOTICE_DEBOUNCE_MS) return;

    // With Web Push active the service worker already shows this exact message,
    // so firing here too would buzz the user twice for one arrival. A failed
    // lookup is treated as "no subscription": one notification too many beats
    // silently dropping the only one.
    try {
      if (await getExistingPushSubscription()) return;
    } catch {
      // fall through and notify
    }

    lastNotifiedAt = at;
    const { title, body } = input.translate(after - before);
    new Notification(title, { body, tag: NEW_MAIL_NOTICE_TAG });
  };
}
