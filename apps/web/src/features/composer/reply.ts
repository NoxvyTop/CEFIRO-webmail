import type { EmailAddress, EmailDetail, Identity } from "@webmail/shared";
import { sanitizeEmailHtml } from "../reader/sanitize";

export type DraftAttachment = { blobId: string; name: string; type: string; size: number };

export type ComposerDraft = {
  identityId: string;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  subject: string;
  bodyHtml: string;
  // JMAP threading (inReplyTo/references) is keyed by Message-ID headers,
  // which the current EmailDetail contract does not expose. Threading for
  // replies is handled server-side via the JMAP threadId instead. These
  // fields are kept for a future plan that surfaces Message-IDs.
  inReplyTo?: string[];
  references?: string[];
  // present only on forward drafts: original attachments reattached by blobId
  attachments?: DraftAttachment[];
};

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function dedupeAddresses(addresses: EmailAddress[]): EmailAddress[] {
  const seen = new Set<string>();
  const result: EmailAddress[] = [];
  for (const address of addresses) {
    const key = normalizeEmail(address.email);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(address);
  }
  return result;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function pickIdentity(email: EmailDetail, identities: Identity[]): Identity | undefined {
  const recipientEmails = new Set(
    [...email.to, ...email.cc].map((address) => normalizeEmail(address.email)),
  );
  return (
    identities.find((identity) => recipientEmails.has(normalizeEmail(identity.email))) ??
    identities[0]
  );
}

function deriveSubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`;
}

function deriveForwardSubject(subject: string): string {
  return /^fwd:/i.test(subject.trim()) ? subject : `Fwd: ${subject}`;
}

function quotedBody(email: EmailDetail): string {
  const rawHtml = email.bodyHtml ?? escapeHtml(email.bodyText ?? "");
  const sanitized = sanitizeEmailHtml(rawHtml, { allowRemoteImages: false });
  const sender = email.from[0];
  const senderLabel = sender ? sender.name || sender.email : "";
  const attribution = `<p>${escapeHtml(email.receivedAt)} — ${escapeHtml(senderLabel)}:</p>`;
  return `<br><br>${attribution}<blockquote>${sanitized.html}</blockquote>`;
}

export function emptyDraft(identities: Identity[]): ComposerDraft {
  return {
    identityId: identities[0]?.id ?? "",
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    bodyHtml: "",
  };
}

export function replyDraft(email: EmailDetail, identities: Identity[], all: boolean): ComposerDraft {
  const to = dedupeAddresses(email.replyTo.length ? email.replyTo : email.from);
  const identity = pickIdentity(email, identities);
  const identityId = identity?.id ?? identities[0]?.id ?? "";

  let cc: EmailAddress[] = [];
  if (all) {
    const toKeys = new Set(to.map((address) => normalizeEmail(address.email)));
    const ownEmail = identity ? normalizeEmail(identity.email) : undefined;
    cc = dedupeAddresses([...email.to, ...email.cc]).filter((address) => {
      const key = normalizeEmail(address.email);
      if (ownEmail && key === ownEmail) return false;
      if (toKeys.has(key)) return false;
      return true;
    });
  }

  return {
    identityId,
    to,
    cc,
    bcc: [],
    subject: deriveSubject(email.subject),
    bodyHtml: quotedBody(email),
  };
}

export function forwardDraft(email: EmailDetail, identities: Identity[]): ComposerDraft {
  const identity = pickIdentity(email, identities);
  return {
    identityId: identity?.id ?? identities[0]?.id ?? "",
    to: [],
    cc: [],
    bcc: [],
    subject: deriveForwardSubject(email.subject),
    bodyHtml: quotedBody(email),
    attachments: email.attachments.map((attachment) => ({
      blobId: attachment.blobId,
      name: attachment.name?.trim() || "attachment",
      type: attachment.type,
      size: attachment.size,
    })),
  };
}
