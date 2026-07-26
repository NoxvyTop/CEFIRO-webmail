import { z } from "zod";

// GH #124: an address book entry. `source` distinguishes an address the user
// typed in themselves from one auto-added by the mail-listing harvest (see
// apps/server/src/modules/mail/contacts-harvest.ts) — kept in the contract so
// a future UI can show provenance without a second lookup.
export const contactSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  source: z.enum(["manual", "harvested"]),
});
export type Contact = z.infer<typeof contactSchema>;

export const contactInputSchema = z.object({
  name: z.string().trim().max(200).default(""),
  email: z.string().trim().min(3).max(320).email(),
});
export type ContactInput = z.infer<typeof contactInputSchema>;
