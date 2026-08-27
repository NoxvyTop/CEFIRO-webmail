import { z } from "zod";

// GH #124: an address book entry. `source` distinguishes an address the user
// typed in themselves from one auto-added by the mail-listing harvest (see
// apps/server/src/modules/mail/contacts-harvest.ts) — carried in the contract
// so provenance is available without a second lookup.
//
// GH #163: that provenance went unread for two releases, which let a harvested
// address present identically to a vetted one. Both surfaces now render it
// (apps/web/src/features/contacts/HarvestedBadge.tsx), and POST
// /contacts/:id/promote flips 'harvested' -> 'manual'. Treat this field as
// displayed, not merely stored: dropping it from a response is a UI change.
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
