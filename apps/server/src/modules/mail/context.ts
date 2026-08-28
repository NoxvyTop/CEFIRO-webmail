import type { MiddlewareHandler } from "hono";
import { errorResponse } from "../../core/error-response";
import type { PushSender } from "../../core/push";
import type { ContactsRepo } from "../../infra/repos/contacts";
import type { PushSubscriptionsRepo } from "../../infra/repos/push-subscriptions";
import type { MailCredentialsRepo } from "../../infra/repos/mail-credentials";
import type { SentRecipientsRepo } from "../../infra/repos/sent-recipients";
import type { SharedMailboxCopiesRepo } from "../../infra/repos/shared-mailbox-copies";
import type { SignaturesRepo } from "../../infra/repos/signatures";
import type { UserPreferencesRepo } from "../../infra/repos/user-preferences";
import type {
  JmapAuth,
  JmapAuthMode,
  JmapClient,
  JmapSession,
} from "../../infra/jmap/client";
import type { SessionStore } from "../auth/sessions";
import type { AuthVariables } from "../auth/middleware";
import { mailStreams } from "./streams";

export type MailDeps = {
  sessions: SessionStore;
  mailCredentials: MailCredentialsRepo;
  signatures: SignaturesRepo;
  userPreferences: UserPreferencesRepo;
  jmap: JmapClient | null;
  fetchFn?: typeof fetch;
  /**
   * Outbound deadline for the routes that bypass the JMAP client and talk to
   * the provider over raw fetch (event stream, blob upload/download). Defaults
   * to DEFAULT_JMAP_TIMEOUT_MS — see core/deadline.ts (GH #165).
   */
  timeoutMs?: number;
  /**
   * How those same raw-fetch routes present the mailbox credential (GH #35).
   * Defaults to `basic`, which is what every deployment did before the knob
   * existed, so nothing that omits it changes behaviour.
   */
  authMode?: JmapAuthMode;
  /**
   * GH #152: this deployment's own authserv-id (RFC 8601 §5) — the value its
   * receiving MTA / Stalwart stamps into the Authentication-Results header it
   * adds. Only a header whose authserv-id matches this is trusted for the
   * sender-authenticity verdict (see modules/mail/sender-auth.ts). Optional and
   * fail-safe: when unset, every verdict is "unknown", so a sender-forged
   * header can never mint a "verified sender" badge.
   */
  authServId?: string;
  // Optional (GH #124): when wired, sender addresses are harvested into the
  // user's contacts. As of GH #180 this happens once per delivery, off the JMAP
  // event subscription that feeds GET /events, not on every GET /messages read —
  // see modules/mail/contacts-harvest.ts. Left optional, and gated behind an
  // `if (deps.contacts)` at the tap site, so every existing test/deploy that
  // constructs MailDeps without it keeps behaving exactly as before.
  contacts?: ContactsRepo;
  // Optional (GH #314): the addresses the user has written to — Tier A of the
  // sender-trust indicator. Fed from POST /send and from the same mail-arrival
  // tap as `contacts`, read once per GET /threads/:id. Optional for the same
  // reason `contacts` is: every existing test/deploy that omits it keeps
  // behaving exactly as before, with Tier A simply never asserted.
  sentRecipients?: SentRecipientsRepo;
  // Optional (GH #313): the ledger of shared-mailbox copies. The manual
  // copy-to-inbox button writes a `copied` row into it so the automatic
  // delivery cycle (modules/mail/shared-copy/) skips a message the member has
  // already pulled themselves — without it, the two paths copy the same
  // message into the same inbox twice. Optional for the same reason
  // `sentRecipients` is: a deployment that omits it keeps behaving exactly as
  // before, with the button simply recording nothing.
  sharedMailboxCopies?: SharedMailboxCopiesRepo;
  // GH #337: the Web Push emitter's two halves. `pushSubscriptions` is the
  // store of devices to fan out to; `pushClient` is null whenever push is
  // unconfigured (no VAPID keys) — the same "null adapter means off"
  // convention as `jmap` and `aiClient`. Both optional and both required
  // together: with either absent the /events tap behaves exactly as it did
  // before the emitter existed, and no push is ever attempted.
  pushClient?: PushSender | null;
  pushSubscriptions?: PushSubscriptionsRepo;
};

