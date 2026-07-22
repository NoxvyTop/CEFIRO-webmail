import {
  userPreferencesSchema, type Identity, type UserPreferences, type UserPreferencesUpdate,
} from "@webmail/shared";
import { MailApiError } from "./api";

// The user's group addresses = their identities whose email differs from the primary.
export function deriveGroupAddresses(identities: Identity[], primaryEmail: string): Identity[] {
  const primary = primaryEmail.toLowerCase();
  return identities.filter((i) => i.email.toLowerCase() !== primary);
}

export async function fetchPreferences(): Promise<UserPreferences> {
  const res = await fetch("/api/mail/preferences");
  if (!res.ok) throw new MailApiError(res.status, "internal");
  return userPreferencesSchema.parse(await res.json());
}

export async function updatePreferences(patch: UserPreferencesUpdate): Promise<UserPreferences> {
  const res = await fetch("/api/mail/preferences", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new MailApiError(res.status, "internal");
  return userPreferencesSchema.parse(await res.json());
}
