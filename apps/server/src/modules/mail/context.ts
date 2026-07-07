import type { MiddlewareHandler } from "hono";
import type { MailCredentialsRepo } from "../../infra/repos/mail-credentials";
import type { SignaturesRepo } from "../../infra/repos/signatures";
import type { UserPreferencesRepo } from "../../infra/repos/user-preferences";
import type { JmapAuth, JmapClient, JmapSession } from "../../infra/stalwart/jmap";
import type { SessionStore } from "../auth/sessions";
import type { AuthVariables } from "../auth/middleware";

export type MailDeps = {
  sessions: SessionStore;
  mailCredentials: MailCredentialsRepo;
  signatures: SignaturesRepo;
  userPreferences: UserPreferencesRepo;
  jmap: JmapClient | null;
  fetchFn?: typeof fetch;
};

export type MailVariables = AuthVariables & {
  jmapAuth: JmapAuth;
  jmapSession: JmapSession;
};

const SESSION_CACHE_TTL_MS = 5 * 60_000;
const sessionCache = new Map<string, { session: JmapSession; fetchedAt: number }>();

export function requireMail(
  deps: MailDeps,
): MiddlewareHandler<{ Variables: MailVariables }> {
  return async (c, next) => {
    if (!deps.jmap) {
      return c.json(
        { code: "mail_not_configured", message: "errors.mail_not_configured", traceId: c.get("traceId") },
        503,
      );
    }
    const user = c.get("user");
    const password = await deps.mailCredentials.get(user.userId);
    if (password === null) {
      return c.json(
        { code: "mail_credentials_missing", message: "errors.mail_credentials_missing", traceId: c.get("traceId") },
        503,
      );
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
