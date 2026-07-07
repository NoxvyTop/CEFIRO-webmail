import type { Identity, Mailbox } from "@webmail/shared";
import { useTranslation } from "react-i18next";

interface SidebarProps {
  mailboxes: Mailbox[];
  selectedMailboxId: string | null;
  onSelectMailbox: (mailboxId: string) => void;
  groups: Identity[];
  selectedGroup: string | null;
  onSelectGroup: (address: string) => void;
  onCompose: () => void;
}

export function Sidebar({
  mailboxes, selectedMailboxId, onSelectMailbox, groups, selectedGroup, onSelectGroup, onCompose,
}: SidebarProps) {
  const { t } = useTranslation();

  return (
    <aside className="flex w-[230px] shrink-0 overflow-y-auto flex-col gap-4 border-r border-line p-3">
      <button
        type="button"
        onClick={onCompose}
        className="flex h-11 items-center justify-center gap-2 rounded-[11px] bg-accent font-semibold text-accent-ink shadow-[0_2px_14px_rgba(111,227,193,0.25)] transition hover:brightness-[1.07] active:scale-[0.98]"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
        {t("composer.title")}
      </button>
      <ul className="flex flex-col gap-1">
        {mailboxes.map((mailbox) => {
          const selected = mailbox.id === selectedMailboxId;
          return (
            <li key={mailbox.id}>
              <button
                type="button"
                aria-current={selected ? "true" : undefined}
                onClick={() => onSelectMailbox(mailbox.id)}
                className="flex h-[38px] w-full items-center justify-between rounded-[9px] px-3 text-left text-sm hover:bg-hover aria-[current=true]:bg-sel aria-[current=true]:font-semibold"
              >
                <span>{mailbox.name}</span>
                {mailbox.unreadEmails > 0 && (
                  <span
                    aria-label={t("mail.unread", { count: mailbox.unreadEmails })}
                    className="text-xs font-semibold text-accent"
                  >
                    {mailbox.unreadEmails}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
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
                    className="flex h-[34px] w-full items-center justify-between truncate rounded-[9px] px-3 text-left text-sm hover:bg-hover aria-[current=true]:bg-sel aria-[current=true]:font-semibold"
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
