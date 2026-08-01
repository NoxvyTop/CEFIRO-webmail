import type { MiddlewareHandler } from "hono";
import { errorResponse } from "../../core/error-response";
import type { ContactsRepo } from "../../infra/repos/contacts";
import type { MailCredentialsRepo } from "../../infra/repos/mail-credentials";
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
  // Optional (GH #124): when wired, sender addresses are harvested into the
  // user's contacts. As of GH #180 this happens once per delivery, off the JMAP
  // event subscription that feeds GET /events, not on every GET /messages read —
  // see modules/mail/contacts-harvest.ts. Left optional, and gated behind an
  // `if (deps.contacts)` at the tap site, so every existing test/deploy that
  // constructs MailDeps without it keeps behaving exactly as before.
  contacts?: ContactsRepo;
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

export function requireMail(
  deps: JmapAccessDeps,
): MiddlewareHandler<{ Variables: MailVariables }> {
  return async (c, next) => {
    if (!deps.jmap) {
      return errorResponse(c, "mail_not_configured", 503);
    }
    const user = c.get("user");
    const password = await deps.mailCredentials.get(user.userId);
    if (password === null) {
      return errorResponse(c, "mail_credentials_missing", 503);
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
    c.set("jmapAuth", auth);
    c.set("jmapSession", session);
    await next();
  };
}
