import type { TFunction } from "i18next";
import type { EmailAddress } from "@webmail/shared";

// Display name for a recipient — same precedence as addressLabel() in
// ThreadView (a trimmed display name, falling back to the raw address).
function label(address: EmailAddress): string {
  return address.name?.trim() || address.email;
}

/**
 * Gmail-style one-line summary of who a received message was addressed to,
 * computed from the real `to`/`cc` of the message rather than a fixed string.
 *
 * `identityEmails` are the account's own identity addresses; a recipient
 * matching any of them (case-insensitively) is "me". Recipients are deduped by
 * lowercased email before counting so the same address in both `to` and `cc`
 * (or twice in one) is never double-counted.
 *
 * Kept pure and free of React/JSX so it is unit-testable in isolation.
 */
export function describeAudience(
  to: EmailAddress[],
  cc: EmailAddress[],
  identityEmails: string[],
  t: TFunction,
): string {
  const identitySet = new Set(identityEmails.map((email) => email.toLowerCase()));

  // Dedupe by lowercased email, preserving first-seen order.
  const seen = new Set<string>();
  const recipients: EmailAddress[] = [];
  for (const address of [...to, ...cc]) {
    const key = address.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    recipients.push(address);
  }

  const others = recipients.filter((address) => !identitySet.has(address.email.toLowerCase()));
  const includesMe = others.length < recipients.length;

  if (includesMe) {
    const [firstOther, ...restOthers] = others;
    if (!firstOther) return t("mail.audience.toMe");
    if (restOthers.length === 0) return t("mail.audience.toMeAndName", { name: label(firstOther) });
    return t("mail.audience.toMeAndCount", { count: others.length });
  }

  // Delivered without me on the visible recipient list (a list/BCC delivery).
  const [firstRecipient, ...restRecipients] = recipients;
  if (!firstRecipient) return t("mail.audience.toMe");
  if (restRecipients.length === 0) return t("mail.audience.toName", { name: label(firstRecipient) });
  return t("mail.audience.toNameAndCount", {
    name: label(firstRecipient),
    count: restRecipients.length,
  });
}
