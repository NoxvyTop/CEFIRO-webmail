// GH #314: the curated seed of trusted-service domains (Tier B of the sender
// trust indicator). A message whose From domain is one of these — or a
// subdomain of one, e.g. `noreply.github.com` under `github.com` — AND whose
// DMARC verdict is "pass" is shown to the reader as a trusted service. Either
// half alone is worthless: DMARC pass without a recognised domain is just an
// authenticated stranger, and a recognised domain without DMARC pass is
// exactly what a spoofed message looks like. See sender-trust.ts.
//
// Admission rule for this list — every entry must satisfy all three:
//
//  1. A large provider whose transactional/security mail (password resets,
//     sign-in alerts, invoices, 2FA codes) is a common phishing target, so
//     telling the genuine article apart has real value for the reader.
//  2. The provider publishes an enforcing DMARC policy (p=quarantine or
//     p=reject) on the domain, so a DMARC "pass" on it is a meaningful
//     statement that the visible From address was not forged. RFC 7489 §6.6.2:
//     DMARC pass already requires the authenticated identifier to ALIGN with
//     the RFC5322.From domain, which is why no DKIM d= parsing is needed here.
//  3. The provider actually sends user-facing mail from that organisational
//     domain or its subdomains. A brand that sends from a separate
//     marketing-only domain does not belong here under its brand domain.
//
// Deliberately not BIMI (RFC draft-brand-indicators): BIMI would fetch a logo
// from a sender-published DNS record, which means an outbound request per
// sender and a rendering surface the sender controls. This list is static,
// ships with the server, and renders a fixed icon plus the REAL domain.
//
// The list is exposed read-only (`GET /api/mail/trusted-services` returns it
// as `seed`) and frozen at runtime — a per-user "stop trusting github.com" is
// refused with 409 by the route, because a seed entry removed for one user
// would make the same message read as less trustworthy for them than for
// their neighbour, with no way to see why. Users extend it through their own
// list (user_preferences.trustedServices), never edit it.
//
// Entries are stored lowercase with no leading dot, which the seed test pins:
// the compare in sender-trust.ts is exact-or-subdomain on lowercased input,
// so an entry in any other form would silently never match.

const SEED_DOMAINS = [
  "github.com",
  "google.com",
  "microsoft.com",
  "apple.com",
  "cloudflare.com",
  "amazon.com",
  "paypal.com",
  "stripe.com",
  "atlassian.com",
  "slack.com",
  "zoom.us",
  "dropbox.com",
  "linkedin.com",
  "x.com",
  "meta.com",
  "facebook.com",
  "instagram.com",
  "netflix.com",
  "spotify.com",
  "digitalocean.com",
  "hetzner.com",
  "ovh.com",
  "contabo.com",
  "letsencrypt.org",
] as const;

// Object.freeze on a Set only freezes its own properties; the internal
// collection is still mutable through the prototype's add/delete/clear. The
// mutators are shadowed with throwing own properties BEFORE freezing so that
// the freeze pins them and the set genuinely cannot be widened at runtime.
function freezeSet(values: Iterable<string>): ReadonlySet<string> {
  const set = new Set(values);
  const refuse = (): never => {
    throw new TypeError("TRUSTED_SERVICES_SEED is immutable");
  };
  Object.defineProperties(set, {
    add: { value: refuse, writable: false, configurable: false },
    delete: { value: refuse, writable: false, configurable: false },
    clear: { value: refuse, writable: false, configurable: false },
  });
  return Object.freeze(set);
}

export const TRUSTED_SERVICES_SEED: ReadonlySet<string> = freezeSet(SEED_DOMAINS);
