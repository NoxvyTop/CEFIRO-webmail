import type { Mailbox } from "@webmail/shared";
import type { TFunction } from "i18next";

// docs/design/cefiro/README.md — Columna 1 nav order: Recibidos, Destacados
// (a filtered view, not a mailbox), Enviados, Archivados; secondary folders
// (Papelera, Spam, Borradores) are grouped after.
const PRIMARY_ROLES = ["inbox", "sent", "archive"] as const;
const SECONDARY_ROLES = ["trash", "junk", "drafts"] as const;

const FOLDER_NAME_KEYS: Record<string, string> = {
  inbox: "mail.folders.inbox",
  sent: "mail.folders.sent",
  archive: "mail.folders.archive",
  trash: "mail.folders.trash",
  junk: "mail.folders.junk",
  drafts: "mail.folders.drafts",
};

/** Localized folder name for a standard JMAP role; falls back to the raw server name for roleless folders. */
export function folderName(mailbox: Mailbox, t: TFunction): string {
  const key = mailbox.role ? FOLDER_NAME_KEYS[mailbox.role] : undefined;
  return key ? t(key) : mailbox.name;
}

/**
 * Orders mailboxes by fixed role instead of server sortOrder: primary roles
 * (inbox, sent, archive) first, then secondary roles (trash, junk, drafts),
 * then any remaining folders. Only one mailbox can occupy a given role's
 * fixed nav slot (the last one wins, matching Map.set's overwrite
 * semantics), but a server sending two mailboxes with the same role is an
 * edge case, not a reason to drop one — the non-chosen duplicate still
 * appears in `rest` under its own server name, alongside roleless and
 * unknown-role folders.
 */
export function orderedMailboxes(mailboxes: Mailbox[]): Mailbox[] {
  const byRole = new Map<string, Mailbox>();
  for (const mailbox of mailboxes) {
    if (mailbox.role) byRole.set(mailbox.role, mailbox);
  }
  const primary = PRIMARY_ROLES.map((role) => byRole.get(role)).filter((m): m is Mailbox => Boolean(m));
  const secondary = SECONDARY_ROLES.map((role) => byRole.get(role)).filter((m): m is Mailbox => Boolean(m));
  const chosenIds = new Set([...primary, ...secondary].map((mailbox) => mailbox.id));
  const rest = mailboxes.filter((mailbox) => !chosenIds.has(mailbox.id));
  return [...primary, ...secondary, ...rest];
}
