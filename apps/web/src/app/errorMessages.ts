import i18n from "./i18n";

/**
 * The namespaces that carry a user-facing `<namespace>.errors.*` message set
 * for a server error code. Each one MUST define `<namespace>.errors.generic`,
 * which is what an unmapped code resolves to.
 */
export type ErrorNamespace = "mail" | "composer" | "settings";

/**
 * Every `code` the server can put in an ApiError envelope
 * (packages/shared/src/api/envelope.ts) on a route this app calls — the mail,
 * reader, composer and settings endpoints (filters/sieve, vacation, profile,
 * contacts), plus the codes their shared infrastructure and the global error
 * handler can raise on any of them (`internal`, `not_found`, `unauthorized`,
 * `payload_too_large`, `upstream_timeout`, `database_unavailable`).
 *
 * This is the wire contract, not an allowlist: nothing here gates what gets
 * shown — errorMessageKey below resolves any code at all. It exists so the
 * coverage test in error-messages.test.ts can walk the real set and fail if a
 * code would reach the user without a message behind it, which is exactly how
 * `mail.errors.jmap_error` ended up rendered verbatim (GH #215).
 *
 * `generic` and `network_error` are raised client-side (see mailbox/api.ts and
 * composer/api.ts) rather than by the server, but they travel the same path and
 * need the same guarantee.
 */
export const SERVER_ERROR_CODES = [
  "ai_disabled",
  "ai_provider_error",
  "ai_rate_limited",
  // GH #255: the settings routes' own codes. They travel the same envelope as
  // the rest, so the coverage walk below has to see them or a settings code
  // could reach the user with nothing behind it — the exact failure #215 fixed
  // for `mail` and `composer`.
  "contact_exists",
  "database_unavailable",
  "destroy_failed",
  "generic",
  "internal",
  "invalid_body",
  "invalid_identity",
  "invalid_order",
  "invalid_query",
  "jmap_error",
  "mail_auth_failed",
  "mail_credentials_missing",
  "mail_not_configured",
  "mailbox_roles_missing",
  "network_error",
  "not_found",
  "not_in_trash",
  "payload_too_large",
  "save_draft_failed",
  "send_failed",
  "sieve_invalid",
  "sieve_sync_failed",
  "stalwart_unavailable",
  "unauthorized",
  "update_failed",
  "upstream_timeout",
] as const;

export type ServerErrorCode = (typeof SERVER_ERROR_CODES)[number];

function genericKey(namespace: ErrorNamespace): string {
  return `${namespace}.errors.generic`;
}

/**
 * The single code → message-key map (GH #215).
 *
 * Before this, each caller kept its own idea of the mapping and the two halves
 * were broken in opposite directions: mailbox/queryErrors.ts hard-coded a
 * two-entry allowlist, so eight `mail.errors.*` messages that already existed
 * (`upstream_timeout`, `database_unavailable`, `not_in_trash`,
 * `destroy_failed`, …) could never be reached; while ThreadView and
 * useComposer interpolated the raw code into a key with no existence check at
 * all, so an unmapped one was rendered to the user as the literal string
 * `mail.errors.jmap_error`.
 *
 * The map is the translation bundle itself — `i18n.exists`, which also honours
 * the `en` fallback language — rather than a second, hand-maintained list
 * beside it. A message that exists is therefore connected by definition, and
 * adding one to the locale files is all it takes to light up a code. Anything
 * genuinely unmapped resolves to the namespace's generic message, never to a
 * key.
 */
export function errorMessageKey(
  namespace: ErrorNamespace,
  code: string | null | undefined,
): string {
  if (!code) return genericKey(namespace);
  const key = `${namespace}.errors.${code}`;
  return i18n.exists(key) ? key : genericKey(namespace);
}
