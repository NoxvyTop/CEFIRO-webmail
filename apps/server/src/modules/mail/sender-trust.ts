import type { SenderAuthVerdict, SenderTrust } from "@webmail/shared";

// GH #314: resolves the reader's POSITIVE-ONLY trust tier for one message.
// Deliberately free of I/O, like deriveSenderAuthVerdict in sender-auth.ts:
// the thread route gathers the two inputs that need a database (the user's
// sent-recipients for the thread's senders, the trusted-domain set) ONCE per
// request and hands them in, so this is a pure function of five values and
// every row of the security contract is a plain unit test.
//
// The contract, and the failure each rule prevents:
//
//  - Trust is ALWAYS gated on senderAuth === "pass". DMARC pass (RFC 7489) is
//    the only signal that the visible From domain was not forged: it requires
//    an SPF or DKIM pass whose identifier ALIGNS with the RFC5322.From domain
//    (§6.6.2). A "known" mark on a DMARC-fail message would be the perfect
//    phishing accessory — the attacker spoofs a colleague's exact address and
//    the reader is told "you have written to this person". A "fail" therefore
//    stays the only negative signal (SenderAuthBadge), and this function never
//    contradicts it: fail or unknown → "none", no matter what the lists say.
//    This is also why no DKIM d= parsing happens here — alignment is DMARC's
//    job, already done, and re-deriving it from raw DKIM results would let a
//    DKIM pass on an unrelated domain count (see senderAuthVerdictSchema).
//
//  - The pass must be BOUND to the address the reader sees. "dmarc=pass" is
//    evidence about the domain DMARC evaluated — the trusted header's own
//    `header.from=` propspec (deriveSenderAuthFacts in sender-auth.ts) — and
//    nothing else. Two rules follow, and both are gates, not refinements:
//    `dmarcFromDomain` must equal the domain of the From address the tier is
//    resolved from, and the message must carry exactly ONE From address.
//    Without the first, a genuine, correctly-signed newsletter from one domain
//    would vouch for a spoofed address at another on the same message. Without
//    the second, RFC 5322's multi-address From (which DMARC evaluates only one
//    of) turns "which address the reader is shown" into a rendering accident —
//    so no tier may be asserted at all.
//
//  - Tier A ("known") requires the EXACT From address to be one the user has
//    written to. Not the domain: a colleague's domain is also every other
//    colleague's, and the spoofed "same company, different mailbox" message is
//    a common lure. Not "is in contacts": contacts-harvest.ts adds every
//    sender that lands in the inbox, so a phisher's second message would read
//    as "known" — the store here is fed only by mail the USER sent
//    (infra/repos/sent-recipients.ts), which a sender cannot trigger.
//
//  - Tier B ("trusted-service") requires the From domain to be a listed
//    domain or a SUBDOMAIN of one (`noreply.github.com` under `github.com`),
//    by label boundary — never a suffix compare, which would let
//    `notgithub.com` or `githiib.com` slip through; never a parent match,
//    which would let `com` trust the world. The list is the curated seed plus
//    the user's confirmed domains (trusted-services.ts).
//
//  - When both tiers apply, "trusted-service" wins: it is the more specific
//    statement (a recognised organisation, not just a past recipient), and
//    the UI renders the domain for it, which is what a reader should verify.
//
//  - "none" is the answer to every doubt — a missing From, an address without
//    a domain, an empty list. It is not a warning; it is the absence of an
//    assertion, exactly like senderAuth "unknown".
//
// Everything is compared lowercased: the stores hold lowercased values (the
// repos normalise on write) and RFC 5321 §2.4 makes the domain part
// case-insensitive; the local part is compared case-insensitively too, since
// the store lowercases it and the same mailbox spelt two ways is one person.

/**
 * The domain part of an address, lowercased, or null when there is none. Uses
 * the LAST "@" so an unusual-but-legal quoted local part containing "@" does
 * not yield a bogus domain.
 */
export function domainOf(email: string | undefined | null): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain === "" ? null : domain;
}

/**
 * Whether `domain` is one of `trusted` or a subdomain of one, compared on
 * label boundaries and lowercased. `trusted` is expected to hold canonical
 * (lowercased) entries — both the seed and the stored user list are.
 */
export function matchesTrustedDomain(domain: string, trusted: ReadonlySet<string>): boolean {
  if (trusted.size === 0) return false;
  const lower = domain.toLowerCase();
  if (trusted.has(lower)) return true;
  // Walk up the label chain: a.b.c → b.c → c. Each step is a whole-label
  // boundary, so "notgithub.com" never reaches "github.com".
  let dot = lower.indexOf(".");
  while (dot >= 0) {
    const parent = lower.slice(dot + 1);
    if (trusted.has(parent)) return true;
    dot = lower.indexOf(".", dot + 1);
  }
  return false;
}

export function resolveSenderTrust(input: {
  senderAuth: SenderAuthVerdict;
  fromEmail: string | undefined | null;
  /** How many addresses the message's From header carries (`email.from.length`). */
  fromCount: number;
  /** The domain the trusted DMARC result was ABOUT — deriveSenderAuthFacts. */
  dmarcFromDomain: string | null;
  knownRecipients: ReadonlySet<string>;
  trustedDomains: ReadonlySet<string>;
}): SenderTrust {
  // The gate: nothing below runs unless DMARC unambiguously passed.
  if (input.senderAuth !== "pass") return "none";

  // The binding gate. A "pass" says a domain was authenticated; it does not say
  // WHICH, and the tiers below are tied to from[0] — the one address the reader
  // is shown. Exactly one From address, and a DMARC result that names that
  // address's own domain, or no tier at all.
  if (input.fromCount !== 1) return "none";

  const domain = domainOf(input.fromEmail);
  if (domain === null) return "none";
  if (input.dmarcFromDomain === null) return "none";
  if (input.dmarcFromDomain.trim().toLowerCase() !== domain) return "none";

  if (matchesTrustedDomain(domain, input.trustedDomains)) return "trusted-service";

  const address = (input.fromEmail as string).trim().toLowerCase();
  if (input.knownRecipients.has(address)) return "known";

  return "none";
}
