import {
  userPreferencesSchema,
  type Identity, type SharedAccount, type UserPreferences, type UserPreferencesUpdate,
} from "@webmail/shared";
import { MailApiError } from "./api";

// The user's group addresses = their identities whose email differs from the primary.
export function deriveGroupAddresses(identities: Identity[], primaryEmail: string): Identity[] {
  const primary = primaryEmail.toLowerCase();
  return identities.filter((i) => i.email.toLowerCase() !== primary);
}

/**
 * #340: one row in the sidebar's GRUPOS zone.
 *
 * A group can be known through two independent facts, and the sidebar used to
 * render one row for each of them under the same name: the identity the user
 * can send as (`address`, which filters the PERSONAL inbox by recipient — the
 * "Modelo A" copy view of docs/design/shared-mailboxes.md) and the shared
 * account Stalwart lists in the member's JMAP session (`accountId`, the group's
 * OWN mailbox — G-1 "acceso"). Both, one, or the other may be present.
 */
export interface GroupEntry {
  /** Stable identity of the row — the shared account id when there is one. */
  key: string;
  /** What the row is called. */
  label: string;
  /** The group's address, when an identity vouches for it (enables `?group=`). */
  address?: string;
  /** The group's own mailbox, when the member can open it (enables `?account=`). */
  accountId?: string;
  /** Unread messages in that mailbox's Inbox — absent when it is not known yet. */
  unread?: number;
}

function localPart(value: string): string {
  const at = value.indexOf("@");
  return at < 0 ? value : value.slice(0, at);
}

/**
 * Whether two names denote the same group. Stalwart names a group principal by
 * its login name, which in this deployment is the address, but may legitimately
 * be spelled without the domain — so "ventas@acme.com" and "ventas" are the same
 * team. Two bare local parts on DIFFERENT domains are deliberately NOT folded
 * together: `ventas@acme.com` and `ventas@other.com` are two groups.
 */
export function isSameGroupIdentifier(a: string, b: string): boolean {
  const left = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();
  if (left === "" || right === "") return false;
  return left === right || localPart(left) === right || left === localPart(right);
}

/**
 * #340: folds the identity-derived groups and the shared accounts into ONE row
 * per group. The shared mailboxes come first — that is the group's real mailbox
 * and the only one that can carry an unread count — followed by the groups the
 * user only knows as a send-as identity (a deployment with no shared account
 * for them, where the personal-inbox filter is all there is).
 */
export function mergeGroupEntries(
  groups: Identity[],
  sharedAccounts: SharedAccount[],
): GroupEntry[] {
  const matchedIdentities = new Set<string>();
  const entries: GroupEntry[] = sharedAccounts.map((account) => {
    const identity = groups.find((group) => isSameGroupIdentifier(group.email, account.name));
    if (identity) matchedIdentities.add(identity.email.toLowerCase());
    return {
      key: account.id,
      // The identity's address is the fuller, more recognisable spelling when
      // both are known; the account name is all there is otherwise.
      label: identity?.email ?? account.name,
      ...(identity ? { address: identity.email } : {}),
      accountId: account.id,
    };
  });

  for (const group of groups) {
    if (matchedIdentities.has(group.email.toLowerCase())) continue;
    entries.push({ key: group.email, label: group.email, address: group.email });
  }

  return entries;
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
