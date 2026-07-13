import { z } from "zod";
import { emailAddressSchema } from "./mail";

export const identitySchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
});
export type Identity = z.infer<typeof identitySchema>;

export const signatureSchema = z.object({
  id: z.string(),
  name: z.string(),
  contentHtml: z.string(),
  isDefault: z.boolean(),
});
export type Signature = z.infer<typeof signatureSchema>;

export const signatureInputSchema = z.object({
  name: z.string().min(1),
  contentHtml: z.string(),
  isDefault: z.boolean().default(false),
});
export type SignatureInput = z.infer<typeof signatureInputSchema>;

export const blobUploadResultSchema = z.object({
  blobId: z.string(),
  type: z.string(),
  size: z.number(),
});
export type BlobUploadResult = z.infer<typeof blobUploadResultSchema>;

export const sendAttachmentSchema = z.object({
  blobId: z.string(),
  name: z.string().min(1),
  type: z.string().min(1),
});

export const sendEmailSchema = z
  .object({
    identityId: z.string().min(1),
    to: z.array(emailAddressSchema).default([]),
    cc: z.array(emailAddressSchema).default([]),
    bcc: z.array(emailAddressSchema).default([]),
    subject: z.string().default(""),
    textBody: z.string(),
    htmlBody: z.string().optional(),
    attachments: z.array(sendAttachmentSchema).default([]),
    inReplyTo: z.array(z.string()).optional(),
    references: z.array(z.string()).optional(),
  })
  .refine((v) => v.to.length + v.cc.length + v.bcc.length > 0, {
    message: "at least one recipient is required",
  });
export type SendEmailInput = z.infer<typeof sendEmailSchema>;
