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

export const emailDetailSchema = emailSummarySchema.extend({
  cc: z.array(emailAddressSchema),
  replyTo: z.array(emailAddressSchema),
  bodyHtml: z.string().nullable(),
  bodyText: z.string().nullable(),
  attachments: z.array(attachmentMetaSchema),
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
});
export type UserPreferences = z.infer<typeof userPreferencesSchema>;

export const userPreferencesUpdateSchema = z.object({
  groupMailInMainInbox: z.boolean().optional(),
  customLabels: customLabelsListSchema.optional(),
});
export type UserPreferencesUpdate = z.infer<typeof userPreferencesUpdateSchema>;
