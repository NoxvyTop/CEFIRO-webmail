import type { ComponentType } from "react";
import type { Identity, Mailbox } from "@webmail/shared";
import { useTranslation } from "react-i18next";
import { ArchiveIcon, InboxIcon, SendIcon, StarIcon } from "../../app/ui/icons";
import { folderName, orderedMailboxes } from "../../app/ui/folders";
import { labelColor, mergeLabels } from "../../app/ui/labels";

// Spec (docs/design/cefiro/README.md, Webmail Céfiro.dc.html:79-95): only the
// four primary rows carry an icon. Secondary folders (trash/junk/drafts)
// aren't in the hi-fi and stay text-only.
const FOLDER_ICONS: Partial<Record<string, ComponentType<{ size?: number }>>> = {
  inbox: InboxIcon,
  sent: SendIcon,
  archive: ArchiveIcon,
};

interface SidebarProps {
  mailboxes: Mailbox[];
  selectedMailboxId: string | null;
  onSelectMailbox: (mailboxId: string) => void;
  starredSelected: boolean;
  onSelectStarred: () => void;
  groups: Identity[];
  selectedGroup: string | null;
  onSelectGroup: (address: string) => void;
  labels: string[];
  selectedLabel: string | null;
  onSelectLabel: (label: string) => void;
  onCompose: () => void;
}

export function Sidebar({
  mailboxes, selectedMailboxId, onSelectMailbox, starredSelected, onSelectStarred,
  groups, selectedGroup, onSelectGroup, labels, selectedLabel, onSelectLabel, onCompose,
}: SidebarProps) {
  const { t } = useTranslation();
  const displayLabels = mergeLabels(labels);

  // Fixed nav order (docs/design/cefiro/README.md): Recibidos, Destacados,
  // Enviados, Archivados, then secondary folders grouped after. Destacados is
  // a filtered view rather than a mailbox, so it is spliced in right after
  // the inbox row instead of coming from `mailboxes`.
  const ordered = orderedMailboxes(mailboxes);
  const inboxIndex = ordered.findIndex((mailbox) => mailbox.role === "inbox");
  const beforeStarred = inboxIndex === -1 ? [] : ordered.slice(0, inboxIndex + 1);
  const afterStarred = inboxIndex === -1 ? ordered : ordered.slice(inboxIndex + 1);

  function renderMailboxRow(mailbox: Mailbox) {
    const selected = mailbox.id === selectedMailboxId;
    // Spec: the accent unread counter is only ever shown on Recibidos.
    const showUnreadBadge = mailbox.role === "inbox" && mailbox.unreadEmails > 0;
    const Icon = mailbox.role ? FOLDER_ICONS[mailbox.role] : undefined;
    return (
      <li key={mailbox.id}>
        <button
          type="button"
          aria-current={selected ? "true" : undefined}
          onClick={() => onSelectMailbox(mailbox.id)}
          className="flex h-[38px] w-full items-center gap-[11px] rounded-[9px] px-3 text-left text-sm hover:bg-hover aria-[current=true]:bg-sel aria-[current=true]:font-[650]"
        >
          {Icon && <Icon size={17} />}
          <span className="flex-1">{folderName(mailbox, t)}</span>
          {showUnreadBadge && (
            <span
              aria-label={t("mail.unread", { count: mailbox.unreadEmails })}
              className="text-xs font-bold text-accent"
            >
              {mailbox.unreadEmails}
            </span>
          )}
        </button>
      </li>
    );
  }

  return (
    <aside className="flex w-[230px] shrink-0 overflow-y-auto flex-col gap-4 border-r border-line p-3">
      <button
        type="button"
        onClick={onCompose}
        className="flex h-11 items-center justify-center gap-2 rounded-[11px] bg-accent font-bold text-accent-ink shadow-cta transition hover:brightness-[1.07] active:scale-[0.98]"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
        {t("composer.title")}
      </button>
      <ul className="flex flex-col gap-1">
        {beforeStarred.map(renderMailboxRow)}
        <li>
          <button
            type="button"
            aria-current={starredSelected ? "true" : undefined}
            onClick={onSelectStarred}
            className="flex h-[38px] w-full items-center gap-[11px] rounded-[9px] px-3 text-left text-sm hover:bg-hover aria-[current=true]:bg-sel aria-[current=true]:font-[650]"
          >
            <StarIcon size={17} />
            <span>{t("mail.starredView")}</span>
          </button>
        </li>
        {afterStarred.map(renderMailboxRow)}
      </ul>
      {/* CLARO-08/OSCURO-07: always render the ETIQUETAS rail — the 4 canonical
          spec labels scaffold the taxonomy even on a fresh mailbox with no
          keywords yet, with any real labels merged in after them. */}
      <nav aria-label={t("mail.labels")} className="text-sm">
        <p aria-hidden="true" className="mb-1 px-3 text-[11px] font-bold uppercase tracking-[0.12em] text-muted">
          {t("mail.labels")}
        </p>
        <ul className="flex flex-col gap-1">
          {displayLabels.map((label) => {
            const selected = label === selectedLabel;
            return (
              <li key={label}>
                <button
                  type="button"
                  aria-current={selected ? "true" : undefined}
                  onClick={() => onSelectLabel(label)}
                  className="flex h-[34px] w-full items-center gap-[11px] truncate rounded-[9px] px-3 text-left text-[13.5px] hover:bg-hover aria-[current=true]:bg-sel aria-[current=true]:font-[650]"
                >
                  <span
                    aria-hidden="true"
                    className="h-[9px] w-[9px] shrink-0 rounded-[3px]"
                    style={{ background: labelColor(label) }}
                  />
                  {/* text-transform only — the underlying label value (used for
                      filtering/dedup/color lookup) keeps its original casing. */}
                  <span className="truncate capitalize">{label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      {groups.length > 0 && (
        <nav aria-label={t("groups.title")} className="text-sm">
          <p aria-hidden="true" className="mb-1 px-3 text-[11px] font-bold uppercase tracking-[0.12em] text-muted">
            {t("groups.title")}
          </p>
          <ul className="flex flex-col gap-1">
            {groups.map((group) => {
              const selected = group.email === selectedGroup;
              return (
                <li key={group.id}>
                  <button
                    type="button"
                    aria-current={selected ? "true" : undefined}
                    onClick={() => onSelectGroup(group.email)}
                    className="flex h-[34px] w-full items-center justify-between truncate rounded-[9px] px-3 text-left text-sm hover:bg-hover aria-[current=true]:bg-sel aria-[current=true]:font-[650]"
                  >
                    <span className="truncate">{group.email}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      )}
      <nav aria-label={t("modules.title")} className="mt-auto border-t border-line pt-2 text-sm text-muted">
        <span aria-current="true">{t("modules.mail")}</span>
      </nav>
    </aside>
  );
}
