import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import type { EmailSummary } from "@webmail/shared";
import { fetchMailboxes } from "./api";
import { mailErrorKey, mailRetry } from "./queryErrors";
import { MessageList } from "./MessageList";
import { Sidebar } from "./Sidebar";
import { ThreadView } from "../reader/ThreadView";

export function MailPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();

  const mailboxParam = searchParams.get("mailbox");
  const threadParam = searchParams.get("thread");
  const queryParam = searchParams.get("q");

  const mailboxesQuery = useQuery({
    queryKey: ["mail", "mailboxes"],
    queryFn: fetchMailboxes,
    retry: mailRetry,
  });

  const mailboxes = mailboxesQuery.data ?? [];

  const selectedMailboxId = useMemo(() => {
    if (mailboxParam) return mailboxParam;
    if (mailboxes.length === 0) return null;
    const inbox = mailboxes.find((mailbox) => mailbox.role === "inbox");
    return (inbox ?? mailboxes[0])?.id ?? null;
  }, [mailboxParam, mailboxes]);

  function handleSelectMailbox(mailboxId: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("mailbox", mailboxId);
      next.delete("thread");
      next.delete("q");
      return next;
    });
  }

  function handleSelectMessage(email: EmailSummary) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("thread", email.threadId);
      return next;
    });
  }

  return (
    <div className="flex flex-1 overflow-hidden">
      <Sidebar
        mailboxes={mailboxes}
        selectedMailboxId={selectedMailboxId}
        onSelectMailbox={handleSelectMailbox}
      />
      <section aria-label={t("mail.listRegion")} className="flex-1 overflow-y-auto border-r">
        {mailboxesQuery.isError && (
          <p role="alert" className="p-4 text-sm text-amber-700">
            {t(mailErrorKey(mailboxesQuery.error))}
          </p>
        )}
        {!mailboxesQuery.isError && selectedMailboxId && (
          <MessageList
            mailboxId={selectedMailboxId}
            query={queryParam}
            selectedThreadId={threadParam}
            onSelect={handleSelectMessage}
          />
        )}
      </section>
      <section aria-label={t("mail.readerRegion")} className="flex-1 overflow-y-auto">
        {threadParam ? (
          <ThreadView threadId={threadParam} />
        ) : (
          <p className="p-4 text-sm text-gray-500">{t("mail.selectMessage")}</p>
        )}
      </section>
    </div>
  );
}
