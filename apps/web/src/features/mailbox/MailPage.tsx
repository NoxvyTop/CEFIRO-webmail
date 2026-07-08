import { useMemo, useState, type CSSProperties } from "react";
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
import {
  PANE_MAX_WIDTH,
  PANE_MIN_WIDTH,
  useResizablePane,
} from "../../app/ui/useResizablePane";

export function MailPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { width: listWidth, startDrag, handleKeyDown } = useResizablePane();

  useMailEvents(true);

  const mailboxParam = searchParams.get("mailbox");
  const threadParam = searchParams.get("thread");
  const queryParam = searchParams.get("q");
  const composeParam = searchParams.get("compose");
  const groupParam = searchParams.get("group");
  const starredParam = searchParams.get("starred") === "1";
  const labelParam = searchParams.get("label");
  const composeMatch = composeParam?.match(/^(reply|reply-all|forward):(.+)$/) ?? null;
  const composeMode = composeMatch?.[1];
  const composeEmailId = composeMatch?.[2];
  const [availableLabels, setAvailableLabels] = useState<string[]>([]);

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

  const archiveMailboxId = useMemo(
    () => mailboxes.find((mailbox) => mailbox.role === "archive")?.id ?? null,
    [mailboxes],
  );

  const selectedMailboxId = useMemo(() => {
    if (mailboxParam) return mailboxParam;
    return inboxMailboxId;
  }, [mailboxParam, inboxMailboxId]);

  const messageListMailboxId =
    starredParam ? undefined : (groupParam ? inboxMailboxId : selectedMailboxId) ?? undefined;

  const messageListTo = starredParam ? undefined : (groupParam ?? undefined);

  const isMainInboxSelected =
    !starredParam && !groupParam && selectedMailboxId !== null && selectedMailboxId === inboxMailboxId;

  const messageListExcludeTo =
    isMainInboxSelected && preferences?.groupMailInMainInbox === false && groupAddresses.length > 0
      ? groupAddresses
      : undefined;

  const messageListHasKeyword = starredParam
    ? (labelParam ? `$flagged,${labelParam}` : "$flagged")
    : (labelParam ?? undefined);

  const messageListTitle = starredParam
    ? t("mail.starredView")
    : groupParam
      ? groupParam
      : (mailboxes.find((mailbox) => mailbox.id === selectedMailboxId)?.name ?? undefined);

  // The starred view is not tied to any single mailbox, so the sidebar must not
  // highlight a mailbox row (e.g. Inbox) while it is active. `selectedMailboxId`
  // itself keeps deriving from the URL/inbox fallback for query purposes; only
  // the value handed to the Sidebar for its aria-current styling is nulled out.
  const sidebarSelectedMailboxId = starredParam ? null : selectedMailboxId;

  function handleSelectMailbox(mailboxId: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("mailbox", mailboxId);
      next.delete("thread");
      next.delete("q");
      next.delete("group");
      next.delete("starred");
      return next;
    });
  }

  function handleSelectGroup(address: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("group", address);
      next.delete("thread");
      next.delete("starred");
      return next;
    });
  }

  function handleSelectStarred() {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("starred", "1");
      next.delete("mailbox");
      next.delete("thread");
      next.delete("group");
      next.delete("label");
      return next;
    });
  }

  function handleSelectLabel(label: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (next.get("label") === label) {
        next.delete("label");
      } else {
        next.set("label", label);
      }
      next.delete("thread");
      return next;
    });
  }

  function handleClearLabel() {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("label");
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

  function handleLabels(labels: string[]) {
    setAvailableLabels((prev) => {
      const merged = Array.from(new Set([...prev, ...labels])).sort();
      if (merged.length === prev.length && merged.every((label, i) => label === prev[i])) {
        return prev;
      }
      return merged;
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
        selectedMailboxId={sidebarSelectedMailboxId}
        onSelectMailbox={handleSelectMailbox}
        starredSelected={starredParam}
        onSelectStarred={handleSelectStarred}
        groups={groups}
        selectedGroup={groupParam}
        onSelectGroup={handleSelectGroup}
        labels={availableLabels}
        selectedLabel={labelParam}
        onSelectLabel={handleSelectLabel}
        onCompose={handleCompose}
      />
      <section
        aria-label={t("mail.listRegion")}
        style={{ "--list-w": `${listWidth}px` } as CSSProperties}
        className={`${
          threadParam ? "hidden lg:flex" : "flex"
        } min-w-[280px] flex-1 flex-col overflow-y-auto overflow-x-hidden bg-panel lg:w-[var(--list-w)] lg:min-w-0 lg:flex-none`}
      >
        {mailboxesQuery.isError && (
          <p role="alert" className="p-4 text-sm text-warn">
            {t(mailErrorKey(mailboxesQuery.error))}
          </p>
        )}
        {!starredParam && groupAddresses.length > 0 && (
          <label className="flex items-center gap-2 border-b border-line p-2 text-sm text-muted">
            <input
              type="checkbox"
              checked={preferences?.groupMailInMainInbox ?? false}
              onChange={(event) => toggleGroupMailInInboxMutation.mutate(event.target.checked)}
            />
            {t("groups.showInInbox")}
          </label>
        )}
        {!mailboxesQuery.isError && (starredParam || messageListMailboxId) && (
          <MessageList
            mailboxId={messageListMailboxId}
            hasKeyword={messageListHasKeyword}
            query={queryParam}
            selectedThreadId={threadParam}
            onSelect={handleSelectMessage}
            to={messageListTo}
            excludeTo={messageListExcludeTo}
            title={messageListTitle}
            onLabels={handleLabels}
            activeLabel={labelParam ?? undefined}
            onClearLabel={handleClearLabel}
          />
        )}
      </section>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("mail.resizeList")}
        aria-valuemin={PANE_MIN_WIDTH}
        aria-valuemax={PANE_MAX_WIDTH}
        aria-valuenow={listWidth}
        tabIndex={0}
        onMouseDown={startDrag}
        onKeyDown={handleKeyDown}
        className="hidden w-1 shrink-0 cursor-col-resize bg-line transition-colors hover:bg-accent focus-visible:bg-accent lg:block"
      />
      <section
        aria-label={t("mail.readerRegion")}
        className={`${
          threadParam ? "block" : "hidden lg:block"
        } min-w-0 flex-1 overflow-y-auto overflow-x-hidden`}
      >
        {threadParam ? (
          <ThreadView threadId={threadParam} archiveMailboxId={archiveMailboxId} />
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
