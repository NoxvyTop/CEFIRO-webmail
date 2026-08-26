import { z } from "zod";

export const mailboxSchema = z.object({
  id: z.string(),
  name: z.string(),
  parentId: z.string().nullable(),
  role: z.string().nullable(),
  sortOrder: z.number(),
  unreadEmails: z.number(),
  totalEmails: z.number(),
});
export type Mailbox = z.infer<typeof mailboxSchema>;

// GH #13/#50: a shared/group mailbox the signed-in member can browse and read
// with their OWN credential — Stalwart exposes it in the member's JMAP session
// via group membership. `id` is the JMAP accountId the client passes back as
// `?accountId=` to scope the mail routes to that mailbox; `name` is its display
// name for the account selector. The member's personal mailbox is deliberately
// NOT in this list (GET /api/mail/shared-accounts returns non-personal only).
export const sharedAccountSchema = z.object({
  id: z.string(),
  name: z.string(),
  // GH #13/#50 (G-3): whether this member has opted into receiving a copy of
  // new mail from this shared mailbox in their own inbox (see
  // userPreferencesSchema.sharedMailboxCopyOptIn). Defaults to false so a
  // response from a server that predates the field — and the account selector,
  // which reads only id/name — still parses. Since GH #313 the server's copy
  // worker consumes it: new mail in the shared inbox is copied to every member
  // with this set, from the moment they opt in (never retroactively — see
  // docs/design/shared-mailboxes.md).
  copyOptIn: z.boolean().default(false),
});
export type SharedAccount = z.infer<typeof sharedAccountSchema>;

export const sharedAccountsSchema = z.array(sharedAccountSchema);
export type SharedAccounts = z.infer<typeof sharedAccountsSchema>;

// GH #13/#50 (G-3): the body of PUT /api/mail/shared-accounts/:id/copy-preference
// — the member toggling whether they want copies from that shared mailbox.
export const sharedAccountCopyPreferenceSchema = z.object({
  copyOptIn: z.boolean(),
});
export type SharedAccountCopyPreference = z.infer<typeof sharedAccountCopyPreferenceSchema>;

export const emailAddressSchema = z.object({
  name: z.string().nullable(),
  email: z.string(),
});
export type EmailAddress = z.infer<typeof emailAddressSchema>;

export const emailSummarySchema = z.object({
  id: z.string(),
  threadId: z.string(),
  mailboxIds: z.array(z.string()),
  from: z.array(emailAddressSchema),
  to: z.array(emailAddressSchema),
  subject: z.string(),
  receivedAt: z.string(),
  preview: z.string(),
  keywords: z.record(z.string(), z.boolean()),
  hasAttachment: z.boolean(),
  size: z.number(),
});
export type EmailSummary = z.infer<typeof emailSummarySchema>;

export const messagesPageSchema = z.object({
  total: z.number(),
  position: z.number(),
  emails: z.array(emailSummarySchema),
});
export type MessagesPage = z.infer<typeof messagesPageSchema>;

export const attachmentMetaSchema = z.object({
  blobId: z.string(),
  name: z.string().nullable(),
  type: z.string(),
  size: z.number(),
  // Content-ID (without angle brackets) for attachments referenced inline in
  // the body via <img src="cid:...">, e.g. embedded logos/signatures. Null
  // for regular (non-inline) attachments.
  cid: z.string().nullable(),
});
export type AttachmentMeta = z.infer<typeof attachmentMetaSchema>;

// GH #136: an explicit, three-state verdict on whether the message's sender
// passed email authentication (SPF/DKIM/DMARC) — never a raw pass/fail
// boolean, because "unknown" must be a distinct, first-class outcome a client
// can render as neutral. A missing/falsy field must never be silently read as
// authenticated: a wrong trust mark on a spoofed message is worse than no
// mark at all. The verdict is keyed off DMARC's own result rather than raw
// SPF/DKIM results, because DMARC is the only one of the three that checks
// *alignment* with the visible From domain — SPF or DKIM can legitimately
// pass for a domain that has nothing to do with the sender the user is shown,
// which is exactly how spoofing works. See
// apps/server/src/modules/mail/sender-auth.ts for how this is derived from
// the message's Authentication-Results header (RFC 8601).
export const senderAuthVerdictSchema = z.enum(["pass", "fail", "unknown"]);
export type SenderAuthVerdict = z.infer<typeof senderAuthVerdictSchema>;

