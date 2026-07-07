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

export const userPreferencesSchema = z.object({
  groupMailInMainInbox: z.boolean(),
});
export type UserPreferences = z.infer<typeof userPreferencesSchema>;

export const userPreferencesUpdateSchema = z.object({
  groupMailInMainInbox: z.boolean().optional(),
});
export type UserPreferencesUpdate = z.infer<typeof userPreferencesUpdateSchema>;
