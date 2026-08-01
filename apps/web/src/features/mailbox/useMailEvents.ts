import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

const RETRY_DELAY_MS = 15000;

// Query keys reachable from this stream. The server substitutes {types} with
// "Email,Mailbox" when it opens the upstream JMAP EventSource (see the /events
// handler in apps/server/src/modules/mail/router.ts), so a change to
// identities, preferences or signatures cannot arrive here at all — refetching
// them on a mail event is provably wasted work, not caution.
// Exported so the mutation paths can reuse the exact same narrowing instead of
// each re-deriving (or, as ThreadView did until GH #227, skipping) it — one
// definition of "what a change to an email or a mailbox can possibly affect".
export const EMAIL_QUERY_KEYS = [
  ["mail", "messages"],
  ["mail", "thread"],
];
export const MAILBOX_QUERY_KEYS = [["mail", "mailboxes"]];
const ALL_MAIL_DATA_KEYS = [...EMAIL_QUERY_KEYS, ...MAILBOX_QUERY_KEYS];

/**
 * Query keys a JMAP StateChange (RFC 8620 §7.1) should invalidate, derived from
 * the types whose state actually moved.
 *
 * This used to be one `invalidateQueries({ queryKey: ["mail"] })` per event,
 * which swept the whole namespace: mailboxes, identities, preferences, the open
 * thread, and every page already loaded by the infinite listing. A user who had
 * scrolled N pages paid N refetches of /api/mail/messages for a single arriving
 * message — and each of those refetches costs the server another JMAP round
 * trip plus a session lookup and a credential decrypt. One incoming mail
 * multiplied into a burst of work (GH #167).
 *
 * A payload we cannot read falls back to every mail-data key rather than to
 * nothing: refetching a little too much beats leaving the user in front of a
 * mailbox that silently stopped updating. It is still far narrower than the old
 * sweep.
 */
export function invalidationKeysForStateChange(raw: string): string[][] {
  let changed: unknown;
  try {
    changed = (JSON.parse(raw) as { changed?: unknown }).changed;
  } catch {
    return ALL_MAIL_DATA_KEYS;
  }
  if (typeof changed !== "object" || changed === null) return ALL_MAIL_DATA_KEYS;

  // A StateChange reports per account; a single session can hold more than one,
  // so the types are the union across all of them.
  const types = new Set<string>();
  for (const perAccount of Object.values(changed as Record<string, unknown>)) {
    if (typeof perAccount !== "object" || perAccount === null) continue;
    for (const type of Object.keys(perAccount)) types.add(type);
  }

  const keys = [
    ...(types.has("Email") ? EMAIL_QUERY_KEYS : []),
    ...(types.has("Mailbox") ? MAILBOX_QUERY_KEYS : []),
  ];
  return keys.length > 0 ? keys : ALL_MAIL_DATA_KEYS;
}

export function useMailEvents(enabled: boolean): void {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") return undefined;

    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    function handleMessage(event: MessageEvent<string>) {
      for (const queryKey of invalidationKeysForStateChange(event.data ?? "")) {
        queryClient.invalidateQueries({ queryKey });
      }
      if (
        document.hidden &&
        typeof Notification !== "undefined" &&
        Notification.permission === "granted"
      ) {
        // eslint-disable-next-line no-new
        new Notification(tRef.current("mail.newMailNotification"));
      }
    }

    function handleError() {
      source?.close();
      retryTimer = setTimeout(connect, RETRY_DELAY_MS);
    }

    function connect() {
      if (cancelled) return;
      source = new EventSource("/api/mail/events");
      source.addEventListener("message", handleMessage);
      source.addEventListener("error", handleError);
    }

    connect();

    return () => {
      cancelled = true;
      source?.close();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [enabled, queryClient]);
}
