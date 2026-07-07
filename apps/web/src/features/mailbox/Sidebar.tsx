import type { Identity, Mailbox } from "@webmail/shared";
import { useTranslation } from "react-i18next";

interface SidebarProps {
  mailboxes: Mailbox[];
  selectedMailboxId: string | null;
  onSelectMailbox: (mailboxId: string) => void;
  groups: Identity[];
  selectedGroup: string | null;
  onSelectGroup: (address: string) => void;
}

export function Sidebar({
  mailboxes, selectedMailboxId, onSelectMailbox, groups, selectedGroup, onSelectGroup,
}: SidebarProps) {
  const { t } = useTranslation();

  return (
    <aside className="flex w-56 shrink-0 flex-col gap-4 border-r p-2">
      <ul className="flex flex-col gap-1">
        {mailboxes.map((mailbox) => {
          const selected = mailbox.id === selectedMailboxId;
          return (
            <li key={mailbox.id}>
              <button
                type="button"
                aria-current={selected ? "true" : undefined}
                onClick={() => onSelectMailbox(mailbox.id)}
                className="flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-sm aria-[current=true]:bg-gray-100"
              >
                <span>{mailbox.name}</span>
                {mailbox.unreadEmails > 0 && (
                  <span
                    aria-label={t("mail.unread", { count: mailbox.unreadEmails })}
                    className="rounded-full bg-gray-200 px-2 text-xs"
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
          <ul className="flex flex-col gap-1">
            {groups.map((group) => {
              const selected = group.email === selectedGroup;
              return (
                <li key={group.id}>
                  <button
                    type="button"
                    aria-current={selected ? "true" : undefined}
                    onClick={() => onSelectGroup(group.email)}
                    className="flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-sm aria-[current=true]:bg-gray-100"
                  >
                    <span>{group.email}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      )}
      <nav aria-label={t("modules.title")} className="mt-auto border-t pt-2 text-sm">
        <span aria-current="true">{t("modules.mail")}</span>
      </nav>
    </aside>
  );
}
