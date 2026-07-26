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

// inReplyTo/references are copied from an inbound message authored by an
// arbitrary remote sender (see composer/reply.ts) and are written verbatim
// into the outgoing message's headers, so they are bounded here rather than
// trusted. The limits are deliberately far above anything legitimate:
//
//   MAX_MESSAGE_ID_LENGTH — the ceiling on a single id, counted in UTF-16
//     code units, because that is the unit z.string().max() measures. It is
//     NOT an octet limit: 998 code units can encode up to roughly 3 KB of
//     UTF-8, so this does not enforce the RFC 5322 §2.1.1 998-octet line
//     limit. The number is taken from that limit only as a sane order of
//     magnitude — real ids are a few dozen characters — and the value is a
//     backstop against absurd input, not a wire-format guarantee.
//   MAX_MESSAGE_ID_COUNT — a References chain grows by one id per reply, and
//     most clients trim it well below this; 256 leaves ample headroom for
//     even a pathologically long legitimate thread.
//
// Both are exported so composer/reply.ts trims an inherited chain against the
// same numbers this schema enforces; the two must never drift apart.
export const MAX_MESSAGE_ID_LENGTH = 998;
export const MAX_MESSAGE_ID_COUNT = 256;

// Rejects only what is genuinely dangerous once written into a header: an
// empty value, and C0 control characters plus DEL — CR/LF would let a remote
// sender append arbitrary header fields to the outgoing message, and NUL
// could truncate it.
//
// Deliberately NOT a strict RFC 5322 atext check. Real-world senders emit
// technically non-conformant Message-IDs, and rejecting those would silently
// break threading for them — a worse failure than carrying a bounded,
// control-character-free value through unchanged.
export const messageIdSchema = z
  .string()
  .min(1)
  .max(MAX_MESSAGE_ID_LENGTH)
  .regex(/^[^\u0000-\u001F\u007F]+$/, "message id must not contain control characters");

const messageIdChainSchema = z.array(messageIdSchema).max(MAX_MESSAGE_ID_COUNT);

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
    inReplyTo: messageIdChainSchema.optional(),
    references: messageIdChainSchema.optional(),
  })
  .refine((v) => v.to.length + v.cc.length + v.bcc.length > 0, {
    message: "at least one recipient is required",
  });
export type SendEmailInput = z.infer<typeof sendEmailSchema>;
