import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import type { EmailSummary } from "@webmail/shared";
import { fetchMailboxes, fetchThread } from "./api";
import { deriveGroupAddresses, fetchPreferences, updatePreferences } from "./groups";
import { mailErrorKey, mailRetry } from "./queryErrors";
import { MessageList } from "./MessageList";
import { Sidebar } from "./Sidebar";
import { useMailEvents } from "./useMailEvents";
import { ThreadView } from "../reader/ThreadView";
import { CefiroLogo } from "../../app/ui/CefiroLogo";
import { Composer } from "../composer/Composer";
import { fetchIdentities } from "../composer/api";
import { emptyDraft, forwardDraft, replyDraft, type ComposerDraft } from "../composer/reply";
import { useAuth } from "../auth/useAuth";

export function MailPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  useMailEvents(true);

  const mailboxParam = searchParams.get("mailbox");
  const threadParam = searchParams.get("thread");
  const queryParam = searchParams.get("q");
  const composeParam = searchParams.get("compose");
  const groupParam = searchParams.get("group");
  const composeMatch = composeParam?.match(/^(reply|reply-all|forward):(.+)$/) ?? null;
  const composeMode = composeMatch?.[1];
  const composeEmailId = composeMatch?.[2];

  const mailboxesQuery = useQuery({
    queryKey: ["mail", "mailboxes"],
    queryFn: fetchMailboxes,
    retry: mailRetry,
  });

  const identitiesQuery = useQuery({
    queryKey: ["mail", "identities"],
    queryFn: fetchIdentities,
  });

  const preferencesQuery = useQuery({
    queryKey: ["mail", "preferences"],
    queryFn: fetchPreferences,
  });
  const preferences = preferencesQuery.data;

  const toggleGroupMailInInboxMutation = useMutation({
    mutationFn: (next: boolean) => updatePreferences({ groupMailInMainInbox: next }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mail", "preferences"] });
      queryClient.invalidateQueries({ queryKey: ["mail", "messages"] });
    },
  });

  const groups = useMemo(
    () => (user ? deriveGroupAddresses(identitiesQuery.data ?? [], user.email) : []),
    [identitiesQuery.data, user],
  );

  const groupAddresses = useMemo(() => groups.map((group) => group.email), [groups]);

  const composeThreadQuery = useQuery({
    queryKey: ["mail", "thread", threadParam ?? ""],
    queryFn: () => fetchThread(threadParam as string),
    enabled: Boolean(composeMatch) && Boolean(threadParam),
  });

  const mailboxes = mailboxesQuery.data ?? [];

  const inboxMailboxId = useMemo(() => {
    if (mailboxes.length === 0) return null;
    const inbox = mailboxes.find((mailbox) => mailbox.role === "inbox");
    return (inbox ?? mailboxes[0])?.id ?? null;
  }, [mailboxes]);

  const selectedMailboxId = useMemo(() => {
    if (mailboxParam) return mailboxParam;
    return inboxMailboxId;
  }, [mailboxParam, inboxMailboxId]);

  const messageListMailboxId = groupParam ? inboxMailboxId : selectedMailboxId;

  const messageListTo = groupParam ?? undefined;

  const isMainInboxSelected = !groupParam && selectedMailboxId !== null && selectedMailboxId === inboxMailboxId;

  const messageListExcludeTo =
    isMainInboxSelected && preferences?.groupMailInMainInbox === false && groupAddresses.length > 0
      ? groupAddresses
      : undefined;

  const messageListTitle = groupParam
    ? groupParam
    : (mailboxes.find((mailbox) => mailbox.id === selectedMailboxId)?.name ?? undefined);

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

  function handleCompose() {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("compose", "new");
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
    if (!composeMatch) return null;
    if (composeThreadQuery.isLoading) return null;

    const email = composeThreadQuery.data?.emails.find(
      (candidate) => candidate.id === composeEmailId,
    );
    if (!email) return emptyDraft(identities);
    if (composeMode === "forward") return forwardDraft(email, identities);
    return replyDraft(email, identities, composeMode === "reply-all");
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
        onCompose={handleCompose}
      />
      <section
        aria-label={t("mail.listRegion")}
        className="flex min-w-[280px] flex-[0_1_390px] flex-col overflow-y-auto border-r border-line bg-panel"
      >
        {mailboxesQuery.isError && (
          <p role="alert" className="p-4 text-sm text-warn">
            {t(mailErrorKey(mailboxesQuery.error))}
          </p>
        )}
        {groupAddresses.length > 0 && (
          <label className="flex items-center gap-2 border-b border-line p-2 text-sm text-muted">
            <input
              type="checkbox"
              checked={preferences?.groupMailInMainInbox ?? false}
              onChange={(event) => toggleGroupMailInInboxMutation.mutate(event.target.checked)}
            />
            {t("groups.showInInbox")}
          </label>
        )}
        {!mailboxesQuery.isError && messageListMailboxId && (
          <MessageList
            mailboxId={messageListMailboxId}
            query={queryParam}
            selectedThreadId={threadParam}
            onSelect={handleSelectMessage}
            to={messageListTo}
            excludeTo={messageListExcludeTo}
            title={messageListTitle}
          />
        )}
      </section>
      <section aria-label={t("mail.readerRegion")} className="flex-1 overflow-y-auto">
        {threadParam ? (
          <ThreadView threadId={threadParam} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-muted">
            <CefiroLogo size={52} />
            <p className="text-sm">{t("mail.selectMessage")}</p>
          </div>
        )}
      </section>
      {composeDraft && <Composer initial={composeDraft} onClose={removeComposeParam} />}
    </div>
  );
}
