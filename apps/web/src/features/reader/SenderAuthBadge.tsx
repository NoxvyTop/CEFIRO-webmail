import { useTranslation } from "react-i18next";
import type { SenderAuthVerdict } from "@webmail/shared";
import { ShieldAlertIcon, ShieldCheckIcon } from "../../app/ui/icons";

interface SenderAuthBadgeProps {
  verdict: SenderAuthVerdict;
}

// GH #136: the reader's sender-authenticity indicator, driven entirely by
// the server-derived verdict (see apps/server/src/modules/mail/sender-auth.ts
// for how "pass"/"fail"/"unknown" is decided from the message's
// Authentication-Results header). This component takes no other input — no
// sender name, no message body — so there is no way for anything a sender
// controls to influence the mark. A display name containing a checkmark
// character (e.g. "✓ Trusted Sender <attacker@evil.test>") just renders as
// plain text wherever addressLabel() shows the sender; it can never reach
// this badge's icon or its aria-label.
//
// "unknown" renders nothing: a wrong indicator is worse than no indicator, so
// every ambiguous case resolves toward not asserting trust (see the module
// header of sender-auth.ts). Only an unambiguous DMARC pass renders the
// positive mark; only an unambiguous DMARC fail renders the warning — both
// carry an accessible name stating the actual meaning, not just a color or
// icon name, so the distinction survives for screen reader users too.
export function SenderAuthBadge({ verdict }: SenderAuthBadgeProps) {
  const { t } = useTranslation();

  if (verdict === "unknown") return null;

  const label = t(verdict === "pass" ? "mail.senderAuth.passLabel" : "mail.senderAuth.failLabel");

  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={verdict === "pass" ? "shrink-0 text-accent" : "shrink-0 text-warn"}
    >
      {verdict === "pass" ? <ShieldCheckIcon size={14} /> : <ShieldAlertIcon size={14} />}
    </span>
  );
}
