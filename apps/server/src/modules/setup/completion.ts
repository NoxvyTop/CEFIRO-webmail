import type { SsoConfigRepo } from "../../infra/repos/sso-config";
import type { UsersRepo } from "../../infra/repos/users";

/**
 * Whether this instance has already finished its first-run setup (GH #234).
 *
 * The setup router used to be gated by ONE thing, the `BOOTSTRAP_MODE`
 * environment flag. A flag left on in production is not a stale toggle, it is a
 * standing offer: whoever holds the setup token can repoint the IdP and mint a
 * `role:"admin"` user, unauthenticated. This is the second gate, and unlike the
 * flag it cannot be forgotten, because it is not configuration at all — it is
 * read back from the same two facts `GET /status` already reports.
 */
export type SetupCompletion = {
  isComplete(): Promise<boolean>;
};

/**
 * The two repository reads the latch is derived from — narrowed to the single
 * method each, so a test can stand in for them with two functions and no cast.
 */
export type SetupCompletionDeps = {
  users: Pick<UsersRepo, "countActiveAdmins">;
  ssoConfig: Pick<SsoConfigRepo, "exists">;
};

/**
 * Derives the latch from persisted state — an ACTIVE admin exists and SSO is
 * configured — rather than from a column written once by a "finish" button.
 *
 * Deriving it is what makes it survive a restart, a redeploy and a rollback
 * with nothing to migrate and no flag that can disagree with reality. The two
 * conditions are required TOGETHER, and that pairing is what keeps the gate
 * from locking an operator out mid-wizard: the moment it closes, this instance
 * has an administrator who can sign in through the IdP and reach the admin
 * console, which does everything the wizard does (PUT /api/admin/sso, POST
 * /api/admin/users) with a session behind it instead of a shared token. Losing
 * the wizard at that point costs an operator nothing; keeping it costs them the
 * instance. Archived admins do not count — an account nobody can sign in to is
 * not a way back in.
 *
 * Latching in memory once it reads true makes it one-way for the life of the
 * process: an instance cannot be walked BACK to "not set up" by deleting the
 * SSO row under a running server, and a closed setup router stops querying
 * Postgres on every request for an answer that can no longer change.
 */
export function createSetupCompletion(deps: SetupCompletionDeps): SetupCompletion {
  let latched = false;
  return {
    async isComplete(): Promise<boolean> {
      if (latched) return true;
      const [activeAdmins, ssoConfigured] = await Promise.all([
        deps.users.countActiveAdmins(),
        deps.ssoConfig.exists(),
      ]);
      latched = activeAdmins > 0 && ssoConfigured;
      return latched;
    },
  };
}
