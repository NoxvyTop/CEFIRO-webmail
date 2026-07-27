import { contactInputSchema, contactSchema, type Contact, type ContactInput } from "@webmail/shared";
import { z } from "zod";
import { MailApiError } from "../mailbox/api";

// GH #124: address book — read by the composer's recipient autocomplete
// (RecipientField.tsx) and by the Contacts section in Settings
// (ContactsSettings.tsx). Mirrors composer/api.ts's shape and its
// MailApiError envelope handling.

async function parseError(res: Response): Promise<never> {
  let code = "internal";
  try {
    code = ((await res.json()) as { code?: string }).code ?? "internal";
  } catch {
    // non-json error body — keep default code
  }
  throw new MailApiError(res.status, code);
}

export async function fetchContacts(): Promise<Contact[]> {
  const res = await fetch("/api/mail/contacts");
  if (!res.ok) return parseError(res);
  return z.array(contactSchema).parse(await res.json());
}

// The server (apps/server/src/modules/contacts/router.ts) treats a query
// shorter than its own minimum as "nothing to suggest" and returns [] rather
// than 400 — callers should still avoid firing this below that same minimum
// (see RecipientField.tsx's MIN_QUERY_LENGTH) so an autocomplete field
// doesn't fire a request on every keystroke for nothing.
export async function searchContacts(query: string): Promise<Contact[]> {
  const res = await fetch(`/api/mail/contacts/search?q=${encodeURIComponent(query)}`);
  if (!res.ok) return parseError(res);
  return z.array(contactSchema).parse(await res.json());
}

export async function createContact(input: ContactInput): Promise<Contact> {
  const res = await fetch("/api/mail/contacts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(contactInputSchema.parse(input)),
  });
  if (!res.ok) return parseError(res);
  return contactSchema.parse(await res.json());
}

// GH #163: adopts a harvested contact as one of the user's own, clearing the
// "auto-added" mark. No body — the id in the path is the whole request (see
// apps/server/src/modules/contacts/router.ts). Returns the updated contact so
// a caller can reflect the new source without refetching; ContactsSettings
// invalidates the list anyway, since promotion also reorders nothing but must
// stay consistent with any other tab's view.
export async function promoteContact(id: string): Promise<Contact> {
  const res = await fetch(`/api/mail/contacts/${encodeURIComponent(id)}/promote`, {
    method: "POST",
  });
  if (!res.ok) return parseError(res);
  return contactSchema.parse(await res.json());
}

// GH #124: the server tombstones the deleted address (contact_suppressions)
// so a later mail-listing harvest never silently re-adds it — from this
// client's point of view the deletion is simply irreversible.
export async function deleteContact(id: string): Promise<void> {
  const res = await fetch(`/api/mail/contacts/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) return parseError(res);
}
