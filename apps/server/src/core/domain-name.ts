// GH #314: canonical form of a domain name for the trusted-services list.
//
// The list is compared against the lowercased domain of a message's From
// address by exact-or-subdomain match (modules/mail/sender-trust.ts), and its
// entries come from two places that cannot be trusted to be tidy: the
// `:domain` URL parameter of PUT/DELETE /api/mail/trusted-services and the
// jsonb column in user_preferences, which anyone with database access can edit
// by hand. Both funnel through this one function so that whatever ends up
// stored — and therefore whatever can mint a "trusted service" badge — is a
// plain, lowercase, dotted hostname and nothing else.
//
// Why a strict shape check rather than "any non-empty string": a value like
// "com" would trust every sender under an entire TLD, "*.evil.test" would read
// as a wildcard to a human reviewing the list while matching nothing (or,
// after a careless refactor, everything), and "user@evil.test" would suggest
// the list holds addresses when it holds domains. Rejecting these outright is
// cheaper than reasoning about each one downstream. The rejected alternative —
// zod's `.url()`/`.email()` style validators — checks the wrong thing: this is
// neither a URL nor an address, it is the RFC 1034 §3.5 "preferred name syntax"
// (letters, digits, hyphens; no hyphen at a label edge; labels of 1-63 octets;
// 253 octets overall), with the extra requirement of at least two labels.

const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_DOMAIN_LENGTH = 253;

/**
 * Returns the trimmed, lowercased domain when `value` is a well-formed
 * multi-label hostname, or null for anything else (non-strings included), so a
 * caller can treat "not a domain" as one branch instead of a thrown error.
 */
export function normalizeDomainName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const domain = value.trim().toLowerCase();
  if (domain.length === 0 || domain.length > MAX_DOMAIN_LENGTH) return null;
  const labels = domain.split(".");
  if (labels.length < 2) return null;
  if (!labels.every((label) => LABEL_PATTERN.test(label))) return null;
  return domain;
}
