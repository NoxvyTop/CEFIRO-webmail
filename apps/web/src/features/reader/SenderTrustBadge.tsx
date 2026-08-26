import { useTranslation } from "react-i18next";
import type { SenderTrust } from "@webmail/shared";
import { BadgeCheckIcon } from "../../app/ui/icons";

interface SenderTrustBadgeProps {
  trust: SenderTrust;
  // The message's real From address — the one the server resolved the tier
  // against and the one ThreadView prints next to this mark. It is part of
  // the accessible name on purpose: a trust mark that does not say WHO is
  // trusted invites the reader to assume, and assuming is the phishing vector.
  address: string;
}

// The domain part of an address for the trusted-service label. Mirrors
// domainOf in apps/server/src/modules/mail/sender-trust.ts (last "@", lower
// case) so the label names the same domain the server matched.
function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return (at >= 0 ? address.slice(at + 1) : address).toLowerCase();
}

// GH #314: the positive-only trust tier that sits next to SenderAuthBadge.
// Driven by the server-derived `trust` (see
// apps/server/src/modules/mail/sender-trust.ts for how "known" and
// "trusted-service" are decided — always on top of a DMARC pass) and by the
// address the server returned; there is no display-name or body prop, so a
// sender's own text can never reach the icon or its label. "none" renders
// nothing: it is the absence of an assertion, never a warning — DMARC fail on
// SenderAuthBadge stays the only negative mark, and a first-time sender must
// not look suspicious for merely being new.
//
// Deliberately a separate component from SenderAuthBadge rather than a new
// verdict on it: that component's one-prop surface is pinned by a type-level
// test (GH #136) and its enum is the raw DMARC verdict (GH #152). Mixing "who
// is this" into "did authentication pass" would let one field carry both and a
// client render trust off a verdict that never meant it.
export function SenderTrustBadge({ trust, address }: SenderTrustBadgeProps) {
  const { t } = useTranslation();

  if (trust === "none") return null;

  const label =
    trust === "known"
      ? t("mail.senderTrust.knownLabel", { address })
      : t("mail.senderTrust.trustedServiceLabel", { domain: domainOf(address) });

  return (
    <span role="img" aria-label={label} title={label} className="shrink-0 text-accent">
      <BadgeCheckIcon size={14} />
    </span>
  );
}
