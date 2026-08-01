import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AUTH_ME_URL, AUTH_QUERY_KEY } from "../auth/useAuth";

// GH #243: the retry used to be a flat 15 s with no jitter at all. A server
// restart drops every open stream at the same instant, so every client came
// back at the same instant too — one synchronised wave of reconnects against a
// server (and the Stalwart behind it) that had only just finished starting,
// which is exactly when it can least absorb one. And a server that stayed down
// took that same wave again every 15 s for as long as it was down.
//
// Equal jitter answers both halves. The window doubles with each consecutive
// failure up to a cap, so a prolonged outage is retried slower and slower
// rather than at a fixed rate; and half of each window is drawn at random, so
// clients knocked offline together do not come back together — and the spread
// widens with every further attempt. Holding the other half fixed puts a floor
// under the delay, so the first retry is never effectively instant.
const RETRY_BASE_DELAY_MS = 2_000;
const RETRY_MAX_DELAY_MS = 60_000;

// EventSource never surfaces the HTTP status of the request that failed: the
// error event carries none, and a 401 arrives looking exactly like a dropped
// socket. What it does expose is readyState — the browser leaves it at
// CONNECTING for a transport-level drop it means to retry, and moves it to
// CLOSED once the server DID answer and the answer was unusable (any non-200,
// a 401 among them).
//
// CLOSED therefore means "the server refused the handshake", which is not the
// same as "the session is gone": a 502/503 from a server still coming back up
// lands there too, and abandoning the stream on one of those would break
// precisely the restart this backoff exists for. So CLOSED is only the trigger
// to ASK — one cheap /api/auth/me settles it, and only an explicit 401 stops
// the stream for good.
//
// Written as the literal 2 rather than EventSource.CLOSED on purpose: that
// constant is read off whichever EventSource is in scope, so a stand-in without
// the statics would compare undefined to undefined and quietly reclassify every
// error as a refused handshake.
const EVENT_SOURCE_CLOSED = 2;

/**
 * Delay before reconnect attempt number `attempt`, counted from the last stream
 * that actually opened. `random` is injectable so tests can pin the curve
 * without stubbing Math.random globally.
 */
export function retryDelayMs(attempt: number, random: number = Math.random()): number {
  const span = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** attempt);
  return Math.round(span / 2 + random * (span / 2));
}

/**
 * Whether the stream failed because the session is gone rather than because the
 * server is having a bad minute. A probe that cannot be made at all (offline,
 * server still down) says nothing about the session, so it answers "no" and
 * lets the ordinary backoff carry on.
 */
async function sessionExpired(): Promise<boolean> {
  try {
    const res = await fetch(AUTH_ME_URL);
    return res.status === 401;
  } catch {
    return false;
  }
}

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
    // Consecutive failures since the last stream that reached "open"; the only
    // input to the backoff curve.
    let attempt = 0;
    // Latched once the session is known to be gone. Nothing can reconnect until
    // the user logs in again, and every attempt in the meantime is one more
    // unauthenticated request against a server that already said no.
    let stopped = false;

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

    // A stream that opened is proof the server is serving again, so the next
    // outage starts its backoff from scratch instead of inheriting the ladder
    // climbed during the previous one.
    function handleOpen() {
      attempt = 0;
    }

    function scheduleRetry() {
      if (cancelled || stopped) return;
      retryTimer = setTimeout(connect, retryDelayMs(attempt));
      attempt += 1;
    }

    function handleError() {
      // Read before close(): closing sets readyState to CLOSED itself, which
      // would make every error look like a refused handshake.
      const refusedHandshake = source?.readyState === EVENT_SOURCE_CLOSED;
      source?.close();
      if (!refusedHandshake) {
        scheduleRetry();
        return;
      }
      void sessionExpired().then((expired) => {
        if (cancelled || stopped) return;
        if (!expired) {
          scheduleRetry();
          return;
        }
        stopped = true;
        // Re-read the session so RequireAuth takes the user to the login
        // screen, rather than leaving them in front of a mailbox that has
        // quietly stopped updating.
        queryClient.invalidateQueries({ queryKey: AUTH_QUERY_KEY });
      });
    }

    function connect() {
      if (cancelled || stopped) return;
      source = new EventSource("/api/mail/events");
      source.addEventListener("open", handleOpen);
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
