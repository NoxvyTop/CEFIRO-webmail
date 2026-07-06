import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { fetchMailboxes, MailApiError } from "./api";
import { Sidebar } from "./Sidebar";

const NON_RETRYABLE_CODES = new Set(["mail_not_configured", "mail_credentials_missing"]);

export function MailPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();

  const mailboxParam = searchParams.get("mailbox");

  const mailboxesQuery = useQuery({
    queryKey: ["mail", "mailboxes"],
    queryFn: fetchMailboxes,
    retry: (failureCount, error) => {
      if (error instanceof MailApiError && NON_RETRYABLE_CODES.has(error.code)) return false;
      return failureCount < 3;
    },
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

  const errorCode = mailboxesQuery.error instanceof MailApiError
    ? mailboxesQuery.error.code
    : null;

  return (
    <div className="flex flex-1 overflow-hidden">
      <Sidebar
        mailboxes={mailboxes}
        selectedMailboxId={selectedMailboxId}
        onSelectMailbox={handleSelectMailbox}
      />
      <section aria-label={t("mail.listRegion")} className="flex-1 overflow-y-auto border-r">
        {errorCode === "mail_not_configured" && (
          <p role="alert" className="p-4 text-sm text-amber-700">
            {t("mail.errors.mailNotConfigured")}
          </p>
        )}
        {errorCode === "mail_credentials_missing" && (
          <p role="alert" className="p-4 text-sm text-amber-700">
            {t("mail.errors.mailCredentialsMissing")}
          </p>
        )}
      </section>
      <section aria-label={t("mail.readerRegion")} className="flex-1 overflow-y-auto" />
    </div>
  );
}
