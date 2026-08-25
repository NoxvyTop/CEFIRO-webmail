import { Hono } from "hono";
import { trustedServicesSchema, type TrustedServices } from "@webmail/shared";
import { normalizeDomainName } from "../../core/domain-name";
import { errorResponse } from "../../core/error-response";
import type { UserPreferencesRepo } from "../../infra/repos/user-preferences";
import type { MailVariables } from "./context";
import { TRUSTED_SERVICES_SEED } from "./trusted-services-seed";

// GH #314: the trusted-services list behind Tier B of the sender-trust
// indicator — the curated seed the server ships (trusted-services-seed.ts)
// plus the domains this user confirmed from the reader's "Trust <domain>"
// affordance. Mounted under /api/mail/trusted-services by createMailRouter,
// which already applies requireSession to everything beneath it; nothing here
// touches JMAP, so the routes deliberately do NOT sit behind requireMail — a
// user whose mailbox credential is missing can still see and edit their list.
//
// Its own sub-router rather than three more handlers in router.ts: that file
// is the JMAP proxy and is already long; this is app-side preference state,
// closer to /preferences than to /threads, and it reads better as one unit
// next to the seed it complements.
//
// Why the user's list is stored inside user_preferences.preferences (jsonb)
// instead of its own table, and why every write is read-modify-write: it
// mirrors sharedMailboxCopyOptIn (GH #13/#50 G-3) exactly. The jsonb `||`
// merge the repo performs is SHALLOW — writing `{ trustedServices: [...] }`
// replaces the whole array, it does not append — so the route reads the
// current list, edits it in memory and writes the full result back. A
// separate table would buy nothing here: the list is small (capped at 200 by
// the repo's parse), only ever read whole, and never joined.
//
// The `:domain` parameter is untrusted input. It is normalised through
// normalizeDomainName (lowercase, trim, strict hostname shape) BEFORE it is
// compared with the seed or stored, so "GitHub.com" and "github.com" are one
// entry and a value like "com", "*.evil.test" or "user@evil.test" is refused
// with 400 invalid_domain rather than silently stored as an entry that could
// later match too much (or nothing). See core/domain-name.ts.
export function createTrustedServicesRouter(deps: { userPreferences: UserPreferencesRepo }) {
  const router = new Hono<{ Variables: MailVariables }>();

  // Sorted so the response is stable across restarts and the client can diff
  // it without caring about Set insertion order.
  const seed = [...TRUSTED_SERVICES_SEED].sort();

  function respond(user: string[]): TrustedServices {
    return trustedServicesSchema.parse({ seed, user });
  }

  router.get("/", async (c) => {
    const user = c.get("user");
    const preferences = await deps.userPreferences.get(user.userId);
    return c.json(respond(preferences.trustedServices));
  });

  // Idempotent add. A domain already covered by the seed is NOT copied into
  // the user list: it would be redundant (the seed already trusts it) and it
  // would let the client offer "stop trusting" on an entry that DELETE below
  // refuses to remove — the seed check is the same one DELETE applies, so
  // both routes agree on what the user list may contain.
  router.put("/:domain", async (c) => {
    const user = c.get("user");
    const domain = normalizeDomainName(c.req.param("domain"));
    if (domain === null) {
      return errorResponse(c, "invalid_domain", 400);
    }

    const current = await deps.userPreferences.get(user.userId);
    if (TRUSTED_SERVICES_SEED.has(domain) || current.trustedServices.includes(domain)) {
      return c.json(respond(current.trustedServices));
    }
    const updated = await deps.userPreferences.merge(user.userId, {
      trustedServices: [...current.trustedServices, domain],
    });
    return c.json(respond(updated.trustedServices));
  });

  // Removes from the USER list only. A seed entry answers 409
  // trusted_service_seed instead of a silent no-op: the client asked for a
  // state ("this domain is no longer trusted") the server cannot produce, and
  // a 200 here would let the UI show the badge gone until the next reload put
  // it back. Per-user seed edits are out of scope by design — see the seed
  // module header. A domain that is in neither list is a no-op 200, since the
  // requested state already holds.
  router.delete("/:domain", async (c) => {
    const user = c.get("user");
    const domain = normalizeDomainName(c.req.param("domain"));
    if (domain === null) {
      return errorResponse(c, "invalid_domain", 400);
    }
    if (TRUSTED_SERVICES_SEED.has(domain)) {
      return errorResponse(c, "trusted_service_seed", 409);
    }

    const current = await deps.userPreferences.get(user.userId);
    if (!current.trustedServices.includes(domain)) {
      return c.json(respond(current.trustedServices));
    }
    const updated = await deps.userPreferences.merge(user.userId, {
      trustedServices: current.trustedServices.filter((entry) => entry !== domain),
    });
    return c.json(respond(updated.trustedServices));
  });

  return router;
}