// GH #314: a POSITIVE-ONLY trust level layered on top of senderAuth, never a
// replacement for it. "known" means the sender passed DMARC AND the user has
// previously written to that exact address (a correspondent); "trusted-service"
// means the sender passed DMARC AND the From domain is on the trusted-services
// list (curated seed plus the domains the user confirmed). "none" is the
// absence of an assertion — NOT a warning: DMARC fail stays the only negative
// signal (senderAuth), so a legitimate first-time sender is never painted as
// suspicious for merely being new.
//
// Kept as its own enum rather than widening senderAuthVerdictSchema: the
// GH #152 tests pin that enum to the raw DMARC verdict, and mixing "who is
// this" into "did authentication pass" would let a client render trust off a
// field that was never meant to carry it. See
// apps/server/src/modules/mail/sender-trust.ts for how it is resolved.
export const senderTrustSchema = z.enum(["none", "known", "trusted-service"]);
export type SenderTrust = z.infer<typeof senderTrustSchema>;

export const emailDetailSchema = emailSummarySchema.extend({
  cc: z.array(emailAddressSchema),
  replyTo: z.array(emailAddressSchema),
  bodyHtml: z.string().nullable(),
  bodyText: z.string().nullable(),
  attachments: z.array(attachmentMetaSchema),
  // JMAP Email properties carrying RFC 5322 threading headers: messageId is
  // this message's own Message-ID(s), references is the Message-ID(s) of its
  // ancestors, and inReplyTo is the Message-ID(s) of the message this one
  // replied to. All three are String[]|null in JMAP — null when the message
  // has no such header — and carry the parsed form, with surrounding angle
  // brackets and CFWS removed (RFC 8621 §4.1.3). Used by composer/reply.ts
  // to build In-Reply-To/References on the outgoing reply so it threads
  // correctly in the recipient's client; inReplyTo covers the RFC 5322
  // §3.6.4 clause where a parent without References contributes its own
  // In-Reply-To to the reply's References chain instead.
  //
  // All three default to null (same reasoning as userPreferences.customLabels
  // below) so a response from a server that predates these fields still
  // parses. emailDetailSchema is parsed as part of threadDetailSchema, so
  // throwing here would take down the entire thread view rather than just
  // degrading reply threading.
  messageId: z.array(z.string()).nullable().default(null),
  references: z.array(z.string()).nullable().default(null),
  inReplyTo: z.array(z.string()).nullable().default(null),
  // GH #136: see senderAuthVerdictSchema above. Defaults to "unknown" — not
  // "pass" — so a response from a server that predates this field (or a
  // hand-written test fixture) parses as "no assertion" rather than either
  // throwing or, far worse, defaulting to a false trust mark.
  senderAuth: senderAuthVerdictSchema.default("unknown"),
  // GH #314: see senderTrustSchema above. Defaults to "none" — never "known"
  // or "trusted-service" — so a response from a server that predates this
  // field (or a hand-written test fixture) parses as "no assertion" rather
  // than throwing inside threadDetailSchema or, far worse, defaulting to a
  // false trust mark.
  senderTrust: senderTrustSchema.default("none"),
  // GH #140: true when JMAP reported at least one of the fetched body values
  // as truncated (RFC 8621 §4.1.4 `isTruncated`), i.e. bodyHtml/bodyText hold
  // a PREFIX of the real body, cut at the server's maxBodyValueBytes budget.
  // Without this the cut is invisible: the reader shows a message ending
  // mid-sentence as if that were the whole thing, and composer/reply.ts quotes
  // the prefix into the next reply, making the loss permanent from there on.
  //
  // Defaults to false — "nothing was reported truncated", the absence of an
  // assertion — so a server predating the field, or an existing fixture,
  // parses as complete instead of throwing inside threadDetailSchema and
  // taking down the whole thread view. False therefore means "no truncation
  // reported", never "verified complete".
  bodyTruncated: z.boolean().default(false),
});
export type EmailDetail = z.infer<typeof emailDetailSchema>;