// Narrow slice of MailDeps that requireMail actually needs. Extracted so other
// modules (e.g. modules/ai) that also proxy JMAP calls behind a session can
// reuse requireMail without having to fabricate unrelated deps (signatures,
// userPreferences) just to satisfy the type.
export type JmapAccessDeps = {
  jmap: JmapClient | null;
  mailCredentials: MailCredentialsRepo;
};

export type MailVariables = AuthVariables & {
  jmapAuth: JmapAuth;
  jmapSession: JmapSession;
};

const SESSION_CACHE_TTL_MS = 5 * 60_000;
const sessionCache = new Map<string, { session: JmapSession; fetchedAt: number }>();

/**
 * Drop the cached JMAP session for a user AND close the streams it is already
 * feeding. Must be called whenever the user's mail credentials change or their
 * access is revoked (logout, credential rotation, archive) so a stale session
 * tied to old credentials is not reused.
 *
 * Closing the streams is the second half of that promise and was missing (GH
 * #241): this only ever dropped the cache, which stops the NEXT request from
 * reusing revoked credentials but does nothing to the connection already open.
 * `GET /events` is a single request that then runs for hours, so a stream
 * started before logout kept delivering that mailbox's events afterwards —
 * revoking the session did not revoke the mail.
 */
export function evictMailSession(userId: string): void {
  sessionCache.delete(userId);
  mailStreams.closeUser(userId);
}

/**
 * Why a member's mailbox cannot be reached right now. Both answer 503 on the
 * request path (see requireMail); the background worker (GH #313) treats
 * either as "this member cannot take part in this cycle" and moves on.
 */
export type MailSessionFailure = "mail_not_configured" | "mail_credentials_missing";

export type MailSessionResult =
  | { ok: true; auth: JmapAuth; session: JmapSession }
  | { ok: false; reason: MailSessionFailure };

/**
 * The member's JMAP credential and session, resolved from their stored mailbox
 * credential and the per-user session cache — the exact lookup requireMail
 * has always performed inline, made callable with no request in flight.
 *
 * Extracted for GH #313: the shared-mailbox copy worker needs a member's
 * session (to learn which shared accounts they can reach, and to copy with
 * their credential) long after any request of theirs has ended. It could have
 * kept a cache of its own, but then a member's session would be fetched twice
 * from the provider, and — worse — `evictMailSession` would only ever clear
 * one of the two, so a rotated or revoked credential could keep serving the
 * worker after it stopped serving the user. One cache, one eviction.
 *
 * Deliberately a result rather than a throw for the two configuration
 * failures: requireMail has to answer those with a specific 503 body, and the
 * worker has to skip the member without treating it as an incident. A failure
 * from the provider itself (`getSession` rejecting with `mail_auth_failed` or
 * `stalwart_unavailable`) still propagates as the DomainError it always was.
 */
export async function getMailSession(
  deps: JmapAccessDeps,
  user: { userId: string; email: string },
): Promise<MailSessionResult> {
  if (!deps.jmap) {
    return { ok: false, reason: "mail_not_configured" };
  }
  const password = await deps.mailCredentials.get(user.userId);
  if (password === null) {
    return { ok: false, reason: "mail_credentials_missing" };
  }
  const auth: JmapAuth = { email: user.email, password };
  const cached = sessionCache.get(user.userId);
  let session: JmapSession;
  if (cached && Date.now() - cached.fetchedAt < SESSION_CACHE_TTL_MS) {
    session = cached.session;
  } else {
    session = await deps.jmap.getSession(auth);
    sessionCache.set(user.userId, { session, fetchedAt: Date.now() });
  }
  return { ok: true, auth, session };
}

export function requireMail(
  deps: JmapAccessDeps,
): MiddlewareHandler<{ Variables: MailVariables }> {
  return async (c, next) => {
    const resolved = await getMailSession(deps, c.get("user"));
    if (!resolved.ok) {
      return errorResponse(c, resolved.reason, 503);
    }
    c.set("jmapAuth", resolved.auth);
    c.set("jmapSession", resolved.session);
    await next();
  };
}
