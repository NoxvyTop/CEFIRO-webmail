import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AUTH_QUERY_KEY } from "../auth/useAuth";

// The same endpoint the EventSource opens. The probe below re-asks it with
// fetch() precisely because fetch exposes the HTTP status that EventSource hides.
const MAIL_EVENTS_URL = "/api/mail/events";

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
// CLOSED therefore means "the server refused the handshake", but that covers
// three outcomes we must treat differently: the session is gone (401), this
// tab is over the per-user stream cap (429 too_many_streams, GH #241/#274), or
// the server is merely having a bad minute (502/503 while Stalwart restarts).
// So CLOSED is only the trigger to ASK — see classifyRefusedHandshake below.
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
 * Why a refused handshake was refused, recovered by re-asking the SAME endpoint
 * with fetch() — which exposes the status EventSource hides (GH #274).
 *
 * The /events route (apps/server/src/modules/mail/router.ts) registers-or-
 * refuses the per-user stream slot BEFORE it opens the upstream Stalwart
 * connection, so the two statuses we act on come back immediately and cheaply:
 *
 *   - 401  → requireMail rejected it: the session is gone. Stop and re-auth.
 *   - 429  → too_many_streams: this user already holds the 8-stream cap, so
 *            THIS tab cannot go live. Returned without taking a slot, so the
 *            probe adds no load and cannot become a storm. Stop and tell the
 *            user; another tab is holding the stream.
 *   - else → transient (502/503 while the server restarts, or a probe that
 *            could not be made at all — offline). Keep the ordinary backoff:
 *            abandoning the stream on one of those would break precisely the
 *            restart the backoff exists for.
 *
 * A genuine 200 (a slot freed up between the failure and the probe) is the one
 * case that would consume a slot; the request is aborted the moment its headers
 * arrive so the server's disconnect handler releases it again before the
 * reconnect fires, and it is classified "transient" so the reconnect happens.
 */
type HandshakeVerdict = "sessionExpired" | "streamLimited" | "transient";

async function classifyRefusedHandshake(): Promise<HandshakeVerdict> {
  try {
    const controller = new AbortController();
    const res = await fetch(MAIL_EVENTS_URL, {
      headers: { accept: "text/event-stream" },
      signal: controller.signal,
    });
    controller.abort();
    if (res.status === 401) return "sessionExpired";
    if (res.status === 429) return "streamLimited";
    return "transient";
  } catch {
    return "transient";
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

/** What the hook reports back to its one consumer (MailPage). */
export interface MailEventsStatus {
  // GH #274: true once the stream was refused with 429 too_many_streams and the
  // hook gave up retrying — the tab is live-update-limited until it is reloaded.
  liveUpdatesLimited: boolean;
}

export function useMailEvents(enabled: boolean): MailEventsStatus {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
  const [liveUpdatesLimited, setLiveUpdatesLimited] = useState(false);

  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") return undefined;
    // A fresh effect run (re-enabled) starts from a clean slate; the flag only
    // latches back on if this run's stream is refused for the cap again.
    setLiveUpdatesLimited(false);

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
      void classifyRefusedHandshake().then((verdict) => {
        if (cancelled || stopped) return;
        if (verdict === "transient") {
          scheduleRetry();
          return;
        }
        // Both terminal verdicts stop the loop: nothing this tab does on its
        // own can recover, so retrying would be the silent forever-loop #274
        // is about.
        stopped = true;
        if (verdict === "sessionExpired") {
          // Re-read the session so RequireAuth takes the user to the login
          // screen, rather than leaving them in front of a mailbox that has
          // quietly stopped updating.
          queryClient.invalidateQueries({ queryKey: AUTH_QUERY_KEY });
          return;
        }
        // streamLimited: the session is fine and the server is up — another
        // tab simply holds this user's last stream slot. Surface it instead of
        // retrying in silence; reloading once a slot frees up goes live again.
        setLiveUpdatesLimited(true);
      });
    }

    function connect() {
      if (cancelled || stopped) return;
      source = new EventSource("/api/mail/events");
      source.addEventListener("open", handleOpen);
      // JMAP names its push frames `event: state` (RFC 8887 §7.1), and the
      // server proxies Stalwart's stream through untouched. An SSE listener on
      // "message" only ever fires for frames with NO `event:` field, so
      // listening on "message" alone means every StateChange is dropped and the
      // mailbox never updates until a manual reload (GH #265). "message" stays
      // registered for a provider that emits unnamed frames; handleMessage is
      // idempotent, and no server sends both for one change.
      source.addEventListener("state", handleMessage);
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

  return { liveUpdatesLimited };
}
