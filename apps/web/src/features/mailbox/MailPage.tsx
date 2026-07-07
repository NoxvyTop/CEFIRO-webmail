import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import type { EmailSummary } from "@webmail/shared";
import { fetchMailboxes, fetchThread } from "./api";
import { deriveGroupAddresses, fetchPreferences } from "./groups";
import { mailErrorKey, mailRetry } from "./queryErrors";
import { MessageList } from "./MessageList";
import { Sidebar } from "./Sidebar";
import { useMailEvents } from "./useMailEvents";
import { ThreadView } from "../reader/ThreadView";
import { Composer } from "../composer/Composer";
import { fetchIdentities } from "../composer/api";
import { emptyDraft, replyDraft, type ComposerDraft } from "../composer/reply";
import { useAuth } from "../auth/useAuth";

export function MailPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();

  useMailEvents(true);

  const mailboxParam = searchParams.get("mailbox");
  const threadParam = searchParams.get("thread");
  const queryParam = searchParams.get("q");
  const composeParam = searchParams.get("compose");
  const groupParam = searchParams.get("group");
  const replyMatch = composeParam?.match(/^reply(-all)?:(.+)$/) ?? null;
  const replyAll = Boolean(replyMatch?.[1]);
  const replyEmailId = replyMatch?.[2];

  const mailboxesQuery = useQuery({
    queryKey: ["mail", "mailboxes"],
    queryFn: fetchMailboxes,
    retry: mailRetry,
  });

  const identitiesQuery = useQuery({
    queryKey: ["mail", "identities"],
    queryFn: fetchIdentities,
  });

  useQuery({
    queryKey: ["mail", "preferences"],
    queryFn: fetchPreferences,
  });

  const groups = useMemo(
    () => (user ? deriveGroupAddresses(identitiesQuery.data ?? [], user.email) : []),
    [identitiesQuery.data, user],
  );

  const composeThreadQuery = useQuery({
    queryKey: ["mail", "thread", threadParam ?? ""],
    queryFn: () => fetchThread(threadParam as string),
    enabled: Boolean(replyMatch) && Boolean(threadParam),
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
      next.delete("group");
      return next;
    });
  }

  function handleSelectGroup(address: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("group", address);
      next.delete("thread");
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

  function removeComposeParam() {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("compose");
      return next;
    });
  }

  function resolveComposeDraft(): ComposerDraft | null {
    if (!composeParam) return null;
    const identities = identitiesQuery.data;
    if (!identities) return null;

    if (composeParam === "new") return emptyDraft(identities);
    if (!replyMatch) return null;
    if (composeThreadQuery.isLoading) return null;

    const email = composeThreadQuery.data?.emails.find((candidate) => candidate.id === replyEmailId);
    if (!email) return emptyDraft(identities);
    return replyDraft(email, identities, replyAll);
  }

  const composeDraft = resolveComposeDraft();

  return (
    <div className="flex flex-1 overflow-hidden">
      <Sidebar
        mailboxes={mailboxes}
        selectedMailboxId={selectedMailboxId}
        onSelectMailbox={handleSelectMailbox}
        groups={groups}
        selectedGroup={groupParam}
        onSelectGroup={handleSelectGroup}
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
      {composeDraft && <Composer initial={composeDraft} onClose={removeComposeParam} />}
    </div>
  );
}