export const threadDetailSchema = z.object({
  id: z.string(),
  emails: z.array(emailDetailSchema),
});
export type ThreadDetail = z.infer<typeof threadDetailSchema>;

export const emailUpdateSchema = z
  .object({
    keywords: z.record(z.string(), z.boolean()).optional(),
    mailboxIds: z.record(z.string(), z.boolean()).optional(),
  })
  .refine((v) => v.keywords !== undefined || v.mailboxIds !== undefined, {
    message: "at least one of keywords or mailboxIds is required",
  });
export type EmailUpdate = z.infer<typeof emailUpdateSchema>;

// A custom label is a user-defined JMAP keyword: `slug` is the ASCII-safe
// stored/filter value (mirrors the canonical "diseno" convention in
// apps/web/src/app/ui/labels.ts — real IMAP/JMAP keyword atoms are
// ASCII-safe, no accent folding on the server), `name` is the free-form
// display text the user typed, and `color` is a hex swatch chosen from the
// app's brand-safe custom label palette.
export const customLabelSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "slug must be a lowercase ascii keyword"),
  name: z.string().trim().min(1).max(60),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "color must be a 6-digit hex value"),
});
export type CustomLabel = z.infer<typeof customLabelSchema>;

function hasUniqueSlugs(labels: CustomLabel[]): boolean {
  const slugs = labels.map((label) => label.slug.toLowerCase());
  return new Set(slugs).size === slugs.length;
}

const customLabelsListSchema = z
  .array(customLabelSchema)
  .max(50)
  .refine(hasUniqueSlugs, { message: "customLabels slugs must be unique" });

export const userPreferencesSchema = z.object({
  groupMailInMainInbox: z.boolean(),
  // Defaults to [] so responses from a server that predates this field (or
  // hand-written test fixtures) still parse instead of throwing.
  customLabels: customLabelsListSchema.default([]),
  // GH #13/#50 (G-3): the JMAP accountIds of the shared mailboxes this member
  // has opted into receiving copies from. Persisted intent ONLY — nothing reads
  // it to actually deliver a copy yet (deferred, see
  // docs/design/shared-mailboxes.md); the member still pulls copies manually.
  // Written exclusively through the authorized PUT
  // /api/mail/shared-accounts/:id/copy-preference route (which validates each id
  // against the member's session), not the generic preferences PATCH — so it is
  // deliberately absent from userPreferencesUpdateSchema below. Defaults to []
  // for the same backward-compatibility reason as customLabels.
  sharedMailboxCopyOptIn: z.array(z.string()).default([]),
  // GH #314: the domains this user confirmed as trusted services (Tier B of
  // the sender-trust indicator), on top of the curated seed list the server
  // ships. Written exclusively through PUT/DELETE
  // /api/mail/trusted-services/:domain — which validates the domain shape and
  // normalizes it — not the generic preferences PATCH, so it is deliberately
  // absent from userPreferencesUpdateSchema below, exactly like
  // sharedMailboxCopyOptIn. Defaults to [] for the same backward-compatibility
  // reason as customLabels.
  trustedServices: z.array(z.string()).default([]),
});
export type UserPreferences = z.infer<typeof userPreferencesSchema>;

export const userPreferencesUpdateSchema = z.object({
  groupMailInMainInbox: z.boolean().optional(),
  customLabels: customLabelsListSchema.optional(),
});
export type UserPreferencesUpdate = z.infer<typeof userPreferencesUpdateSchema>;

// GH #314: the body of GET /api/mail/trusted-services — the curated seed list
// (read-only, shipped with the server) and the user's own confirmed domains,
// kept apart so the client can offer "stop trusting" only for entries the user
// added: a seed entry cannot be removed per user.
export const trustedServicesSchema = z.object({
  seed: z.array(z.string()),
  user: z.array(z.string()),
});
export type TrustedServices = z.infer<typeof trustedServicesSchema>;
